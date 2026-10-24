// Which upstream GBrain operations agents may call, with their CRUD class and effect.
// Source: the pinned operation surface (generated from upstream's registry at the tag) intersected
// with the live `tools/list` of the running service. An op must be in both; anything else fails closed.
import type { CrudAction, DynamicCatalogEntry, Effect, HoldFamily } from "@opt2-tealbrick/spec/manifest";
import surfaceData from "./surface-0.60.424.0.json" with { type: "json" };

interface UpstreamOperation {
  name: string;
  scope: string;
  mutating: boolean;
  localOnly: boolean;
  cliOnly: boolean;
  publishGateKey: string | null;
  params: string[];
}

interface Surface {
  provenance: { tag: string; commit: string };
  operations: UpstreamOperation[];
}

export interface ExposedOperation {
  name: string;
  crud: CrudAction[];
  effect: Effect;
  holdFamily?: HoldFamily;
  /** stateless read that may fan out across the caller's readable areas */
  fanOut: boolean;
  /** spends model budget: runs only in an area the caller may write */
  modelCost: boolean;
  long: boolean;
}

/** Dynamic catalog entry name prefix, so engine tools never collide with Knowledge's own operations. */
export const ENTRY_PREFIX = "gb_";

const C: CrudAction = "create";
const U: CrudAction = "update";
const D: CrudAction = "delete";

/** CRUD class of every upstream write agents may run (unknown writes fail the build of the exposure). */
const WRITE_CRUD: Readonly<Record<string, CrudAction[]>> = {
  remember: [C, U], forget: [D], put_page: [C, U], delete_page: [D], restore_page: [U], capture: [C], edit_page: [U],
  cancel_write_request: [U], add_tag: [U], remove_tag: [U, D], add_link: [C], remove_link: [D], add_timeline_entry: [C],
  revert_version: [U, D], put_raw_data: [C, U], log_ingest: [C], takes_add: [C], takes_update: [U], takes_resolve: [U],
  takes_supersede: [C, U], ontology_propose: [C], extract_entities: [C, U], extract_facts: [C, U], forget_fact: [D],
  mute_notice: [U],
  // 0.60.424.0 (C336 M2): batch and multipart page writes, memory confirmation
  append_page: [C, U], put_pages: [C, U], begin_page_upload: [C], upload_page_part: [U], commit_page_upload: [C, U],
  abort_page_upload: [U], confirm_memory: [U],
};

/** Upstream ops callable by a read+write client that Knowledge does not delegate, with the reason. */
export const POLICY_EXCLUSIONS: Readonly<Record<string, string>> = {
  sources_list: "enumerates every engine source, i.e. other areas",
  sources_status: "reports on arbitrary engine sources (other areas)",
  whoami: "describes Knowledge's internal engine client, not the agent",
  request_tools: "session tool-loading meta-op that persists a wider surface on the engine client",
  join_brain: "brain-wide shared skill registry, not area memory",
  sync_brain_skills: "brain-wide shared skill registry, not area memory",
  leave_brain: "brain-wide shared skill registry, not area memory",
  put_skill: "writes the brain-wide skill registry shared by every area",
  delete_skill: "deletes from the brain-wide skill registry shared by every area",
  open_loops: "open loops are not source-filtered for remote callers at the pin (A13)",
  loops_close: "acts on open loops, which are withheld (A13)",
  loops_mute: "acts on open loops, which are withheld (A13)",
  loops_unmute: "acts on open loops, which are withheld (A13)",
  // 0.60.424.0 (C336 M2): fail closed until upstream's check of these arguments against the area binding is verified
  sources_resolve_path: "resolves paths of named engine sources, i.e. other areas",
  rate_answer: "rates pages named as `source_id:slug` refs of any source",
  questions_pin: "standing questions take a `source` argument the area binding is not verified to cover",
  questions_list: "standing questions take a `source` argument the area binding is not verified to cover",
  questions_status: "standing questions take a `source` argument the area binding is not verified to cover",
  questions_refresh: "standing questions take a `source` argument the area binding is not verified to cover",
  questions_unpin: "standing questions take a `source` argument the area binding is not verified to cover",
};

