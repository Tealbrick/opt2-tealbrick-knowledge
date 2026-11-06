// Foundry tools (C373, C322(2)): agents read company data that Foundry (helix-foundry, the `deep` companion) holds.
// Every result comes from Knowledge documents the deep feed handed over (src/engines/deep/sync.ts) and is checked
// against the caller here: the area must be readable, and under a Rules tag narrowing only rows and documents whose
// source documents pass the tags are returned (deep_search, deep_status). deep_ask runs foundry's analyst over the whole
// area, so it refuses a tag narrowing (as `ask`). All read-only: no tool writes to foundry.
import type { HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { type DeepClient, type DeepDataset, DeepError, type DeepRun, type DeepServiceStatus } from "./engines/deep/client.ts";
import { DEEP_AREAS_ALLOWED, type DeepSync, SOURCE_COLUMN, TABLE_TAG } from "./engines/deep/sync.ts";
import { SHARED_AREA_ID } from "./ids.ts";
import type { Knowledge, Services } from "./knowledge.ts";
import { type TagFilter, tagsPass } from "./narrowing.ts";
import { type Document, documentCitation } from "./store/documents.ts";

type In = Record<string, any>;

export const NEEDS_MODEL = "Foundry chat needs a reasoning model: set one in Keys and models.";
const SEARCH_INSTEAD = "deep_search finds rows and documents by words without a model.";
/** How long one deep_ask call waits for foundry's analyst before it hands back the run id. */
export const ASK_WAIT_MS = 60_000;
const ASK_POLL_MS = 1000;
const MAX_ROWS = 50;
const MAX_WORDS = 6;

export interface DeepDeps {
  knowledge: Knowledge;
  services(ctx: OpContext): Services;
  wrap<T>(fn: () => Promise<T>): Promise<T>;
  fail(code: string, message: string, status: number): Error;
  notFound(): Error;
  /** throws not_found when the caller may not read the area (the handlers' own check) */
  readable(ctx: OpContext, area: string): Promise<void>;
  tagFilter(ctx: OpContext): TagFilter | null;
  /** tests: shorter waits */
  askWaitMs?: number;
  askPollMs?: number;
}

/** Search words: letters, digits and `@ . _ : -` only (no quote can reach the SQL), at most 6, each ≤ 50 chars. */
export function searchWords(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/u)
        .map((w) => w.replace(/[^\p{L}\p{N}@._:-]/gu, "").slice(0, 50))
        .filter((w) => w.length > 0),
    ),
  ].slice(0, MAX_WORDS);
}

const quoteIdent = (name: string) => `"${name.replace(/"/gu, '""')}"`;
const tableOf = (dataset: DeepDataset) => dataset.data?.table ?? `d_${dataset.id.replace(/-/gu, "")}`;

/** Every word must appear in at least one of the columns (case-insensitive substring; `contains` has no wildcards). */
export function matchSql(table: string, columns: readonly string[], words: readonly string[], limit: number, select = "*"): string {
  const cond = words.map((w) => `(${columns.map((c) => `contains(lower(CAST(${quoteIdent(c)} AS VARCHAR)), '${w}')`).join(" OR ")})`).join(" AND ");
  return `SELECT ${select} FROM ${quoteIdent(table)} WHERE ${cond} LIMIT ${Math.max(1, Math.min(limit, 200))}`;
}

function excerpt(body: string, words: readonly string[]): string {
  const lower = body.toLowerCase();
  const at = Math.max(0, ...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).slice(0, 1));
  const start = Math.max(0, at - 120);
  return `${start > 0 ? "…" : ""}${body.slice(start, start + 360).replace(/\s+/gu, " ").trim()}${start + 360 < body.length ? "…" : ""}`;
}

