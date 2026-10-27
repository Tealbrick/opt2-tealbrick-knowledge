// Operation handlers, registered by operation id (the manifest is the only route/schema source).
// Authorization: the SDK has already run gate() at the bridge and authorize() in the app
// (grant CRUD ∩ op CRUD ∩ best area access). Handlers bind each call to concrete areas and check
// access per area through `areaAccess` (SDK scope rows + the person and team areas of C373, src/people.ts); an area the
// caller may not read answers like a missing one.
import type { CrudAction, DynamicCatalogEntry, DynamicResolution } from "@opt2-tealbrick/spec/manifest";
import type { AppEvents, Caller, DynamicHandlers, HandlerSpec, HookContext, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { createAccessHandlers } from "./access.ts";
import { type AreaAccess, areaAccess } from "./area-access.ts";
import { AREA_SCOPE, type Area } from "./areas.ts";
import { syncDirectory } from "./directory-feed.ts";
import { deterministicRequestId } from "./engines/gbrain/client.ts";
import { documentIdFromSlug, EngineCallError, engineError, type RecallRow } from "./engines/gbrain/engine.ts";
import { resolveEntry as engineResolve } from "./engines/gbrain/exposure.ts";
import { NotebookError } from "./engines/notebook/client.ts";
import { agentAreaId, SHARED_AREA_ID } from "./ids.ts";
import type { AppSecrets, Knowledge, Services } from "./knowledge.ts";
import { createLibraryHandlers } from "./library.ts";
import { fanOut, mergeRanked } from "./merge.ts";
import { NARROWING_UNSUPPORTED, NARROWING_VIOLATION, type Narrowing, NarrowingError, readNarrowing, type TagFilter, tagsPass, untaggedPass } from "./narrowing.ts";
import { isGovernedArea } from "./people.ts";
import { type Citation, cleanTags, documentCitation, memoryDigest, StoreError } from "./store/documents.ts";

/** The SDK's error class (CORE §8 envelope); injected so this module only depends on frozen types. */
export type ErrorFactory = new (code: string, message: string, httpStatus?: number) => Error;

type In = Record<string, any>;

export function ownArea(caller: Caller): string | null {
  return caller.type === "agent" ? agentAreaId(caller.id) : null;
}

/**
 * C373 app writers (Observer deliveries). A companion APP caller (`caller.type === "app"`, e.g. Observer with its companion
 * grant for these ops) may use only these ops: list the areas it can read, and create or update documents in a SHARED area
 * (the company area). Never an agent's private area, never a person or team area, never any other read, whatever scope rows say.
 *
 * Its write permission is the SDK `own` default grant, which the SDK gives every first-seen caller: read_write on an
 * instance named after the app (SDK store only; Knowledge has no area for it). The SDK gate checks that row (`writeScope`
 * below), so the owner can turn app writes off with `tb.scopes_set` (level `read`) on it; Knowledge then writes into the
 * shared area the app names (default: company), which it must also be able to read (the `shared` default grant).
 */
export const APP_CALLER_OPS: ReadonlySet<string> = new Set(["areas_list", "document_create", "document_update"]);
const isApp = (caller: Caller) => caller.type === "app";
// C373 person memory: a person or team area has no SDK scope row (Knowledge governs it from the directory): the SDK checks
// the caller's best area access (null target) and the handler decides that area through areaAccess.
const sdkTarget = (area: string) => (isGovernedArea(area) ? null : area);
const writeScope = (input: In, caller: Caller) => (isApp(caller) ? caller.id : typeof input.area === "string" ? sdkTarget(input.area) : ownArea(caller));
const readScope = (input: In) => (typeof input.area === "string" ? sdkTarget(input.area) : null);
const anyScope = () => null;

const FAN_OUT_LIMIT = 4;

/**
 * G5 `rules.narrowing` per op (SDK-API §18). `items`: the handler keeps only items whose tags pass and returns `tags[]`
 * on each item (so a Rules after hook can redact too); for a WRITE (§18.4, C150) the handler treats a hidden item like
 * a missing one and refuses a result the caller could not read (`narrowing_violation`). `untagged`: the items carry no
 * tags (research notebooks), so only a narrowing without `anyOf` lets the call run (reads and writes alike). `none`:
 * the call neither returns nor touches a tagged item. Every op NOT listed here (person library views and writes,
 * collection-wide deletes, engine tools, any future op) refuses a tag narrowing with `narrowing_unsupported` (fail
 * closed): a new op is narrowed only once someone decides how.
 */
export const NARROWING_POLICY: Readonly<Record<string, "items" | "untagged" | "none" | "unsupported">> = {
  // reads
  recall: "items",
  search: "items",
  get: "items",
  context: "items",
  // decided (C336 M4): the engine composes the answer from pages whose tags Knowledge cannot match, so any tag narrowing refuses
  ask: "unsupported",
  documents_search: "items",
  document_get: "items",
  document_revisions: "items",
  comments_list: "items",
  links_list: "items",
  collections_list: "items",
  collection_get: "items",
  collection_tree: "items",
  library_recall: "items",
  library_documents: "items",
  areas_list: "none",
  research_sources_list: "untagged",
  research_source_get: "untagged",
  research_notes_list: "untagged",
  research_note_get: "untagged",
  research_chat_get: "untagged",
  research_context_get: "untagged",
  // writes (§18.4 a/b: hidden item = missing item; a result outside the narrowing → narrowing_violation)
  remember: "items",
  document_create: "items",
  document_update: "items",
  document_delete: "items",
  comment_add: "items",
  link_add: "items",
  link_delete: "items",
  collection_create: "none",
  // §18.4 d: research writes carry no tags (research_ask also answers from notebook content)
  research_source_add: "untagged",
  research_chat_start: "untagged",
  research_ask: "untagged",
  research_source_delete: "untagged",
  // §18.4 c/e (not listed → unsupported): collection_delete (would remove hidden documents), library_* writes, engine tools
};

/**
 * Rank engine tools for a search (C336 M4): words of the query against the tool name (strongest), title and description.
 * Tools without any matching word are left out; ties keep catalog order. An empty query lists the first `limit` tools.
 */
export function searchCatalog(entries: readonly DynamicCatalogEntry[], query: string, limit: number): DynamicCatalogEntry[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/u).filter((w) => w.length > 1);
  const max = Math.min(Math.max(limit, 1), 50);
  if (!words.length) return entries.slice(0, max);
  const scored = entries.map((entry, index) => {
    const name = entry.name.toLowerCase().replace(/^gb_/u, "");
    const title = (entry.title ?? "").toLowerCase();
    const description = (entry.description ?? "").toLowerCase();
    let score = 0;
    for (const word of words) {
      if (name === word) score += 10;
      else if (name.split("_").includes(word)) score += 6;
      else if (name.includes(word)) score += 4;
      if (title.includes(word)) score += 2;
      if (description.includes(word)) score += 1;
    }
    return { entry, index, score };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .map((row) => row.entry);
}

export function createHandlers(knowledge: Knowledge, TbError: ErrorFactory) {
  const fail = (code: string, message: string, status: number) => new TbError(code, message, status);
  const notFound = () => fail("not_found", "not found", 404);

  /** The narrowing each running call was admitted with (set by `narrowed` before the handler runs). */
  const admitted = new WeakMap<object, Narrowing | null>();
  const tagFilter = (ctx: OpContext): TagFilter | null => admitted.get(ctx)?.tags ?? null;

  /**
   * Reads and checks the call's narrowing before a read runs: unknown `v` / malformed → `narrowing_unsupported` (409);
   * an op that cannot apply a tag narrowing refuses it. The rule id goes into the receipt meta.
   */
  function admit(policy: (typeof NARROWING_POLICY)[string] | "unsupported", ctx: OpContext): void {
    let narrowing: Narrowing | null;
    try {
      narrowing = readNarrowing(ctx.context);
    } catch (error) {
      if (error instanceof NarrowingError) throw fail(error.code, error.message, error.httpStatus);
      throw error;
    }
    admitted.set(ctx, narrowing);
    if (!narrowing) return;
    ctx.receipt.meta({ narrowing: { v: narrowing.v, ruleId: narrowing.ruleId } });
    if (!narrowing.tags || policy === "items" || policy === "none") return;
    if (policy === "untagged" && untaggedPass(narrowing.tags)) return;
    throw fail(
      NARROWING_UNSUPPORTED,
      policy === "untagged"
        ? `research notebooks carry no memory tags, so this call cannot be limited to the tags Rules allows (rule ${narrowing.ruleId})`
        : `this call cannot be limited to the memory tags Rules allows (rule ${narrowing.ruleId}); use recall or documents_search`,
      409,
    );
  }

  /** Applies `admit` to EVERY op, reads and writes (§18.4, C150): an unlisted op refuses a tag narrowing (fail closed). */
  function narrowed(id: string, spec: HandlerSpec<In, Json>): HandlerSpec<In, Json> {
    const run = spec.run;
    return {
      ...spec,
      run: async (input, ctx) => {
        if (isApp(ctx.caller) && !APP_CALLER_OPS.has(id)) throw fail("scope_denied", "an app may only list areas and create or update documents in the company area", 403);
        admit(NARROWING_POLICY[id] ?? "unsupported", ctx);
        return run(input, ctx);
      },
    };
  }
  /** C373: the area access of this call (memoized per call; the directory copy is read once per call). */
  const accessMemo = new WeakMap<object, AreaAccess>();
  const accessOf = (ctx: OpContext): AreaAccess => {
    let access = accessMemo.get(ctx);
    if (!access) {
      access = areaAccess(ctx, services(ctx).areas);
      accessMemo.set(ctx, access);
    }
    return access;
  };
  /** C373: a granted person area limited to tags hides every memory without one of them (like a missing one). */
  const outsideLimit = (ctx: OpContext, area: string, tags: readonly string[]) => {
    const limit = accessOf(ctx).limit(area);
    return limit !== null && !tags.some((tag) => limit.includes(tag));
  };
  /** True when the call's narrowing (or a tag-limited grant on its area) hides the document (§18.1 tagsMatch). */
  const hidden = (ctx: OpContext) => (doc: { tags: string[]; area?: string }) => !tagsPass(doc.tags, tagFilter(ctx)) || (doc.area !== undefined && outsideLimit(ctx, doc.area, doc.tags));
  /** A document the narrowing hides answers like a missing one (reads, and writes that address it: §18.4 a). */
  function visible(ctx: OpContext, doc: { tags: string[]; area?: string }): void {
    if (hidden(ctx)(doc)) throw notFound();
  }
  /** §18.4 b: a write never produces an item the caller could not then read (nothing is written). */
  function resultVisible(ctx: OpContext, tags: string[]): void {
    const filter = tagFilter(ctx);
    if (!filter || tagsPass(tags, filter)) return;
    const ruleId = admitted.get(ctx)?.ruleId ?? "unknown";
    throw fail(
      NARROWING_VIOLATION,
      `the result would carry tags the owner's rule ${ruleId} does not let you read; ${filter.anyOf ? `keep at least one of: ${filter.anyOf.join(", ") || "(none allowed)"}` : "keep the tags allowed"}${filter.noneOf?.length ? `; never add: ${filter.noneOf.join(", ")}` : ""}`,
      409,
    );
  }

  /** Map domain errors to the envelope; anything unknown propagates (SDK answers 500 and records `failed`). */
  const wrap = <T>(fn: () => Promise<T>) =>
    fn().catch((error: unknown) => {
      if (error instanceof StoreError || error instanceof EngineCallError) throw fail(error.code, error.message, error.httpStatus);
      if (error instanceof NotebookError) {
        if (error.code === "not_found") throw notFound();
        if (error.disposition === "ambiguous") throw fail("research_outcome_unknown", "the research engine may have applied this; read before retrying", 503);
        throw fail(`research_${error.code}`, error.message, error.status === 413 ? 413 : 502);
      }
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "key_missing") throw fail("key_missing", "a model key is missing; add it on the bridge key page from Portal", 409);
      throw error;
    });

  const secretsOf = (ctx: object) => (ctx as { secrets?: AppSecrets }).secrets;
  const services = (ctx: OpContext) => knowledge.bind(ctx.db, secretsOf(ctx));

  /** C373: an app caller sees only shared areas (an agent's, person's or team's area answers like a missing one). */
  const appSees = (ctx: OpContext, area: string) => !isApp(ctx.caller) || services(ctx).areas.get(area)?.kind === "shared";
  /** `items`: the op filters item by item, so a tag-limited grant area may be read (others answer it like a missing area). */
  async function readable(ctx: OpContext, area: string, items = false): Promise<void> {
    const access = accessOf(ctx);
    if (!appSees(ctx, area) || !(await access.can(area, "read"))) throw notFound();
    if (!items && access.limit(area) !== null) throw notFound();
  }
  async function writable(ctx: OpContext, area: string, crud: CrudAction): Promise<void> {
    await readable(ctx, area);
    // an app writes into a shared area under its own write row (APP_CALLER_OPS), an agent under its access to that area
    const allowed = isApp(ctx.caller) ? await ctx.scope.can(AREA_SCOPE, ctx.caller.id, crud) : await accessOf(ctx).can(area, crud);
    if (!allowed) throw fail("scope_denied", `no ${crud} access to area ${area}`, 403);
    if (isApp(ctx.caller)) {
      // QA-KN24-4: `listed` is false once the companion edge was removed (or the slice expired) but the grant is still valid.
      // Conformance (A12.caller_name) lets such a caller run, so the write is allowed and left in the app log.
      if (ctx.caller.listed === false) ctx.log.warn("app write by a caller that is not listed (companion edge removed?)", { caller: ctx.caller.id });
      knowledge.noteCaller(services(ctx), ctx.caller);
    }
  }
  /** Areas of an item-filtering read (recall, search, context, documents_search). */
  async function targetAreas(ctx: OpContext, area: unknown): Promise<string[]> {
    if (typeof area === "string") {
      await readable(ctx, area, true);
      return [area];
    }
    return accessOf(ctx).readable(true);
  }
  /** C373: without `area` a write goes to the owner's person area when the agent has an owner, else its own agent area. */
  function defaultArea(ctx: OpContext, area: unknown): string {
    const id = typeof area === "string" ? area : isApp(ctx.caller) ? SHARED_AREA_ID : (accessOf(ctx).defaultArea() ?? ownArea(ctx.caller));
    // A caller with no memory area of its own (a companion app, not an agent) has nothing to default to: scope_denied (0.1.12 conformance A12.companion_inbound).
    if (!id) throw fail("scope_denied", "name an area you can access: this caller has no area of its own", 403);
    return id;
  }
  /** Area row with engine resources provisioned (provisioning runs lazily: it needs the helper call). */
  async function readyArea(ctx: OpContext, s: Services, id: string, need: "source" | "notebook"): Promise<Area> {
    let area = s.areas.get(id);
    if (!area) throw notFound();
    if ((need === "source" && !area.sourceReady) || (need === "notebook" && !area.notebookId)) {
      await knowledge.provision(s, ctx);
      area = s.areas.get(id) as Area;
    }
    if (need === "source" && !area.sourceReady) throw fail("area_not_ready", "the memory area is still being prepared", 503);
    if (need === "notebook" && !area.notebookId) throw fail("area_not_ready", "the research notebook is still being prepared", 503);
    return area;
  }
  function documentFor(s: Services, id: string) {
    const doc = s.store.getDocument(id);
    if (!doc) throw notFound();
    return doc;
  }
  function notebookOf(s: Services) {
    if (!s.notebook) throw fail("research_disabled", "research notebooks are not enabled in this deployment", 409);
    return s.notebook;
  }
  const actor = (ctx: OpContext) => ctx.caller.id;

  /**
   * Engine recall per area (fan-out), keyword fallback per area that cannot answer, one merged ranked answer. Every
   * result carries the canonical document's `tags` ([] for an engine page that is not a canonical document). Under a
   * G5 narrowing only canonical documents whose tags pass are returned (an engine page of unknown tags never is).
   * QA F88 (L3): an engine answer that cannot be read is a failure (keyword fallback), and an engine that says it ran
   * degraded (e.g. keyword-only without embeddings) is reported per area and merged with the keyword search; either way
   * `degraded: true`. The engine state also feeds the app status (F89).
   */
  async function recallAcross(s: Services, ctx: OpContext, areas: string[], query: string, limit: number, opts: { tool?: "query" | "search"; withKeyword?: boolean } = {}) {
    const engine = s.engine;
    const filter = tagFilter(ctx);
    // A narrowing drops rows after the engine ranked them: ask for more so a narrowed answer is not needlessly short.
    const engineLimit = filter ? Math.min(limit * 3, 50) : limit;
    if (engine) await knowledge.provision(s, ctx).catch(() => undefined);
    const outcomes = await fanOut(areas, FAN_OUT_LIMIT, async (id) => {
      const area = s.areas.get(id);
      if (!engine || !area?.sourceReady) throw Object.assign(new Error("not ready"), { code: engine ? "area_not_ready" : "no_engine" });
      return engine.recall(id, area.sourceId, query, engineLimit, ctx.caller.id, opts.tool ?? "query");
    });
    // C336 M1: every hit carries `ref` (what to open with get) and `source` (the citation). A canonical document cites its
    // imported source or itself; an engine page cites its area and slug. An engine row with neither cannot be cited: it is
    // left out and counted per area (`uncited`), never returned without a source.
    type Ref = { kind: "document"; id: string } | { kind: "page"; area: string; slug: string } | { kind: "fact"; area: string; id: string; lookup?: { entity?: string; grep?: string } };
    type TaggedRow = RecallRow & { tags: string[]; ref: Ref; source: Citation | { ref: string } };
    const lists: { area: string; rows: TaggedRow[] }[] = [];
    const statuses: { area: string; ok: boolean; via: "engine" | "keyword"; error?: string; degraded?: string[]; uncited?: number }[] = [];
    const keyword = (area: string): TaggedRow[] =>
      s.store
        .search({ areas: [area], query, limit, tags: filter })
        .filter((hit) => !outsideLimit(ctx, area, hit.tags))
        .map((hit) => ({ area: hit.area, documentId: hit.id, slug: "", title: hit.title, text: hit.excerpt, score: null, tags: hit.tags, ref: { kind: "document", id: hit.id }, source: hit.citation }));
    for (const outcome of outcomes) {
      if (outcome.ok && outcome.value) {
        const { rows, degraded } = outcome.value;
        const known = s.store.citationsOf(rows.flatMap((row) => (row.documentId ? [row.documentId] : [])));
        const limited = accessOf(ctx).limit(outcome.area) !== null;
        let uncited = 0;
        const tagged = rows.flatMap((row): TaggedRow[] => {
          const doc = row.documentId ? known.get(row.documentId) : undefined;
          if (filter && (!doc || !tagsPass(doc.tags, filter))) return [];
          // C373: a tag-limited grant area returns only canonical documents with one of the granted tags
          if (limited && (!doc || outsideLimit(ctx, outcome.area, doc.tags))) return [];
          if (doc && row.documentId) return [{ ...row, tags: doc.tags, ref: { kind: "document", id: row.documentId }, source: doc.citation }];
          // QA-KNOW17-1: a saved fact of the engine is cited by its id (and read again with `get` through its lookup)
          if (row.factId) {
            const ref: Ref = { kind: "fact", area: row.area, id: row.factId, ...(row.factLookup && Object.keys(row.factLookup).length ? { lookup: row.factLookup } : {}) };
            return [{ ...row, tags: [], ref, source: { ref: `knowledge:fact/${row.area}/${row.factId}` } }];
          }
          // A page that mirrors a deleted canonical document is stale: its document is gone, so it is not cited either.
          if (row.documentId || !row.slug) {
            uncited++;
            return [];
          }
          return [{ ...row, tags: [], ref: { kind: "page", area: row.area, slug: row.slug }, source: { ref: `knowledge:page/${row.area}/${row.slug}` } }];
        });
        lists.push({ area: outcome.area, rows: tagged });
        // `search` (C336 M4) also ranks Knowledge's own word index of the area's documents next to the engine's answer.
        if (opts.withKeyword && !degraded.length) lists.push({ area: outcome.area, rows: keyword(outcome.area) });
        const cited = uncited ? { uncited } : {};
        if (degraded.length) {
          // The engine ran without part of its pipeline: add the keyword search so a degraded engine never hides a memory.
          lists.push({ area: outcome.area, rows: keyword(outcome.area) });
          statuses.push({ area: outcome.area, ok: true, via: "engine", degraded, ...cited });
        } else statuses.push({ area: outcome.area, ok: true, via: "engine", ...cited });
      } else {
        lists.push({ area: outcome.area, rows: keyword(outcome.area) });
        statuses.push({ area: outcome.area, ok: true, via: "keyword", ...(outcome.error ? { error: outcome.error } : {}) });
      }
    }
    const fallbacks = statuses.filter((status) => status.via === "keyword");
    const engineDegraded = statuses.flatMap((status) => status.degraded ?? []);
    if (engine) {
      const failed = fallbacks.filter((f) => f.error && f.error !== "area_not_ready" && f.error !== "no_engine" && f.error !== "gbrain_starting");
      knowledge.noteEngine(failed.length ? { state: "failing", detail: [...new Set(failed.map((f) => f.error as string))] } : engineDegraded.length ? { state: "degraded", detail: [...new Set(engineDegraded)] } : statuses.some((st) => st.via === "engine") ? { state: "ok", detail: [] } : null);
    }
    if (engine && (fallbacks.length || engineDegraded.length)) {
      ctx.log.warn("recall degraded", { areas: [...fallbacks.map((f) => `${f.area}:${f.error ?? "unknown"}`), ...statuses.filter((st) => st.degraded).map((st) => `${st.area}:${(st.degraded ?? []).join("+")}`)].join(",") });
    }
    const results = mergeRanked(lists, (row) => row.documentId ?? `${row.area}:${row.slug}:${row.text.slice(0, 64)}`, limit).map((row) => ({
      documentId: row.documentId,
      title: row.title,
      text: row.text,
      tags: row.tags,
      areas: row.areas,
      ref: row.ref,
      source: row.source,
    }));
    return { results, areas: statuses, partial: false, degraded: fallbacks.length > 0 || engineDegraded.length > 0 };
  }

  const handlers: Record<string, HandlerSpec<In, Json>> = {
    recall: {
      scope: readScope,
      redact: (input) => `recall (${String(input.query).length} chars)`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const areas = await targetAreas(ctx, input.area);
          const limit = Math.min(Number(input.limit ?? 10), 50);
          return (await recallAcross(s, ctx, areas, String(input.query), limit)) as Json;
        }),
    },

    remember: {
      scope: writeScope,
      redact: (input, output) => {
        const size = Array.isArray(input.items) ? `${input.items.length} items` : `${String(input.text ?? "").length} chars`;
        return `remembered ${size} in ${(output as In | undefined)?.area ?? input.area ?? "own area"}`;
      },
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const batch = Array.isArray(input.items);
          if (batch === (typeof input.text === "string")) throw fail("invalid_input", "send either text or items", 400);
          const area = defaultArea(ctx, input.area);
          await writable(ctx, area, "create");
          if (!s.areas.get(area)) throw notFound();
          // C336 M3: one memory per item; each is stored once per area (dedupe by its normalised text), so a hook that
          // sends an overlapping batch again does not store twice. `source` becomes the citation of every item (M1).
          const items: { text: string; title?: string; tags: string[] }[] = batch
            ? (input.items as In[]).map((item) => ({ text: String(item.text), tags: cleanTags([...(Array.isArray(item.tags) ? item.tags.map(String) : []), ...(typeof item.kind === "string" ? [item.kind] : [])]) }))
            : [{ text: String(input.text), ...(typeof input.title === "string" ? { title: input.title } : {}), tags: cleanTags(input.tags as string[] | undefined) }];
          for (const item of items) resultVisible(ctx, item.tags);
          const source = input.source as In | undefined;
          const sourceRef = source ? `${String(source.harness)}:session/${String(source.session)}` : undefined;
          const sourceUrl = typeof source?.url === "string" ? source.url : undefined;
          const results = s.store.transaction(() =>
            items.map((item) => {
              const digest = memoryDigest(item.text, area);
              const known = s.store.findByDigest(area, digest);
              // QA-KNOW17-2 (§18.4 a: hidden = missing): a duplicate the caller's narrowing hides is never named; the
              // memory is stored as a new document with the caller's tags and no dedupe key (the hidden one keeps it)
              const duplicateVisible = known !== null && !hidden(ctx)(known);
              if (known && duplicateVisible) return { doc: known, created: false };
              const firstLine = item.text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "Memory";
              const doc = s.store.createDocument({
                area,
                title: (item.title ?? firstLine).slice(0, 200),
                body: item.text,
                status: "published",
                tags: item.tags,
                actor: actor(ctx),
                ...(known ? {} : { contentDigest: digest }),
                ...(sourceRef ? { sourceRef } : {}),
                ...(sourceUrl ? { sourceUrl } : {}),
              });
              return { doc, created: true };
            }),
          );
          if (results.some((r) => r.created)) {
            await knowledge.provision(s, ctx).catch(() => undefined);
            knowledge.kick(s);
          }
          const first = results[0] as { doc: { id: string; version: number }; created: boolean };
          const out: Json = batch
            ? { area, items: results.map((r) => ({ documentId: r.doc.id, created: r.created })) }
            : { documentId: first.doc.id, area, version: first.doc.version, created: first.created };
          return out;
        }),
    },

    // ── C336 M4: hot tools (search, get, context, ask); the engine's own tools are found with engine_search ──

    search: {
      scope: readScope,
      redact: (input) => `search (${String(input.query).length} chars)`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const areas = await targetAreas(ctx, input.area);
          const limit = Math.min(Number(input.limit ?? 10), 50);
          return (await recallAcross(s, ctx, areas, String(input.query), limit, { tool: "search", withKeyword: true })) as Json;
        }),
    },

    get: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const ref = input.ref as In;
          if (ref.kind === "fact") {
            // QA-KNOW17-1: a saved fact of the engine, read again with its own recall lookup in the area and matched by id
            if (typeof ref.area !== "string" || typeof ref.id !== "string") throw fail("invalid_input", "a fact ref needs area and id", 400);
            const lookup = (ref.lookup ?? {}) as { entity?: unknown; grep?: unknown };
            const args = typeof lookup.entity === "string" && lookup.entity ? { entity: lookup.entity } : typeof lookup.grep === "string" && lookup.grep ? { grep: lookup.grep } : null;
            if (!args) throw fail("invalid_input", "a fact ref needs the lookup that recall returned with it", 400);
            await readable(ctx, ref.area);
            // engine facts carry no tags Knowledge can match: under a tag narrowing they answer like missing ones
            if (tagFilter(ctx)) throw notFound();
            const engine = s.engine;
            if (!engine) throw notFound();
            const area = await readyArea(ctx, s, ref.area, "source");
            let answer: In;
            try {
              answer = (await engine.call(area.sourceId, "gb_recall", { ...args, limit: 50 }, ctx.caller.id)) as In;
            } catch (error) {
              throw engineError(error);
            }
            const facts = Array.isArray(answer?.facts) ? (answer.facts as In[]) : [];
            const fact = facts.find((f) => String(f.fact_id ?? f.id) === ref.id);
            if (!fact) throw notFound();
            const provenance = typeof fact.provenance === "string" ? fact.provenance.slice(0, 500) : undefined;
            return {
              ref: { kind: "fact", area: ref.area, id: ref.id, lookup: args },
              area: ref.area,
              title: typeof fact.entity_slug === "string" ? `Saved fact about ${fact.entity_slug}` : "Saved fact",
              text: String(fact.fact ?? ""),
              source: { ref: `knowledge:fact/${ref.area}/${ref.id}`, ...(provenance ? { provenance } : {}) },
            } as unknown as Json;
          }
          let documentId = ref.kind === "document" && typeof ref.id === "string" ? ref.id : null;
          if (ref.kind === "page") {
            if (typeof ref.area !== "string" || typeof ref.slug !== "string") throw fail("invalid_input", "a page ref needs area and slug", 400);
            // a mirror page of a canonical document opens the document (its tags and citation are Knowledge's)
            documentId = documentIdFromSlug(ref.slug);
            if (!documentId) {
              await readable(ctx, ref.area);
              // engine pages carry no tags Knowledge can match: under a tag narrowing they answer like missing ones (§18.4 a)
              if (tagFilter(ctx)) throw notFound();
              const engine = s.engine;
              if (!engine) throw notFound();
              const area = await readyArea(ctx, s, ref.area, "source");
              let page: In;
              try {
                page = (await engine.call(area.sourceId, "gb_get_page", { slug: ref.slug }, ctx.caller.id)) as In;
              } catch (error) {
                const failure = engineError(error);
                if ((failure as { code?: string }).code === "engine_page_not_found") throw notFound();
                throw failure;
              }
              const text = String(page?.compiled_truth ?? page?.content ?? page?.body ?? "");
              return { ref: { kind: "page", area: ref.area, slug: ref.slug }, area: ref.area, title: String(page?.title ?? ref.slug), text, source: { ref: `knowledge:page/${ref.area}/${ref.slug}` } } as unknown as Json;
            }
          }
          if (!documentId) throw fail("invalid_input", "a document ref needs id", 400);
          const doc = documentFor(s, documentId);
          await readable(ctx, doc.area, true);
          visible(ctx, doc);
          return { ref: { kind: "document", id: doc.id }, area: doc.area, title: doc.title, text: doc.body, tags: doc.tags, version: doc.version, source: documentCitation(doc) } as unknown as Json;
        }),
    },

    context: {
      scope: readScope,
      redact: (input) => `context ${String(input.purpose)}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const maxChars = Math.min(Math.max(Number(input.maxChars ?? 4000), 200), 20_000);
          const areas = await targetAreas(ctx, input.area);
          const entities = Array.isArray(input.entities) ? (input.entities as string[]).map((e) => e.replace(/,/gu, " ").trim()).filter(Boolean).slice(0, 8) : [];
          const query = typeof input.query === "string" ? input.query : entities.join(" ");
          const lines: string[] = [];
          const refs: Json[] = [];
          let via = "recent";
          let degraded = false;
          // Entities and no tag narrowing: the engine's zero-LLM context pack (core memory, entity cards, hot facts) for the
          // caller's own area (or the one named); then memories that match, cited.
          if (entities.length && s.engine && !tagFilter(ctx)) {
            const own = typeof input.area === "string" ? input.area : (accessOf(ctx).defaultArea() ?? ownArea(ctx.caller));
            // never for a tag-limited grant area: the pack is built from engine pages Knowledge cannot match to tags
            if (own && areas.includes(own) && accessOf(ctx).limit(own) === null) {
              try {
                const area = await readyArea(ctx, s, own, "source");
                const pack = (await s.engine.call(area.sourceId, "gb_context_pack", { entities: entities.join(","), budget_tokens: Math.floor(maxChars / 4) }, ctx.caller.id)) as In;
                via = "context_pack";
                // QA-KNOW17-1: every pack line carries its citation (a card is an engine page, a fact is cited by id); a line
                // that cannot be cited is left out, never shown without a source
                for (const card of Array.isArray(pack?.cards) ? (pack.cards as In[]) : []) {
                  if (typeof card.slug !== "string" || !card.slug) continue;
                  lines.push(`- ${String(card.title ?? card.slug)}: ${String(card.summary ?? card.text ?? card.compiled_truth ?? "").replace(/\s+/gu, " ").slice(0, 400)} [knowledge:page/${own}/${card.slug}]`);
                  refs.push({ kind: "page", area: own, slug: card.slug });
                }
                for (const fact of Array.isArray(pack?.facts) ? (pack.facts as In[]) : []) {
                  const id = fact.fact_id ?? fact.id;
                  if ((typeof id !== "string" && typeof id !== "number") || typeof fact.entity_slug !== "string") continue;
                  lines.push(`- ${String(fact.fact ?? "")} (${fact.entity_slug}) [knowledge:fact/${own}/${String(id)}]`);
                  refs.push({ kind: "fact", area: own, id: String(id), lookup: { entity: fact.entity_slug } });
                }
                for (const thread of Array.isArray(pack?.open_threads) ? (pack.open_threads as In[]) : []) {
                  if (typeof thread.slug !== "string" || !thread.slug) continue;
                  lines.push(`- open: ${String(thread.title ?? thread.text ?? thread.slug)} [knowledge:page/${own}/${thread.slug}]`);
                  refs.push({ kind: "page", area: own, slug: thread.slug });
                }
              } catch (error) {
                // a context block never blocks the session: the word and meaning search below still answer
                degraded = true;
                ctx.log.warn("context pack failed", { code: String((engineError(error) as { code?: unknown }).code ?? "engine_error").slice(0, 64) });
              }
            }
          }
          if (query) {
            const found = await recallAcross(s, ctx, areas, query.slice(0, 500), 8);
            if (via === "recent") via = "recall";
            degraded ||= found.degraded;
            for (const row of found.results) {
              lines.push(`- ${row.title}: ${row.text.replace(/\s+/gu, " ").slice(0, 400)} [${row.source.ref}]`);
              refs.push(row.ref as unknown as Json);
            }
          } else if (!lines.length) {
            for (const hit of s.store.search({ areas, limit: 8, tags: tagFilter(ctx) }).filter((h) => !outsideLimit(ctx, h.area, h.tags))) {
              lines.push(`- ${hit.title}: ${hit.excerpt.replace(/\s+/gu, " ").slice(0, 300)} [${hit.citation.ref}]`);
              refs.push({ kind: "document", id: hit.id });
            }
          }
          const full = lines.join("\n");
          const truncated = full.length > maxChars;
          return { text: truncated ? `${full.slice(0, maxChars - 1)}…` : full, refs, via, truncated, degraded };
        }),
    },

    ask: {
      scope: writeScope,
      redact: (input) => `ask (${String(input.question).length} chars)`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const engine = s.engine;
          if (!engine) throw fail("engine_capability_unavailable", "no memory engine in this deployment", 404);
          const id = defaultArea(ctx, input.area);
          // model cost runs only in an area the caller may write (as the engine's own think)
          await writable(ctx, id, "read");
          // C373: think needs the reasoning role (or the legacy provider key); say so instead of an engine error
          // QA-KN24-3: a "not ok" answer may predate the owner's change (the engine restarts), so ask the helper again before refusing
          let reasoning = knowledge.engineModels()?.reasoning;
          if (reasoning?.state !== "ok") reasoning = (await knowledge.checkModels(ctx))?.reasoning ?? reasoning;
          if (reasoning && reasoning.state !== "ok") {
            throw fail("reasoning_model_missing", "ask needs a reasoning model: the owner sets the reasoning role on the Keys and models page (open it from Portal)", 409);
          }
          const area = await readyArea(ctx, s, id, "source");
          try {
            const answer = await engine.call(area.sourceId, "gb_think", { question: String(input.question) }, ctx.caller.id);
            return { area: id, answer: answer as Json };
          } catch (error) {
            throw engineError(error);
          }
        }),
    },

    areas_list: {
      scope: anyScope,
      run: (_input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const access = accessOf(ctx);
          const own = ownArea(ctx.caller);
          // C373: the default write area (the owner's person area, else the own agent area) is named, with why each area is readable
          const fallback = isApp(ctx.caller) ? SHARED_AREA_ID : (access.defaultArea() ?? own);
          const readable = new Set(await access.readable(true));
          const out = [];
          for (const area of s.areas.list()) {
            if (!readable.has(area.id) || !appSees(ctx, area.id)) continue;
            // QA-KN24-10: the real level; `contribute` can create and update but not delete, so it is not "read_write".
            // An app answers with its own write row; an agent with its access (SDK rows, or C373 person and team areas).
            const can = (crud: "create" | "delete") => (isApp(ctx.caller) ? ctx.scope.can(AREA_SCOPE, ctx.caller.id, crud) : access.can(area.id, crud));
            const level = (await can("delete")) ? "read_write" : (await can("create")) ? "contribute" : "read";
            const governed = access.governed(area.id);
            const limit = access.limit(area.id);
            out.push({
              id: area.id,
              label: area.label,
              kind: area.kind,
              own: area.id === own || governed?.via === "owner",
              ...(area.id === fallback && !isApp(ctx.caller) ? { default: true } : {}),
              access: level,
              ...(governed ? { via: governed.via } : {}),
              ...(limit ? { onlyTags: limit } : {}),
            });
          }
          const view = access.view;
          return {
            areas: out,
            // plain words for the agent: where a write without `area` goes, and whether the directory decided it
            defaultArea: fallback,
            directory: view ? (view.directory ? (view.owner ? "owner_known" : "no_owner") : "unavailable") : "not_applicable",
          };
        }),
    },

    collections_list: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const area = defaultArea(ctx, input.area);
          await readable(ctx, area);
          return { collections: services(ctx).store.listCollections(area, tagFilter(ctx)) as unknown as Json };
        }),
    },

    collection_create: {
      scope: writeScope,
      redact: (input) => `collection "${String(input.name).slice(0, 60)}"`,
      run: (input, ctx) =>
        wrap(async () => {
          const area = defaultArea(ctx, input.area);
          await writable(ctx, area, "create");
          const collection = services(ctx).store.createCollection(area, String(input.name), input.description, actor(ctx));
          return { id: collection.id, area };
        }),
    },

    documents_search: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const areas = await targetAreas(ctx, input.area);
          const hits = services(ctx)
            .store.search({ areas, query: input.query, collectionId: input.collectionId, limit: input.limit, tags: tagFilter(ctx) })
            .filter((hit) => !outsideLimit(ctx, hit.area, hit.tags));
          return { hits: hits as unknown as Json };
        }),
    },

    document_get: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const doc = documentFor(services(ctx), String(input.id));
          await readable(ctx, doc.area, true);
          visible(ctx, doc);
          return doc as unknown as Json;
        }),
    },

    document_create: {
      scope: writeScope,
      redact: (input) => `document "${String(input.title).slice(0, 60)}"`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const area = defaultArea(ctx, input.area);
          await writable(ctx, area, "create");
          if (!s.areas.get(area)) throw notFound();
          resultVisible(ctx, cleanTags(input.tags));
          const doc = s.store.createDocument({
            area,
            collectionId: input.collectionId,
            parentId: input.parentId,
            title: String(input.title),
            body: input.body,
            summary: input.summary,
            status: input.status,
            tags: input.tags,
            actor: actor(ctx),
            hidden: hidden(ctx),
          });
          await knowledge.provision(s, ctx).catch(() => undefined);
          knowledge.kick(s);
          return { id: doc.id, area, version: doc.version };
        }),
    },

    document_update: {
      scope: anyScope,
      redact: (input, output) => `document ${input.id} → v${(output as In | undefined)?.version ?? "?"}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const doc = documentFor(s, String(input.id));
          // §18.4 a: visibility before the access check, so a hidden document answers exactly like a missing one.
          await readable(ctx, doc.area);
          visible(ctx, doc);
          await writable(ctx, doc.area, "update");
          if (input.tags !== undefined) resultVisible(ctx, cleanTags(input.tags));
          const updated = s.store.updateDocument(doc.id, { title: input.title, body: input.body, summary: input.summary, status: input.status, tags: input.tags }, input.expectedVersion, actor(ctx));
          knowledge.kick(s);
          return { id: updated.id, version: updated.version };
        }),
    },

    document_delete: {
      scope: anyScope,
      redact: (input) => `delete document ${input.id}`,
      holdView: (input) => `An agent asks to delete document ${input.id}. The document and its memory entries are removed; revisions stay in backups.`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const doc = documentFor(s, String(input.id));
          await readable(ctx, doc.area);
          visible(ctx, doc);
          await writable(ctx, doc.area, "delete");
          s.store.deleteDocument(doc.id, actor(ctx));
          knowledge.kick(s);
          return { id: doc.id, deleted: true };
        }),
    },

    document_revisions: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const doc = documentFor(s, String(input.id));
          await readable(ctx, doc.area, true);
          visible(ctx, doc);
          return { revisions: s.store.revisions(doc.id, input.limit, tagFilter(ctx)) as unknown as Json };
        }),
    },

    comments_list: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const doc = documentFor(s, String(input.documentId));
          await readable(ctx, doc.area, true);
          visible(ctx, doc);
          return { comments: s.store.listComments(doc.id) as unknown as Json };
        }),
    },

    comment_add: {
      scope: anyScope,
      redact: (input) => `comment on ${input.documentId}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const doc = documentFor(s, String(input.documentId));
          await readable(ctx, doc.area);
          visible(ctx, doc);
          await writable(ctx, doc.area, "create");
          return s.store.addComment(doc.id, String(input.body), input.parentId, actor(ctx));
        }),
    },

    links_list: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const doc = documentFor(s, String(input.documentId));
          await readable(ctx, doc.area, true);
          visible(ctx, doc);
          // QA-KN25-2: links stay inside one area, so a tag-limited grant hides linked memories outside its tags (title and tags too)
          const links = s.store.listLinks(doc.id, tagFilter(ctx));
          const inLimit = (link: { tags?: unknown }) => !outsideLimit(ctx, doc.area, link.tags as string[]);
          return { outbound: links.outbound.filter(inLimit), backlinks: links.backlinks.filter(inLimit) } as unknown as Json;
        }),
    },

    link_add: {
      scope: anyScope,
      redact: (input) => `link ${input.sourceId} → ${input.targetId}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const doc = documentFor(s, String(input.sourceId));
          await readable(ctx, doc.area);
          visible(ctx, doc);
          await writable(ctx, doc.area, "create");
          // A hidden target answers like a missing one (the store checks it in the same place, §18.4 a).
          return s.store.addLink(doc.id, String(input.targetId), typeof input.type === "string" ? input.type : "references", actor(ctx), hidden(ctx));
        }),
    },

    research_sources_list: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await readable(ctx, id);
          const area = await readyArea(ctx, s, id, "notebook");
          return { sources: (await notebook.listSources(area.notebookId as string, input.limit ?? 50, input.offset ?? 0)) as unknown as Json };
        }),
    },

    research_source_get: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await readable(ctx, id);
          const area = await readyArea(ctx, s, id, "notebook");
          return (await notebook.getSource(area.notebookId as string, String(input.id))) as Json;
        }),
    },

    research_notes_list: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await readable(ctx, id);
          const area = await readyArea(ctx, s, id, "notebook");
          return { notes: (await notebook.listNotes(area.notebookId as string)) as unknown as Json };
        }),
    },

    research_note_get: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await readable(ctx, id);
          const area = await readyArea(ctx, s, id, "notebook");
          return (await notebook.getNote(area.notebookId as string, String(input.id))) as Json;
        }),
    },

    research_source_add: {
      scope: writeScope,
      redact: (input) => `research source "${String(input.title).slice(0, 60)}"`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await writable(ctx, id, "create");
          const area = await readyArea(ctx, s, id, "notebook");
          return { sourceId: await notebook.addTextSource(area.notebookId as string, String(input.title), String(input.content)) };
        }),
    },

    research_chat_start: {
      scope: writeScope,
      redact: () => "research chat session",
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await writable(ctx, id, "create");
          const area = await readyArea(ctx, s, id, "notebook");
          const model = await knowledge.researchModel(s, ctx);
          return { sessionId: await notebook.createSession(area.notebookId as string, model, input.title) };
        }),
    },

    research_ask: {
      scope: writeScope,
      redact: (input) => `research question (${String(input.message).length} chars)`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await writable(ctx, id, "create");
          const area = await readyArea(ctx, s, id, "notebook");
          const model = await knowledge.researchModel(s, ctx);
          return { answer: (await notebook.ask(area.notebookId as string, String(input.sessionId), model, String(input.message))) as unknown as Json };
        }),
    },

    research_chat_get: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await readable(ctx, id);
          const area = await readyArea(ctx, s, id, "notebook");
          return (await notebook.getSession(area.notebookId as string, String(input.sessionId))) as unknown as Json;
        }),
    },

    collection_get: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const collection = s.store.getCollection(String(input.id));
          if (!collection) throw notFound();
          await readable(ctx, collection.area);
          const count = s.store.listCollections(collection.area, tagFilter(ctx)).find((c) => c.id === collection.id)?.documentCount ?? 0;
          return { ...collection, documentCount: count } as unknown as Json;
        }),
    },

    collection_tree: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const collection = s.store.getCollection(String(input.id));
          if (!collection) throw notFound();
          await readable(ctx, collection.area);
          return { nodes: s.store.tree(collection.id, tagFilter(ctx)) as unknown as Json };
        }),
    },

    collection_delete: {
      scope: anyScope,
      redact: (input) => `delete collection ${input.id}`,
      holdView: (input) => `An agent asks to delete collection ${input.id} and every document in it. The documents leave memory search; revisions stay in backups.`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const collection = s.store.getCollection(String(input.id));
          if (!collection) throw notFound();
          await writable(ctx, collection.area, "delete");
          const { documents } = s.store.deleteCollection(collection.id, actor(ctx));
          knowledge.kick(s);
          return { id: collection.id, deleted: true, documents };
        }),
    },

    link_delete: {
      scope: anyScope,
      redact: (input) => `delete link ${input.id}`,
      holdView: (input) => `An agent asks to remove link ${input.id} between two documents.`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const link = s.store.getLink(String(input.id));
          if (!link) throw notFound();
          await readable(ctx, link.area);
          // §18.4 a: a link with a hidden end is not listed (links_list), so it answers like a missing one.
          for (const end of [link.sourceId, link.targetId]) {
            const doc = s.store.getDocument(end);
            if (!doc) throw notFound();
            visible(ctx, doc);
          }
          await writable(ctx, link.area, "delete");
          s.store.deleteLink(link.id);
          return { id: link.id, deleted: true };
        }),
    },

    research_context_get: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await readable(ctx, id);
          const area = await readyArea(ctx, s, id, "notebook");
          return (await notebook.context(area.notebookId as string)) as unknown as Json;
        }),
    },

    research_source_delete: {
      scope: writeScope,
      redact: (input) => `delete research source ${input.id}`,
      holdView: (input) => `An agent asks to delete research source ${input.id} from ${input.area ?? "its own"} notebook.`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = notebookOf(s);
          const id = defaultArea(ctx, input.area);
          await writable(ctx, id, "delete");
          const area = await readyArea(ctx, s, id, "notebook");
          await notebook.deleteSource(area.notebookId as string, String(input.id));
          return { id: String(input.id), deleted: true };
        }),
    },

    indexing_status: {
      run: (_input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const counts = new Map((s.projector?.status() ?? []).map((row) => [row.area, row]));
          return {
            areas: s.areas.list().map((area) => ({
              id: area.id,
              label: area.label,
              kind: area.kind,
              engineReady: area.sourceReady,
              researchReady: area.notebookId !== null,
              pending: counts.get(area.id)?.pending ?? 0,
              ready: counts.get(area.id)?.ready ?? 0,
              failed: counts.get(area.id)?.failed ?? 0,
            })),
          } as unknown as Json;
        }),
    },
  };

  const engineDynamic: DynamicHandlers = {
    async catalog(query, ctx: HookContext): Promise<DynamicCatalogEntry[]> {
      const s = knowledge.bind(ctx.db, secretsOf(ctx));
      if (!s.engine) return [];
      try {
        const entries = await s.engine.catalog();
        // An engine that answers but matches none of the exposed tools (an upstream surface change) is never silent either.
        if (!entries.length) ctx.log.warn("engine catalog empty", { engine: "gbrain" });
        // C336 M4: `engine` is listed in search mode (engine_search / engine_call); a search ranks the tools by its words.
        return query ? searchCatalog(entries, query.query ?? "", query.limit ?? 20) : entries;
      } catch (error) {
        // C296 (prod): an empty answer was cached by the bridge as "no tools" and nobody was told. Fail instead: the bridge
        // marks the op catalog_failed (status toolsOmitted → Core) and asks again on the next tools/list.
        const failure = engineError(error);
        ctx.log.warn("engine catalog failed", { code: String((failure as { code?: unknown }).code ?? "engine_error").slice(0, 64) });
        throw failure;
      }
    },
    async resolve(tool): Promise<DynamicResolution | null> {
      const op = engineResolve(tool);
      return op ? { tool, crud: op.crud, effect: op.effect, ...(op.holdFamily ? { holdFamily: op.holdFamily } : {}) } : null;
    },
    call: (tool, args, ctx) =>
      wrap(async () => {
        // QA-KN24-2: engine tools are not among APP_CALLER_OPS (`narrowed` guards only the static ops): an app never calls them
        if (isApp(ctx.caller)) throw fail("scope_denied", "an app may only list areas and create or update documents in the company area", 403);
        const s = services(ctx);
        const engine = s.engine;
        if (!engine) throw fail("engine_capability_unavailable", "no memory engine in this deployment", 404);
        const op = engine.resolve(tool);
        if (!op) throw fail("engine_capability_unavailable", "this engine tool is not available", 404);
        // G5: engine pages carry engine-side tags this app cannot match against the narrowing, so a narrowed call is
        // refused, reads and writes alike (§18.2, §18.4 e).
        admit("unsupported", ctx);
        const { area: requested, ...upstreamArgs } = args as In;
        // Writes, stateful reads and model-cost reads run in one area; stateless reads may fan out.
        const single = op.effect !== "read" || op.modelCost || !op.fanOut || typeof requested === "string";
        const call = async (id: string) => {
          const area = await readyArea(ctx, s, id, "source");
          const callArgs = { ...upstreamArgs };
          if (ctx.idempotencyKey && op.effect !== "read" && !("request_id" in callArgs)) {
            callArgs.request_id = deterministicRequestId(op.name, area.sourceId, ctx.caller.id, ctx.idempotencyKey);
          }
          try {
            return await engine.call(area.sourceId, tool, callArgs, ctx.caller.id);
          } catch (error) {
            throw engineError(error);
          }
        };
        if (single) {
          const id = defaultArea(ctx, requested);
          if (op.effect !== "read") await writable(ctx, id, op.crud.includes("delete") ? "delete" : op.crud.includes("create") ? "create" : "update");
          else if (op.modelCost) await writable(ctx, id, "read");
          else await readable(ctx, id);
          return (await call(id)) as Json;
        }
        // C373: the caller's readable areas (person and team areas included for agents), never one an app may not see
        const areas = (await accessOf(ctx).readable(false)).filter((id) => appSees(ctx, id));
        const outcomes = await fanOut(areas, FAN_OUT_LIMIT, call);
        return {
          results: outcomes.filter((outcome) => outcome.ok).map((outcome) => ({ area: outcome.area, data: outcome.value })),
          areas: outcomes.map((outcome) => ({ area: outcome.area, ok: outcome.ok, ...(outcome.error ? { error: outcome.error } : {}) })),
          partial: outcomes.some((outcome) => !outcome.ok),
        } as unknown as Json;
      }),
  };

  const events: AppEvents = {
    async agentAdded(agent, ctx) {
      const s = knowledge.bind(ctx.db);
      await s.areas.ensureShared(ctx.scopes);
      await s.areas.ensureAgentArea(agent, ctx.scopes);
      // C373: Governance may name the new agent's owner now: read the directory again (an event, never inside a call)
      if (ctx.callApp) void syncDirectory(ctx.db, ctx.callApp as never);
      // C296 review: a new agent area gets its engine source in the background too (not only on the agent's first call).
      knowledge.retryProvision(s);
    },
    async keysChanged() {
      const s = knowledge.current();
      if (s) knowledge.forgetResearchModel(s);
      // C373: keys or model roles changed (one keysRev): tb-exec restarts the engine with them; read its models again
      await knowledge.modelsChanged().catch(() => undefined);
    },
  };

  const library = createLibraryHandlers({ knowledge, services, wrap, fail, notFound, recallAcross, readyArea, notebookOf, tagFilter });
  const access = createAccessHandlers({ services, wrap, fail });
  const all = Object.fromEntries(Object.entries({ ...handlers, ...library, ...access }).map(([id, spec]) => [id, narrowed(id, spec)]));
  return { handlers: all, dynamic: { engine: engineDynamic }, events };
}

