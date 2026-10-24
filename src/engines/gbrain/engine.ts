// GBrain adapter: maps an authorized area to its engine source and translates operations.
// Authorization never moves into the engine; callers pass only areas the SDK already allowed.
import type { DynamicCatalogEntry } from "@opt2-tealbrick/spec/manifest";
import type { GBrainClient } from "./client.ts";
import { GBrainServiceError } from "./client.ts";
import { catalogEntries, resolveEntry } from "./exposure.ts";
import { argumentRefusal } from "./guard.ts";
import { neutralizeFenceMarkers, sanitizeResult } from "./privacy.ts";
import { GBrainError } from "./transport.ts";

export const PAGE_PREFIX = "knowledge-docs/";

/**
 * Canonical document id of an engine page slug, or null. Upstream GBrain lower-cases every slug (validateSlug at the
 * pin), so `knowledge-docs/kdoc_<ULID>` comes back as `kdoc_<ulid>`; a ULID is case-insensitive (Crockford base32)
 * and Knowledge writes it upper case, so the id is restored by upper-casing it (QA R4 S3: the tag join missed).
 */
export function documentIdFromSlug(slug: string): string | null {
  if (!slug.toLowerCase().startsWith(PAGE_PREFIX)) return null;
  const match = /^kdoc_([0-9a-hjkmnp-tv-z]{26})$/iu.exec(slug.slice(PAGE_PREFIX.length));
  return match ? `kdoc_${(match[1] as string).toUpperCase()}` : null;
}

export interface RecallRow {
  area: string;
  documentId: string | null;
  slug: string;
  title: string;
  text: string;
  score: number | null;
  /** QA-KNOW17-1: a saved fact the engine adds to a query answer (`result_type: "fact"`, upstream ≥ 0.60.164) */
  factId?: string;
  /** how to read that fact again: the engine's own `follow_up` recall arguments (`entity` or `grep`, never a source) */
  factLookup?: { entity?: string; grep?: string };
}

/** The fact part of an engine row, or null: id and the recall arguments that read it again (source arguments dropped). */
export function factOfRow(row: Record<string, unknown>): { factId: string; factLookup: { entity?: string; grep?: string } } | null {
  if (row.result_type !== "fact" || (typeof row.fact_id !== "string" && typeof row.fact_id !== "number")) return null;
  const args = (row.follow_up && typeof row.follow_up === "object" ? (row.follow_up as { args?: unknown }).args : null) as Record<string, unknown> | null;
  const factLookup: { entity?: string; grep?: string } = {};
  if (args && typeof args.entity === "string" && args.entity) factLookup.entity = args.entity.slice(0, 200);
  else if (args && typeof args.grep === "string" && args.grep) factLookup.grep = args.grep.slice(0, 200);
  return { factId: String(row.fact_id).slice(0, 64), factLookup };
}

export class EngineCallError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const ERROR_STATUS: Record<string, number> = {
  invalid_params: 400,
  permission_denied: 403,
  scope_denied: 403,
  page_not_found: 404,
  revision_conflict: 409,
  rate_limited: 429,
  embedding_failed: 502,
  extraction_failed: 502,
  operation_failed: 502,
  unavailable: 503,
};

/** Map engine failures to the CORE §8 envelope; transport failures stay thrown (a write may have executed). */
export function engineError(error: unknown): EngineCallError {
  if (error instanceof EngineCallError) return error;
  if (error instanceof GBrainServiceError) {
    return error.code === "area_binding_required"
      ? new EngineCallError("area_not_ready", "the memory area is still being prepared in the engine", 503)
      : new EngineCallError("engine_unavailable", "the memory engine is not reachable", 503);
  }
  if (error instanceof GBrainError && error.kind === "tool") {
    const code = error.code ?? "operation_failed";
    return new EngineCallError(`engine_${code}`, error.message, ERROR_STATUS[code] ?? 502);
  }
  return new EngineCallError("engine_unavailable", "the memory engine did not answer", 503);
}