export function createDeepHandlers(d: DeepDeps): Record<string, HandlerSpec<In, Json>> {
  const { knowledge, services, wrap, fail, notFound, readable, tagFilter } = d;
  const readScope = (input: In) => (typeof input.area === "string" ? input.area : null);

  function deepOf(s: Services): { deep: DeepClient; sync: DeepSync } {
    if (!s.deep || !s.deepSync) throw fail("deep_disabled", "Foundry (deep knowledge) is not part of this deployment", 409);
    return { deep: s.deep, sync: s.deepSync };
  }

  /** The Foundry areas the caller may read: the named one, or every selected area it can read. */
  async function deepAreas(ctx: OpContext, sync: DeepSync, area: unknown): Promise<string[]> {
    const selected = sync.selectedAreas();
    if (typeof area === "string") {
      await readable(ctx, area);
      if (!DEEP_AREAS_ALLOWED.includes(area)) throw fail("deep_area_unsupported", "Foundry holds only the company area today", 409);
      return selected.includes(area) ? [area] : [];
    }
    const out: string[] = [];
    for (const id of selected) {
      try {
        await readable(ctx, id);
        out.push(id);
      } catch {
        // not readable: left out
      }
    }
    return out;
  }

  /** A live document of the area whose tags pass the caller's narrowing (null = hidden or gone). */
  function visibleDoc(s: Services, ctx: OpContext, area: string, id: unknown): Document | null {
    if (typeof id !== "string" || !id) return null;
    const doc = s.store.getDocument(id);
    if (!doc || doc.area !== area || !tagsPass(doc.tags, tagFilter(ctx))) return null;
    return doc;
  }

  const cite = (doc: Document) => ({ documentId: doc.id, title: doc.title, ref: { kind: "document", id: doc.id }, source: documentCitation(doc) });

  /** Tables of an area the caller may read whole: synced, and every source document visible. */
  function visibleTables(s: Services, ctx: OpContext, sync: DeepSync, area: string) {
    return sync.tables(area).filter((t) => t.state === "synced" && t.datasetId && t.documentIds.length && t.documentIds.every((id) => visibleDoc(s, ctx, area, id)));
  }

  async function modelState(deep: DeepClient): Promise<DeepServiceStatus["model"]> {
    return (await deep.status()).model;
  }

  function noModelMessage(model: DeepServiceStatus["model"]): string {
    if (model.state === "failed") return `Foundry chat could not use the reasoning model (${model.error ?? "failed"}). Check it in Keys and models. ${SEARCH_INSTEAD}`.slice(0, 500);
    if (model.state === "pending") return `Foundry is still checking the reasoning model; try again in a minute. ${SEARCH_INSTEAD}`;
    if (model.state === "unknown") return `Foundry did not say whether it has a reasoning model; try again in a minute. ${SEARCH_INSTEAD}`;
    return `${NEEDS_MODEL} ${SEARCH_INSTEAD}`;
  }

  return {
    deep_search: {
      scope: readScope,
      redact: (input) => `deep_search (${String(input.query).length} chars)`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const { deep, sync } = deepOf(s);
          const words = searchWords(String(input.query));
          if (!words.length) throw fail("invalid_input", "the query has no searchable words", 400);
          const limit = Math.min(Number(input.limit ?? 20), MAX_ROWS);
          const onlyTable = typeof input.table === "string" ? input.table : null;
          const results: Json[] = [];
          const statuses: Json[] = [];
          for (const area of await deepAreas(ctx, sync, input.area)) {
            const ws = sync.area(area);
            if (!ws) {
              statuses.push({ area, ok: true, synced: false });
              continue;
            }
            try {
              const datasets = new Map((await deep.datasets(ws.workspaceId)).map((ds) => [ds.id, ds]));
              for (const table of visibleTables(s, ctx, sync, area)) {
                if (onlyTable && table.name !== onlyTable) continue;
                const ds = datasets.get(table.datasetId as string);
                const columns = (ds?.data?.profile?.columns ?? []).map((c) => c.name);
                if (!ds || !columns.length) continue;
                const { rows } = await deep.query(ws.workspaceId, [ds.id], matchSql(tableOf(ds), columns, words, limit));
                for (const row of rows.slice(0, limit)) {
                  const doc = visibleDoc(s, ctx, area, row[SOURCE_COLUMN]);
                  if (!doc) continue;
                  const { [SOURCE_COLUMN]: _source, ...values } = row;
                  results.push({ kind: "row", area, table: table.name, row: values as Json, ...cite(doc) } as unknown as Json);
                }
              }
              const text = ws.textDatasetId ? datasets.get(ws.textDatasetId) : undefined;
              if (text && !onlyTable) {
                const sql = matchSql(tableOf(text), ["title", "tags", "body"], words, limit * 3, "document_id");
                const { rows } = await deep.query(ws.workspaceId, [text.id], sql);
                for (const row of rows) {
                  const doc = visibleDoc(s, ctx, area, row.document_id);
                  if (!doc || doc.tags.includes(TABLE_TAG)) continue;
                  results.push({ kind: "document", area, tags: doc.tags, excerpt: excerpt(doc.body, words), ...cite(doc) } as unknown as Json);
                }
              }
              statuses.push({ area, ok: true, synced: true });
            } catch (error) {
              if (!(error instanceof DeepError)) throw error;
              statuses.push({ area, ok: false, error: error.code });
            }
          }
          return { results: results.slice(0, limit), areas: statuses, partial: statuses.some((st) => (st as In).ok === false) } as unknown as Json;
        }),
    },

    deep_ask: {
      scope: readScope,
      redact: (input) => (input.runId ? `deep_ask run ${String(input.runId).slice(0, 40)}` : `deep_ask (${String(input.question ?? "").length} chars)`),
      run: (input, ctx) =>
        wrap(async (): Promise<Json> => {
          const s = services(ctx);
          const { deep, sync } = deepOf(s);
          const area = typeof input.area === "string" ? input.area : SHARED_AREA_ID;
          await readable(ctx, area);
          if (!DEEP_AREAS_ALLOWED.includes(area)) throw fail("deep_area_unsupported", "Foundry holds only the company area today", 409);
          if (typeof input.question !== "string" && typeof input.runId !== "string") throw fail("invalid_input", "send a question, or the runId of an earlier deep_ask", 400);
          const ws = sync.selectedAreas().includes(area) ? sync.area(area) : null;
          if (!ws) return { area, answered: false, status: "not_synced", message: "Foundry has not received this area's documents yet. Try again in a minute." };
          let run: DeepRun;
          if (typeof input.runId === "string") {
            try {
              run = await deep.getRun(ws.workspaceId, input.runId);
            } catch (error) {
              if (error instanceof DeepError && error.code === "deep_not_found") throw notFound();
              throw error;
            }
          } else {
            const model = await modelState(deep);
            if (model.state !== "ok") return { area, answered: false, status: "no_model", message: noModelMessage(model), model: model as unknown as Json };
            try {
              run = await deep.startRun(ws.workspaceId, String(input.question));
            } catch (error) {
              // the proxy's second line (409 deep_model_off): the model went away between the two calls
              if (error instanceof DeepError && error.code === "deep_conflict") return { area, answered: false, status: "no_model", message: noModelMessage({ state: "unset" }) };
              throw error;
            }
          }
          const deadline = Date.now() + (d.askWaitMs ?? ASK_WAIT_MS);
          while (!["succeeded", "failed", "canceled", "awaiting_review"].includes(run.data?.status ?? "") && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, d.askPollMs ?? ASK_POLL_MS));
            run = await deep.getRun(ws.workspaceId, run.id);
          }
          const status = run.data?.status ?? "unknown";
          if (status === "failed" || status === "canceled") return { area, answered: false, status, runId: run.id, message: `Foundry could not answer: ${String(run.data?.error ?? status).slice(0, 200)}` };
          const answer = run.data?.answer;
          if (status !== "succeeded" || !answer) return { area, answered: false, status, runId: run.id, message: "Foundry is still working on it. Call deep_ask again with this runId." };
          // citations: the datasets the query read (tables → their documents) and the source documents named in the rows
          const tables = sync.tables(area);
          const ids = new Set<string>();
          const inputs = Array.isArray(answer.inputs) ? answer.inputs.map(String) : [];
          for (const cited of Array.isArray(answer.citations) ? (answer.citations as { datasetId?: unknown }[]) : []) if (typeof cited.datasetId === "string") inputs.push(cited.datasetId);
          for (const t of tables) {
            const tableName = t.datasetId ? `d_${t.datasetId.replace(/-/gu, "")}` : "";
            if (t.datasetId && (inputs.includes(t.datasetId) || inputs.includes(tableName))) for (const id of t.documentIds) ids.add(id);
          }
          const rows = Array.isArray(answer.rows) ? (answer.rows as In[]).slice(0, MAX_ROWS) : [];
          for (const row of rows) for (const key of [SOURCE_COLUMN, "document_id"]) if (typeof row[key] === "string") ids.add(row[key]);
          const citations = [...ids].flatMap((id) => {
            const doc = visibleDoc(s, ctx, area, id);
            return doc ? [cite(doc)] : [];
          });
          return {
            area,
            answered: true,
            status,
            runId: run.id,
            ...(typeof answer.title === "string" ? { title: answer.title.slice(0, 300) } : {}),
            ...(typeof answer.summary === "string" ? { summary: answer.summary.slice(0, 4000) } : {}),
            ...(typeof answer.sql === "string" ? { sql: answer.sql.slice(0, 20_000) } : {}),
            rows: rows as Json[],
            ...(typeof answer.total === "number" ? { total: Math.trunc(answer.total) } : {}),
            assumptions: (Array.isArray(answer.assumptions) ? answer.assumptions.map((a) => String(a).slice(0, 500)).slice(0, 20) : []) as Json[],
            citations: citations.slice(0, 50) as unknown as Json[],
          };
        }),
    },

    deep_status: {
      scope: readScope,
      run: (input, ctx) =>
        wrap(async (): Promise<Json> => {
          const s = services(ctx);
          if (!s.deep || !s.deepSync) return { enabled: false, areas: [] };
          const { deep, sync } = deepOf(s);
          const health = knowledge.deepHealthNow();
          const areas: Json[] = [];
          for (const area of await deepAreas(ctx, sync, input.area)) {
            const ws = sync.area(area);
            const documents = s.db
              .prepare("SELECT tags FROM kn_documents WHERE area_id = ? AND deleted_at IS NULL")
              .all(area)
              .map((row) => JSON.parse(String(row.tags ?? "[]")) as string[])
              .filter((tags) => !tags.includes(TABLE_TAG) && tagsPass(tags, tagFilter(ctx))).length;
            areas.push({
              area,
              label: s.areas.get(area)?.label ?? area,
              synced: ws?.syncedAt != null,
              syncedAt: ws?.syncedAt ? new Date(ws.syncedAt).toISOString() : null,
              error: ws?.lastError ?? null,
              tables: visibleTables(s, ctx, sync, area).map((t) => ({ name: t.name, rows: t.rows, syncedAt: t.syncedAt ? new Date(t.syncedAt).toISOString() : null })),
              documents,
            } as unknown as Json);
          }
          return { enabled: true, health: (health ?? { ok: false, status: "unknown", phase: "" }) as unknown as Json, model: (await modelState(deep)) as unknown as Json, areas };
        }),
    },

    deep_settings_set: {
      redact: (input) => `Foundry areas: ${Array.isArray(input.areas) ? input.areas.join(", ") || "none" : "?"}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const { sync } = deepOf(s);
          const wanted = Array.isArray(input.areas) ? (input.areas as string[]).map(String) : [];
          const other = wanted.filter((id) => !DEEP_AREAS_ALLOWED.includes(id));
          if (other.length) throw fail("deep_area_unsupported", `Foundry reads only the company area today (not ${other.join(", ").slice(0, 120)}); person, team and agent areas stay out so no answer mixes memories of different people`, 409);
          const areas = sync.setSelectedAreas(wanted);
          if (input.syncNow !== false) void sync.run().catch(() => undefined);
          ctx.receipt.summary(`Foundry reads ${areas.length ? areas.join(", ") : "no area (feed paused)"}`);
          return { areas };
        }),
    },
  };
}

/** The Foundry block of the owner's Settings page. */
export async function deepOverview(knowledge: Knowledge, s: Services): Promise<Json> {
  if (!s.deep || !s.deepSync) return { enabled: knowledge.config.deep, running: false, allowedAreas: [...DEEP_AREAS_ALLOWED] } as unknown as Json;
  const sync = s.deepSync;
  const selected = sync.selectedAreas();
  const model = (await s.deep.status()).model;
  return {
    enabled: true,
    running: true,
    health: knowledge.deepHealthNow(),
    model,
    allowedAreas: [...DEEP_AREAS_ALLOWED],
    areas: DEEP_AREAS_ALLOWED.filter((id) => s.areas.get(id)).map((id) => {
      const ws = sync.area(id);
      const tables = sync.tables(id);
      return {
        id,
        label: s.areas.get(id)?.label ?? id,
        selected: selected.includes(id),
        syncedAt: ws?.syncedAt ?? null,
        error: ws?.lastError ?? null,
        tables: tables.filter((t) => t.state === "synced").map((t) => ({ name: t.name, rows: t.rows, documents: t.documentIds.length })),
        failedTables: tables.filter((t) => t.state === "failed").map((t) => ({ name: t.name, error: t.lastError })),
        textDocuments: Boolean(ws?.textDatasetId),
      };
    }),
  } as unknown as Json;
}
