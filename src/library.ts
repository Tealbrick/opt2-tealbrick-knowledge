// Person (owner) operations behind the Knowledge UI: browse and curate memory in every area.
// Person ops run only from the app UI in a person session (launch ticket); in opt2 only the workspace owner holds one,
// and the owner may read and curate every area (agents stay limited to their area grants).

import { readFileSync } from "node:fs";
import type { HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import type { Area } from "./areas.ts";
import { PROVIDER_MODELS } from "./config.ts";
import type { EngineSettings } from "./engines/gbrain/engine.ts";
import { ENTRY_PREFIX } from "./engines/gbrain/exposure.ts";
import type { NotebookClient } from "./engines/notebook/client.ts";
import type { Knowledge, Services } from "./knowledge.ts";
import type { TagFilter } from "./narrowing.ts";

type In = Record<string, any>;

export interface LibraryDeps {
  knowledge: Knowledge;
  services(ctx: OpContext): Services;
  wrap<T>(fn: () => Promise<T>): Promise<T>;
  fail(code: string, message: string, status: number): Error;
  notFound(): Error;
  recallAcross(s: Services, ctx: OpContext, areas: string[], query: string, limit: number): Promise<unknown>;
  readyArea(ctx: OpContext, s: Services, id: string, need: "source" | "notebook"): Promise<Area>;
  notebookOf(s: Services): NotebookClient;
  /** G5 narrowing tag filter the call was admitted with (null = none) */
  tagFilter(ctx: OpContext): TagFilter | null;
}

/** The engine setting's choices as the manifest declares them (GBrain; Hindsight disabled "soon"), for the Settings page. */
const ENGINE_CHOICES = (() => {
  const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as { settings?: { steps?: { fields?: { key: string; choices?: { value: string; label: string; note?: string; disabled?: boolean }[] }[] }[] } };
  const field = (manifest.settings?.steps ?? []).flatMap((step) => step.fields ?? []).find((f) => f.key === "engine");
  return (field?.choices ?? []).map((c) => ({ value: c.value, label: c.label, ...(c.note ? { note: c.note } : {}), ...(c.disabled ? { disabled: true } : {}) }));
})();

type CapabilityState = "on" | "off" | "unknown";

/**
 * C296 (Martin): GBrain capabilities on/off with what each needs. From the engine's own readiness and the tools agents are
 * offered; dream and autopilot are GBrain background cycles that this deployment does not run (`gbrain serve` only), the
 * reranker needs a Voyage key Knowledge does not declare, agent runs need the engine's agent scope (not exposed).
 */
export function engineCapabilities(running: boolean, report: EngineSettings | null): { id: string; label: string; state: CapabilityState; reason: string }[] {
  const offered = report?.tools.offered ? new Set(report.tools.offered) : null;
  const has = (...ops: string[]) => (offered ? ops.some((op) => offered.has(`${ENTRY_PREFIX}${op}`)) : null);
  const chat = report?.readiness?.find((r) => r.capability === "chat_llm") ?? null;
  const toolState = (ops: string[], needsChat: boolean): { state: CapabilityState; reason: string } => {
    if (!running) return { state: "off", reason: "No memory engine runs." };
    const listed = has(...ops);
    if (listed === null) return { state: "unknown", reason: "The engine tools could not be read." };
    if (!listed) return { state: "off", reason: "Not offered by the engine to agents." };
    if (needsChat && chat && chat.state !== "ok") return { state: "off", reason: "Needs a chat model key (ANTHROPIC_API_KEY or OPENAI_API_KEY) in the engine." };
    if (needsChat && !chat) return { state: "unknown", reason: "Needs a chat model key; the engine did not report it." };
    return { state: "on", reason: needsChat ? "Uses the chat model key." : "No model key needed." };
  };
  return [
    { id: "entities", label: "Entities (people, companies)", ...toolState(["entity"], false) },
    { id: "timeline", label: "Timeline", ...toolState(["get_timeline", "add_timeline_entry"], false) },
    { id: "think", label: "Think", ...toolState(["think"], true) },
    { id: "synthesize", label: "Synthesize", ...toolState(["synthesize"], true) },
    { id: "dream", label: "Dream (background)", state: "off", reason: "A GBrain background cycle; this deployment does not run it. It also needs a chat model key." },
    { id: "autopilot", label: "Autopilot (background)", state: "off", reason: "A GBrain background cycle; this deployment does not run it. It also needs a chat model key." },
    { id: "agent_run", label: "Agent runs", state: "off", reason: "Needs the engine's agent permission, which Knowledge does not give to agents. It also needs a chat model key." },
    { id: "reranker", label: "Reranker", state: "off", reason: "Needs VOYAGE_API_KEY, which is not a Knowledge key yet." },
  ];
}

export function createLibraryHandlers(d: LibraryDeps): Record<string, HandlerSpec<In, Json>> {
  const { knowledge, services, wrap, notFound } = d;
  const actor = (ctx: OpContext) => ctx.caller.id;
  const area = (s: Services, id: unknown) => {
    const found = typeof id === "string" ? s.areas.get(id) : null;
    if (!found) throw notFound();
    return found;
  };
  const doc = (s: Services, id: unknown) => {
    const found = s.store.getDocument(String(id));
    if (!found) throw notFound();
    return found;
  };
  const json = (value: unknown) => value as Json;

  return {
    /** C296 (Martin): one owner Settings view: engine, models and key names, embeddings, capabilities, areas. */
    settings_overview: {
      run: (_input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const config = knowledge.config;
          const health = knowledge.engineStatus();
          const report = s.engine ? await s.engine.settings().catch(() => null) : null;
          const counts = s.store.countsByArea();
          const projection = new Map((s.projector?.status() ?? []).map((row) => [row.area, row]));
          const areas = s.areas.list().map((a) => ({
            id: a.id,
            label: a.label,
            kind: a.kind,
            engineReady: a.sourceReady,
            documents: counts.get(a.id)?.documents ?? 0,
            ready: projection.get(a.id)?.ready ?? 0,
            pending: projection.get(a.id)?.pending ?? 0,
            failed: projection.get(a.id)?.failed ?? 0,
          }));
          const sum = (key: "documents" | "ready" | "pending" | "failed") => areas.reduce((n, a) => n + a[key], 0);
          const models = PROVIDER_MODELS[config.modelProvider];
          const embeddings = report?.readiness?.find((r) => r.capability === "embeddings") ?? null;
          return json({
            engine: { configured: config.engine, running: s.engine !== null, choices: ENGINE_CHOICES, state: health.state, detail: health.detail, attention: knowledge.attention(), version: report?.counts?.version ?? null },
            research: config.research,
            models: { provider: config.modelProvider, chatModel: models.chatModel, embeddingProvider: models.embeddingProvider, embeddingModel: models.embeddingModel, keys: models.keys },
            documents: { total: sum("documents"), inEngine: sum("ready"), waiting: sum("pending"), failed: sum("failed") },
            embeddings: {
              chunks: report?.counts?.chunks ?? null,
              embedded: report?.counts?.embedded ?? null,
              pages: report?.counts?.pages ?? null,
              readiness: embeddings ? { state: embeddings.state, reason: embeddings.reason } : null,
              error: report?.countsError ?? null,
            },
            tools: { offered: report?.tools.offered?.length ?? null, error: report?.tools.error ?? null, surface: report?.surface ?? null },
            capabilities: engineCapabilities(s.engine !== null, report),
            areas,
          });
        }),
    },

    library_overview: {
      run: (_input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const counts = s.store.countsByArea();
          return json({
            // QA F89: the owner sees a degraded or failing memory engine in the app too (not only in Portal).
            engine: { ...knowledge.engineStatus(), attention: knowledge.attention() },
            areas: s.areas.list().map((a) => ({
              id: a.id,
              label: a.label,
              kind: a.kind,
              documents: counts.get(a.id)?.documents ?? 0,
              collections: counts.get(a.id)?.collections ?? 0,
              engineReady: a.sourceReady,
              researchReady: a.notebookId !== null,
            })),
          });
        }),
    },

    library_collections: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return json({ collections: s.store.listCollections(area(s, input.area).id) });
        }),
    },

    library_documents: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const areas = typeof input.area === "string" ? [area(s, input.area).id] : s.areas.list().map((a) => a.id);
          return json({ hits: s.store.search({ areas, query: input.query, collectionId: input.collectionId, limit: input.limit ?? 50, tags: d.tagFilter(ctx) }) });
        }),
    },

    library_tree: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const collection = s.store.getCollection(String(input.collectionId));
          if (!collection) throw notFound();
          return json({ nodes: s.store.tree(collection.id) });
        }),
    },

    library_document: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const document = doc(s, input.id);
          return json({ document, revisions: s.store.revisions(document.id, 100), comments: s.store.listComments(document.id), links: s.store.listLinks(document.id) });
        }),
    },

    library_revision: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return json(s.store.revision(doc(s, input.id).id, Number(input.version)));
        }),
    },

    library_document_create: {
      redact: (input) => `owner created document "${String(input.title).slice(0, 60)}"`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const created = s.store.createDocument({
            area: area(s, input.area).id,
            collectionId: input.collectionId,
            parentId: input.parentId,
            title: String(input.title),
            body: input.body,
            summary: input.summary,
            status: input.status,
            tags: input.tags,
            actor: actor(ctx),
          });
          knowledge.kick(s);
          return { id: created.id, version: created.version };
        }),
    },

    library_document_update: {
      redact: (input, output) => `owner edited document ${input.id} → v${(output as In | undefined)?.version ?? "?"}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const document = doc(s, input.id);
          const updated = s.store.updateDocument(document.id, { title: input.title, body: input.body, summary: input.summary, status: input.status, tags: input.tags }, input.expectedVersion, actor(ctx));
          knowledge.kick(s);
          return { id: updated.id, version: updated.version };
        }),
    },

    library_document_delete: {
      redact: (input) => `owner deleted document ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const document = doc(s, input.id);
          s.store.deleteDocument(document.id, actor(ctx));
          knowledge.kick(s);
          return { id: document.id, deleted: true };
        }),
    },

    library_collection_create: {
      redact: (input) => `owner created collection "${String(input.name).slice(0, 60)}"`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return { id: s.store.createCollection(area(s, input.area).id, String(input.name), input.description, actor(ctx)).id };
        }),
    },

    library_collection_delete: {
      redact: (input) => `owner deleted collection ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const collection = s.store.getCollection(String(input.id));
          if (!collection) throw notFound();
          const { documents } = s.store.deleteCollection(collection.id, actor(ctx));
          knowledge.kick(s);
          return { id: collection.id, deleted: true, documents };
        }),
    },

    library_comment_add: {
      redact: (input) => `owner commented on ${input.documentId}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return s.store.addComment(doc(s, input.documentId).id, String(input.body), input.parentId, actor(ctx));
        }),
    },

    library_link_delete: {
      redact: (input) => `owner removed link ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const link = s.store.getLink(String(input.id));
          if (!link) throw notFound();
          s.store.deleteLink(link.id);
          return { id: link.id, deleted: true };
        }),
    },

    library_recall: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const areas = typeof input.area === "string" ? [area(s, input.area).id] : s.areas.list().map((a) => a.id);
          return json(await d.recallAcross(s, ctx, areas, String(input.query), Math.min(Number(input.limit ?? 20), 50)));
        }),
    },

    library_research: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const target = area(s, input.area);
          if (!s.notebook) return json({ enabled: false, sources: [], notes: [] });
          const ready = await d.readyArea(ctx, s, target.id, "notebook");
          const notebookId = ready.notebookId as string;
          return json({ enabled: true, sources: await s.notebook.listSources(notebookId, 100, 0), notes: await s.notebook.listNotes(notebookId) });
        }),
    },

    library_research_item: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = d.notebookOf(s);
          const ready = await d.readyArea(ctx, s, area(s, input.area).id, "notebook");
          const id = String(input.id);
          const notebookId = ready.notebookId as string;
          return json(id.startsWith("note:") ? await notebook.getNote(notebookId, id) : await notebook.getSource(notebookId, id));
        }),
    },

    library_research_source_delete: {
      redact: (input) => `owner deleted research source ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = d.notebookOf(s);
          const ready = await d.readyArea(ctx, s, area(s, input.area).id, "notebook");
          await notebook.deleteSource(ready.notebookId as string, String(input.id));
          return { id: String(input.id), deleted: true };
        }),
    },
  };
}