const FAN_OUT_READS = new Set([
  "recall", "entity", "query", "search", "get_page", "list_pages", "get_chunks", "resolve_slugs", "get_links", "get_backlinks",
  "traverse_graph", "get_timeline", "find_trajectory", "takes_list", "takes_search",
]);
const MODEL_COST = new Set(["think", "synthesize"]);
const LONG = new Set(["think", "synthesize", "query", "assemble_evidence", "extract_facts", "extract_entities", "remember", "capture", "put_page", "put_pages", "commit_page_upload", "search_exact"]);

export interface Exposure {
  version: string;
  commit: string;
  exposed: Map<string, ExposedOperation>;
  excluded: Map<string, string>;
}

let cached: Exposure | null = null;

export function gbrainExposure(): Exposure {
  if (cached) return cached;
  const surface = surfaceData as Surface;
  const exposed = new Map<string, ExposedOperation>();
  const excluded = new Map<string, string>();
  for (const op of surface.operations) {
    if (op.scope !== "read" && op.scope !== "write") excluded.set(op.name, `needs the upstream '${op.scope}' scope`);
    else if (op.cliOnly) excluded.set(op.name, "upstream cliOnly");
    else if (op.localOnly) excluded.set(op.name, "upstream localOnly (host filesystem)");
    else if (op.publishGateKey) excluded.set(op.name, `hidden from remote callers unless ${op.publishGateKey} is enabled`);
    else if (POLICY_EXCLUSIONS[op.name]) excluded.set(op.name, POLICY_EXCLUSIONS[op.name] as string);
    else {
      const write = op.scope === "write" && op.mutating;
      const crud = write ? WRITE_CRUD[op.name] : (["read"] as CrudAction[]);
      if (!crud) throw new Error(`GBrain write ${op.name} has no CRUD mapping`);
      const destructive = crud.includes("delete");
      exposed.set(op.name, {
        name: op.name,
        crud,
        effect: !write ? "read" : destructive ? "destructive" : "write",
        ...(destructive ? { holdFamily: "destructive" as const } : {}),
        fanOut: !write && FAN_OUT_READS.has(op.name),
        modelCost: MODEL_COST.has(op.name),
        long: LONG.has(op.name),
      });
    }
  }
  cached = { version: surface.provenance.tag.replace(/^v/u, ""), commit: surface.provenance.commit, exposed, excluded };
  return cached;
}

const AREA_PARAM = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]{1,63}$",
  description: "Area id. Writes default to your own area; fan-out reads default to every area you can read.",
};

/** Builds the dynamic catalog from the live upstream tool list (schemas, descriptions) and the exposure policy. */
export function catalogEntries(upstreamTools: readonly Record<string, unknown>[]): DynamicCatalogEntry[] {
  const exposure = gbrainExposure();
  const byName = new Map(upstreamTools.map((tool) => [String(tool.name), tool]));
  const entries: DynamicCatalogEntry[] = [];
  for (const policy of exposure.exposed.values()) {
    const tool = byName.get(policy.name);
    if (!tool) continue;
    const schema = (tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }) as Record<string, unknown>;
    const { source_id: _dropped, source_ids: _droppedMany, ...properties } = (schema.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((key) => key !== "source_id" && key !== "source_ids") : [];
    const description = typeof tool.description === "string" ? tool.description.slice(0, 1000) : policy.name;
    entries.push({
      name: `${ENTRY_PREFIX}${policy.name}`,
      title: (typeof tool.title === "string" ? tool.title : policy.name.replace(/_/gu, " ")).slice(0, 60),
      description,
      inputSchema: { type: "object", properties: { ...properties, area: AREA_PARAM }, ...(required.length ? { required } : {}) },
      crud: policy.crud,
      effect: policy.effect,
      ...(policy.holdFamily ? { holdFamily: policy.holdFamily } : {}),
    });
  }
  return entries;
}

/** Resolve a catalog entry name to the exposed upstream op, or null. */
export function resolveEntry(entryName: string): ExposedOperation | null {
  if (!entryName.startsWith(ENTRY_PREFIX)) return null;
  return gbrainExposure().exposed.get(entryName.slice(ENTRY_PREFIX.length)) ?? null;
}