const isRow = (item: unknown): item is Record<string, unknown> =>
  item !== null && typeof item === "object" && !Array.isArray(item) && (typeof (item as Record<string, unknown>).slug === "string" || typeof (item as Record<string, unknown>).chunk_text === "string" || typeof (item as Record<string, unknown>).text === "string");

/**
 * Recall rows of an engine answer, or null when the answer has no recognisable row list (QA F88: an answer that cannot
 * be read is NOT "no results"; the caller falls back to keyword search and reports `degraded`). An empty list is a
 * real empty answer.
 */
export function findRows(data: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 4 || data === null || typeof data !== "object") return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    const rows = data.filter(isRow);
    return rows.length ? rows : null;
  }
  const record = data as Record<string, unknown>;
  for (const key of ["results", "hits", "evidence", "items", "chunks", "pages"]) {
    if (!(key in record)) continue;
    const rows = findRows(record[key], depth + 1);
    if (rows) return rows;
  }
  return null;
}

/** One area's engine recall: rows, and why the engine answered in a degraded way (empty = full hybrid recall). */
export interface RecallAnswer {
  rows: RecallRow[];
  /** recall-affecting degraded stages (`stage` or `stage:reason`) and degraded notice codes; closed upstream vocabularies */
  degraded: string[];
}

/** C296 review: the owner Settings page waits at most this long for the engine's own report. */
export const SETTINGS_DEADLINE_MS = 6_000;

export interface EngineReadiness {
  capability: string;
  state: string;
  reason: string | null;
}

export interface EngineSettings {
  tools: { offered: string[] | null; error: string | null };
  readiness: EngineReadiness[] | null;
  readinessError: string | null;
  surface: string | null;
  counts: { pages: number | null; chunks: number | null; embedded: number | null; version: string | null } | null;
  countsError: string | null;
}

export class GBrainEngine {
  readonly id = "gbrain";
  private readonly client: GBrainClient;
  /** source of an area the catalog may read schemas from (the shared area always exists) */
  private readonly catalogSource: string;

  constructor(client: GBrainClient, catalogSource: string) {
    this.client = client;
    this.catalogSource = catalogSource;
  }

  health() {
    return this.client.health();
  }

  async projectDocument(sourceId: string, documentId: string, markdown: string): Promise<void> {
    await this.client.putCanonicalPage(sourceId, `${PAGE_PREFIX}${documentId}`, neutralizeFenceMarkers(markdown));
  }

  async removeDocument(sourceId: string, documentId: string): Promise<void> {
    await this.client.deleteCanonicalPage(sourceId, `${PAGE_PREFIX}${documentId}`);
  }

  /**
   * Hybrid (or word) search in one area's source; rows normalized and sanitized, with what upstream reported as degraded. An
   * answer without a readable row list throws `engine_unparsable` (the caller falls back, never a silent empty list).
   */
  async recall(area: string, sourceId: string, query: string, limit: number, principalId?: string, tool: "query" | "search" = "query"): Promise<RecallAnswer> {
    // `query` = hybrid search by meaning (recall); `search` = the engine's ranked word search (C336 M4 `search`).
    const answer = await this.client.callAnswer(sourceId, tool, { query, limit }, { ...(principalId ? { principalId } : {}), timeoutMs: 120_000 });
    const found = findRows(sanitizeResult(answer.data, sourceId));
    if (!found) throw new EngineCallError("engine_unparsable", "the memory engine answer could not be read", 502);
    const degraded = [
      ...answer.degraded.map((d) => (d.reason ? `${d.stage}:${d.reason}` : d.stage)),
      ...answer.notices.filter((n) => n.kind === "degraded" && !answer.degraded.length).map((n) => n.code),
    ];
    const rows = found
      .slice(0, limit)
      .map((row) => {
        const slug = typeof row.slug === "string" ? row.slug : "";
        const fact = factOfRow(row);
        return {
          area,
          documentId: fact ? null : documentIdFromSlug(slug),
          slug: fact ? "" : slug,
          title: typeof row.title === "string" ? row.title : slug,
          text: String(row.chunk_text ?? row.text ?? row.snippet ?? "").slice(0, 4000),
          score: typeof row.score === "number" ? row.score : null,
          ...(fact ?? {}),
        };
      });
    return { rows, degraded: [...new Set(degraded)] };
  }

