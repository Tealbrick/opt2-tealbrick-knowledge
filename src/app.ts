// Knowledge app definition for the Miniapp SDK: manifest + handlers by operation id + dynamic engine
// tools + events + onStart. Routes, validation, receipts, holds, idempotency, scopes and backups are the SDK's.
import { readFileSync } from "node:fs";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { AppDefinition, Db, Json, Logger, ScopeStore } from "@opt2-tealbrick/spec/sdk";
import { readConfig } from "./config.ts";
import { createHandlers, type ErrorFactory } from "./handlers.ts";
import { type AppSecrets, ENGINE_MISSING, Knowledge, type KnowledgeOptions } from "./knowledge.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as Manifest;
export const migrationsDir = new URL("../migrations", import.meta.url).pathname;

/** SDK C33 start context (structural; the SDK's StartContext also carries `secrets`). */
export interface StartContext {
  db: Db;
  /** SDK v0.1.13 (C86): push the app status now (debounced) */
  statusChanged?(): void;
  secrets: AppSecrets;
  log: Logger;
  scopes: ScopeStore;
  getKey(name: string): Promise<string | null>;
  callServiceHelper<O = Json>(serviceId: string, path: string, body: Json): Promise<O>;
}

export type KnowledgeDefinition = AppDefinition & { onStart(ctx: StartContext): Promise<void>; attention?(): Promise<{ code: string; reason: string } | null> };

export function knowledgeDefinition(env: Record<string, string | undefined>, TbError: ErrorFactory, opts: KnowledgeOptions = {}): { definition: KnowledgeDefinition; knowledge: Knowledge } {
  const knowledge = new Knowledge(readConfig(env), opts);
  const { handlers, dynamic, events } = createHandlers(knowledge, TbError);
  return {
    knowledge,
    definition: {
      manifest,
      handlers: handlers as AppDefinition["handlers"],
      dynamic,
      events,
      migrations: migrationsDir,
      // QA F89 (L3, spec 0.1.28): a degraded or failing memory engine reaches the owner through the status push.
      attention: async () => knowledge.attention(),
      // The SDK backs up app.db and each deployed service (manifest `backups` + `services[].backup`).
      backup: {
        async afterRestore() {
          const services = knowledge.current();
          const requeued = services?.projector?.requeueAll() ?? 0;
          if (services) knowledge.kick(services);
          void requeued;
        },
      },
      // After boot (and the claim): the company area exists, engine resources are provisioned, the outbox drains.
      async onStart(ctx) {
        const services = knowledge.bind(ctx.db, ctx.secrets);
        await services.areas.ensureShared(ctx.scopes);
        await knowledge.provision(services, ctx as never);
        // Rows that gave up while the engine was unusable (e.g. before 0.1.6 no engine token could be stored) retry at boot.
        const retried = services.projector?.retryFailed() ?? 0;
        if (retried) ctx.log.info("projection retry after boot", { rows: retried });
        // C296: an engine that arrives where none ran (hindsight → gbrain switch) re-projects every document.
        const requeued = knowledge.noteBootEngine(services);
        if (requeued) ctx.log.info("projection requeued: memory engine arrived", { rows: requeued });
        knowledge.kick(services);
        // F89: probe the engine now (and every 10 min) so a degraded engine shows before the first recall.
        await knowledge.watchEngine(services, ctx.statusChanged ? () => ctx.statusChanged?.() : null, opts.engineProbeMs).catch(() => undefined);
        // C296: with no engine the probe never runs, so push the engine_missing attention now (never silent).
        if (knowledge.attention()?.code === ENGINE_MISSING) ctx.statusChanged?.();
        ctx.log.info("knowledge started", { engine: services.engine ? "gbrain" : "none", configured: knowledge.config.engine, attention: knowledge.attention()?.code ?? "none", engineState: knowledge.engineStatus().state, research: services.notebook !== null, areas: services.areas.list().length });
      },
    },
  };
}
