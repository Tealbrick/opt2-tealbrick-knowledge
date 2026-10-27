// Conformance harness (CONFORMANCE §2, app target): `tb-conformance app --start conformance.start.ts` boots Knowledge
// with the suite's env (fake bridge, enrolment code, TB_KEK, data dir) plus the deploy-time settings env. No engine
// services run here: recall answers from keyword search (`degraded: true`), engine-backed ops answer `area_not_ready`.
import { applyLevelCrud, LEVEL_CRUD_ENV, parseLevelCrud } from "@opt2-tealbrick/conformance";
import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { knowledgeDefinition, manifest } from "./src/app.ts";

// Harness-only stub engine (conformance 0.1.12 `dynamic.<op>.resolveTools`): with TBCONF_STUB_ENGINE=1 two stub tools
// resolve, so A11.resolve_family has something to resolve although no memory engine runs here. Only this file reads
// the variable; test/harness-isolation.test.ts fails if any file under src/ does, so the stub is unreachable in the image.
const STUB_TOOLS: Record<string, { crud: ("read" | "delete")[]; effect: "read" | "destructive"; holdFamily?: "destructive" }> = {
  conformance_stub_read: { crud: ["read"], effect: "read" },
  conformance_stub_delete: { crud: ["delete"], effect: "destructive", holdFamily: "destructive" },
};

const SETTINGS = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_RESEARCH: "false", KNOWLEDGE_MODEL_PROVIDER: "openai" };

export default async function start(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void>; backupNow(): Promise<void> }> {
  const full = { ...SETTINGS, ...env };
  const { definition: base, knowledge } = knowledgeDefinition(full, TbError);
  const engine = base.dynamic?.engine;
  const definition =
    (env.TBCONF_STUB_ENGINE ?? process.env.TBCONF_STUB_ENGINE) === "1" && engine
      ? {
          ...base,
          dynamic: {
            ...base.dynamic,
            engine: {
              ...engine,
              // conformance 0.1.30 A20.catalog_admitted needs a non-empty catalog; no engine runs here, so the stub lists its two tools
              catalog: async () =>
                Object.entries(STUB_TOOLS).map(([name, tool]) => ({
                  name,
                  title: name.replace(/_/gu, " ").slice(0, 60),
                  description: `Conformance stub (${tool.effect}).`,
                  inputSchema: { type: "object" as const, properties: {} },
                  crud: tool.crud,
                  effect: tool.effect,
                  ...(tool.holdFamily ? { holdFamily: tool.holdFamily } : {}),
                })),
              resolve: async (tool: string, ctx: Parameters<typeof engine.resolve>[1]) => {
                const stub = STUB_TOOLS[tool];
                return stub ? { tool, ...stub } : engine.resolve(tool, ctx);
              },
            },
          },
        }
      : base;
  // Test roots (C63; suite default since spec 0.1.12): the suite passes TEST Portal Root Keys in TBCONF_PORTAL_ROOT_KEYS;
  // only this harness reads it and hands them to startApp. Production never reads that variable.
  // Port: the suite's free port (TBCONF_PORT, conformance ≥ 0.1.13; 0 = any free port), else manifest runtime.port.
  const harness = {
    ...(env.TBCONF_PORTAL_ROOT_KEYS ? { portalRootKeys: JSON.parse(env.TBCONF_PORTAL_ROOT_KEYS) } : {}),
    port: env.TBCONF_PORT ? Number(env.TBCONF_PORT) : manifest.runtime.port,
  } as Parameters<typeof startApp>[2];
  // "An app update" in the black-box suite (conformance 0.1.30, A21 rows): the suite restarts the app with TBCONF_LEVEL_CRUD
  // and expects the digest of the updated manifest. Harness only; production never reads it.
  const levelCrud = parseLevelCrud(env[LEVEL_CRUD_ENV] ?? process.env[LEVEL_CRUD_ENV]);
  const running = await startApp(defineApp(levelCrud.length ? { ...definition, manifest: applyLevelCrud(definition.manifest, levelCrud) } : definition), full, harness);
  return {
    url: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      knowledge.stop();
      await running.stop();
    },
    backupNow: async () => {
      await running.backups.runNow();
    },
  };
}
