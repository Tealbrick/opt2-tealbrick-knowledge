// Operation handlers, registered by operation id (the manifest is the only route/schema source).
// Authorization: the SDK has already run gate() at the bridge and authorize() in the app
// (grant CRUD ∩ op CRUD ∩ best area access). Handlers bind each call to concrete areas and check
// access per area with ctx.scope; an area the caller may not read answers like a missing one.
import type { CrudAction, DynamicCatalogEntry, DynamicResolution } from "@opt2-tealbrick/spec/manifest";
import type { AppEvents, Caller, DynamicHandlers, HandlerSpec, HookContext, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { AREA_SCOPE, type Area } from "./areas.ts";
import { deterministicRequestId } from "./engines/gbrain/client.ts";
import { EngineCallError, engineError, type RecallRow } from "./engines/gbrain/engine.ts";
import { resolveEntry as engineResolve } from "./engines/gbrain/exposure.ts";
import { NotebookError } from "./engines/notebook/client.ts";
import { agentAreaId } from "./ids.ts";
import type { AppSecrets, Knowledge, Services } from "./knowledge.ts";
import { createLibraryHandlers } from "./library.ts";
import { fanOut, mergeRanked } from "./merge.ts";
import { NARROWING_UNSUPPORTED, NARROWING_VIOLATION, type Narrowing, NarrowingError, readNarrowing, type TagFilter, tagsPass, untaggedPass } from "./narrowing.ts";
import { cleanTags, StoreError } from "./store/documents.ts";

/** The SDK's error class (CORE §8 envelope); injected so this module only depends on frozen types. */
export type ErrorFactory = new (code: string, message: string, httpStatus?: number) => Error;

type In = Record<string, any>;

export function ownArea(caller: Caller): string | null {
  return caller.type === "agent" ? agentAreaId(caller.id) : null;
}
const writeScope = (input: In, caller: Caller) => (typeof input.area === "string" ? input.area : ownArea(caller));
const readScope = (input: In) => (typeof input.area === "string" ? input.area : null);
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
export const NARROWING_POLICY: Readonly<Record<string, "items" | "untagged" | "none">> = {
  // reads
  recall: "items",
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
        admit(NARROWING_POLICY[id] ?? "unsupported", ctx);
        return run(input, ctx);
      },
    };
  }
  /** True when the call's narrowing hides the document (§18.1 tagsMatch). */
  const hidden = (ctx: OpContext) => (doc: { tags: string[] }) => !tagsPass(doc.tags, tagFilter(ctx));
  /** A document the narrowing hides answers like a missing one (reads, and writes that address it: §18.4 a). */
  function visible(ctx: OpContext, doc: { tags: string[] }): void {
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

  async function readable(ctx: OpContext, area: string): Promise<void> {
    if (!(await ctx.scope.can(AREA_SCOPE, area, "read"))) throw notFound();
  }
  async function writable(ctx: OpContext, area: string, crud: CrudAction): Promise<void> {
    await readable(ctx, area);
    if (!(await ctx.scope.can(AREA_SCOPE, area, crud))) throw fail("scope_denied", `no ${crud} access to area ${area}`, 403);
  }
  async function targetAreas(ctx: OpContext, area: unknown): Promise<string[]> {
    if (typeof area === "string") {
      await readable(ctx, area);
      return [area];
    }
    return ctx.scope.readable(AREA_SCOPE);
  }
  function defaultArea(ctx: OpContext, area: unknown): string {
    const id = typeof area === "string" ? area : ownArea(ctx.caller);
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
  async function recallAcross(s: Services, ctx: OpContext, areas: string[], query: string, limit: number) {
    const engine = s.engine;
    const filter = tagFilter(ctx);
    // A narrowing drops rows after the engine ranked them: ask for more so a narrowed answer is not needlessly short.
    const engineLimit = filter ? Math.min(limit * 3, 50) : limit;
    if (engine) await knowledge.provision(s, ctx).catch(() => undefined);
    const outcomes = await fanOut(areas, FAN_OUT_LIMIT, async (id) => {
      const area = s.areas.get(id);
      if (!engine || !area?.sourceReady) throw Object.assign(new Error("not ready"), { code: engine ? "area_not_ready" : "no_engine" });
      return engine.recall(id, area.sourceId, query, engineLimit, ctx.caller.id);
    });
    type TaggedRow = RecallRow & { tags: string[] };
    const lists: { area: string; rows: TaggedRow[] }[] = [];
    const statuses: { area: string; ok: boolean; via: "engine" | "keyword"; error?: string; degraded?: string[] }[] = [];
    const keyword = (area: string): TaggedRow[] =>
      s.store.search({ areas: [area], query, limit, tags: filter }).map((hit) => ({ area: hit.area, documentId: hit.id, slug: "", title: hit.title, text: hit.excerpt, score: null, tags: hit.tags }));
    for (const outcome of outcomes) {
      if (outcome.ok && outcome.value) {
        const { rows, degraded } = outcome.value;
        const known = s.store.tagsOf(rows.flatMap((row) => (row.documentId ? [row.documentId] : [])));
        const tagged = rows.flatMap((row): TaggedRow[] => {
          const tags = row.documentId ? known.get(row.documentId) : undefined;
          if (filter && (!tags || !tagsPass(tags, filter))) return [];
          return [{ ...row, tags: tags ?? [] }];
        });
        lists.push({ area: outcome.area, rows: tagged });
        if (degraded.length) {
          // The engine ran without part of its pipeline: add the keyword search so a degraded engine never hides a memory.
          lists.push({ area: outcome.area, rows: keyword(outcome.area) });
          statuses.push({ area: outcome.area, ok: true, via: "engine", degraded });
        } else statuses.push({ area: outcome.area, ok: true, via: "engine" });
      } else {
        lists.push({ area: outcome.area, rows: keyword(outcome.area) });
        statuses.push({ area: outcome.area, ok: true, via: "keyword", ...(outcome.error ? { error: outcome.error } : {}) });
      }
    }
    const fallbacks = statuses.filter((status) => status.via === "keyword");
    const engineDegraded = statuses.flatMap((status) => status.degraded ?? []);
    if (engine) {
      const failed = fallbacks.filter((f) => f.error && f.error !== "area_not_ready" && f.error !== "no_engine");
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
      redact: (input, output) => `remembered ${String(input.text).length} chars in ${(output as In | undefined)?.area ?? input.area ?? "own area"}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const area = defaultArea(ctx, input.area);
          await writable(ctx, area, "create");
          if (!s.areas.get(area)) throw notFound();
          resultVisible(ctx, cleanTags(input.tags));
          const text = String(input.text);
          const firstLine = text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "Memory";
          const doc = s.store.createDocument({
            area,
            title: (typeof input.title === "string" ? input.title : firstLine).slice(0, 200),
            body: text,
            status: "published",
            tags: input.tags,
            actor: actor(ctx),
          });
          await knowledge.provision(s, ctx).catch(() => undefined);
          knowledge.kick(s);
          return { documentId: doc.id, area, version: doc.version };
        }),
    },

    areas_list: {
      scope: anyScope,
      run: (_input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const own = ownArea(ctx.caller);
          const out = [];
          for (const area of s.areas.list()) {
            if (!(await ctx.scope.can(AREA_SCOPE, area.id, "read"))) continue;
            const write = await ctx.scope.can(AREA_SCOPE, area.id, "create");
            out.push({ id: area.id, label: area.label, kind: area.kind, own: area.id === own, access: write ? "read_write" : "read" });
          }
          return { areas: out };
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
          const hits = services(ctx).store.search({ areas, query: input.query, collectionId: input.collectionId, limit: input.limit, tags: tagFilter(ctx) });
          return { hits: hits as unknown as Json };
        }),
    },

    document_get: {
      scope: anyScope,
      run: (input, ctx) =>
        wrap(async () => {
          const doc = documentFor(services(ctx), String(input.id));
          await readable(ctx, doc.area);
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
          await readable(ctx, doc.area);
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
          await readable(ctx, doc.area);
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
          await readable(ctx, doc.area);
          visible(ctx, doc);
          return s.store.listLinks(doc.id, tagFilter(ctx)) as unknown as Json;
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
    async catalog(_query, ctx: HookContext): Promise<DynamicCatalogEntry[]> {
      const s = knowledge.bind(ctx.db, secretsOf(ctx));
      if (!s.engine) return [];
      try {
        const entries = await s.engine.catalog();
        // An engine that answers but matches none of the exposed tools (an upstream surface change) is never silent either.
        if (!entries.length) ctx.log.warn("engine catalog empty", { engine: "gbrain" });
        return entries;
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
        const areas = await ctx.scope.readable(AREA_SCOPE);
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
      // C296 review: a new agent area gets its engine source in the background too (not only on the agent's first call).
      knowledge.retryProvision(s);
    },
    async keysChanged() {
      const s = knowledge.current();
      if (s) knowledge.forgetResearchModel(s);
    },
  };

  const library = createLibraryHandlers({ knowledge, services, wrap, fail, notFound, recallAcross, readyArea, notebookOf, tagFilter });
  const all = Object.fromEntries(Object.entries({ ...handlers, ...library }).map(([id, spec]) => [id, narrowed(id, spec)]));
  return { handlers: all, dynamic: { engine: engineDynamic }, events };
}