  async catalog(): Promise<DynamicCatalogEntry[]> {
    return catalogEntries(await this.client.tools(this.catalogSource));
  }

  /**
   * C296 owner Settings: what the engine itself reports, each part best effort (a failing part names its error code,
   * never upstream text): the tools agents are offered, the engine's readiness (embeddings, chat model, tool surface)
   * and brain-wide counts (pages, chunks, embedded chunks).
   */
  async settings(deadlineMs = SETTINGS_DEADLINE_MS): Promise<EngineSettings> {
    const codeOf = (error: unknown) => {
      const code = error && typeof error === "object" ? (error as { code?: unknown; kind?: unknown }).code : undefined;
      if (typeof code === "string" && code) return code.slice(0, 64);
      const kind = error && typeof error === "object" ? (error as { kind?: unknown }).kind : undefined;
      return typeof kind === "string" && kind ? `engine_${kind}`.slice(0, 64) : "engine_error";
    };
    // One deadline for the whole page: an engine that accepts and never answers must not hang the owner's Settings.
    const deadline = <T>(promise: Promise<T>) =>
      Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("engine timeout"), { code: "engine_timeout" })), deadlineMs).unref())]);
    const [tools, caps, stats] = await Promise.allSettled([deadline(this.catalog()), deadline(this.client.capabilities(this.catalogSource)), deadline(this.client.fullStats())]);
    const readiness: EngineReadiness[] = [];
    let surface: string | null = null;
    if (caps.status === "fulfilled" && caps.value && typeof caps.value === "object") {
      const value = caps.value as Record<string, unknown>;
      surface = typeof value.surface === "string" ? value.surface.slice(0, 32) : null;
      for (const entry of Array.isArray(value.readiness) ? value.readiness : []) {
        if (!entry || typeof entry !== "object") continue;
        const { capability, state, reason } = entry as Record<string, unknown>;
        if (typeof capability === "string" && typeof state === "string") readiness.push({ capability: capability.slice(0, 32), state: state.slice(0, 32), reason: typeof reason === "string" ? reason.slice(0, 64) : null });
      }
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const counts = stats.status === "fulfilled" ? stats.value : null;
    return {
      tools: tools.status === "fulfilled" ? { offered: tools.value.map((entry) => entry.name), error: null } : { offered: null, error: codeOf(tools.reason) },
      readiness: caps.status === "fulfilled" ? readiness : null,
      readinessError: caps.status === "rejected" ? codeOf(caps.reason) : null,
      surface,
      counts: counts ? { pages: num(counts.page_count), chunks: num(counts.chunk_count), embedded: num(counts.embedded_count), version: typeof counts.version === "string" ? counts.version.slice(0, 32) : null } : null,
      countsError: stats.status === "rejected" ? codeOf(stats.reason) : null,
    };
  }

  resolve(entryName: string) {
    return resolveEntry(entryName);
  }

  /** One native call in one area's source, after the argument guard; result sanitized. */
  async call(sourceId: string, entryName: string, args: Record<string, unknown>, principalId: string): Promise<unknown> {
    const op = resolveEntry(entryName);
    if (!op) throw new EngineCallError("engine_capability_unavailable", "this engine tool is not available", 404);
    const refusal = argumentRefusal(op.name, args);
    if (refusal) throw new EngineCallError("argument_refused", refusal, 400);
    const data = await this.client.call(sourceId, op.name, args, { principalId, timeoutMs: op.long ? 300_000 : 60_000 });
    return sanitizeResult(data, sourceId);
  }

  /** Provision the engine source of an area through the C6 helper (idempotent upstream: an existing id is fine). */
  static sourceRequest(sourceId: string, label: string) {
    return { id: sourceId, name: `knowledge-${label}`.slice(0, 64) };
  }
}
