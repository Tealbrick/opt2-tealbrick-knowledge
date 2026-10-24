// Workstation upgrade smoke for a GBrain pin bump (C336 M2; CONTRIBUTING "upgrade test"): Knowledge's real client and
// engine against a real upstream `gbrain serve --http` on an embedded (PGLite) brain, no keys. Run "seed" with a checkout
// of the OLD pin, then "verify" with a checkout of the NEW pin over the same brain home (applies the new migrations to
// the old brain first). Each checkout needs `bun install --frozen-lockfile --production --ignore-scripts`.
// Not covered: Postgres + pgvector (the production engine), embeddings, model calls.
// Usage: node scripts/gbrain-upgrade-smoke.ts <seed|verify> <upstream checkout> <empty or seeded brain home>
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ClientStore, StoredClient } from "../src/engines/gbrain/client.ts";

const [phase, root, home] = process.argv.slice(2) as [string, string, string];
if (!["seed", "verify"].includes(phase) || !root || !home) {
  console.error("usage: node scripts/gbrain-upgrade-smoke.ts <seed|verify> <upstream checkout> <brain home>");
  process.exit(2);
}
const { GBrainClient } = await import("../src/engines/gbrain/client.ts");
const { GBrainEngine } = await import("../src/engines/gbrain/engine.ts");
const { gbrainExposure } = await import("../src/engines/gbrain/exposure.ts");

const memoryStore = (): ClientStore => {
  const m = new Map<string, StoredClient>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => {
      m.delete(k);
    },
  };
};
const SOURCE = "ka-smoke000000000000000001";
const ADMIN = "smoke-admin-token-".padEnd(48, "x");
const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ADMIN };
const cli = (...args: string[]) => spawnSync("bun", ["run", `${root}/src/cli.ts`, ...args], { env, encoding: "utf8", timeout: 300_000 });
const port = await new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
  });
});
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${phase} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

if (phase === "seed") {
  if (!existsSync(join(home, ".gbrain", "config.json"))) {
    const init = cli("init", "--pglite", "--no-embedding", "--non-interactive");
    check("init (embedded, keyless)", init.status === 0, init.stderr.slice(-300));
  }
  const added = cli("sources", "add", SOURCE, "--name", "knowledge-smoke");
  check("sources add (or already there)", added.status === 0 || /exist/iu.test(added.stdout + added.stderr), added.stderr.slice(-300));
} else {
  const migrated = cli("apply-migrations", "--yes", "--no-autopilot-install");
  check("apply-migrations old brain → new pin", migrated.status === 0, (migrated.stdout + migrated.stderr).slice(-400));
}

const serve = spawn("bun", ["run", `${root}/src/cli.ts`, "serve", "--http", "--bind", "127.0.0.1", "--port", String(port), "--suppress-bootstrap-token"], { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
serve.stderr.on("data", (d) => {
  stderr = (stderr + String(d)).slice(-2000);
});
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    const up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const client = new GBrainClient({ baseUrl: base, adminToken: ADMIN, store: memoryStore() });
  const engine = new GBrainEngine(client, SOURCE);
  const health = await client.health();
  check("health", (health as { ok?: boolean }).ok === true, JSON.stringify(health).slice(0, 200));
  const catalog = await engine.catalog();
  const exposed = gbrainExposure().exposed.size;
  check("catalog lists the exposed tools", catalog.length > 60, `${catalog.length} listed of ${exposed} allowed by policy`);
  const missing = [...gbrainExposure().exposed.keys()].filter((n) => !catalog.some((e: { name: string }) => e.name === `gb_${n}`));
  console.log(`INFO ${phase} allowed by policy but not in live tools/list: ${missing.join(" ") || "none"}`);
  if (phase === "seed") {
    await engine.projectDocument(SOURCE, "kdoc_01JSMKTEST0000000000000000", "# Kettle\n\nThe office kettle is teal and lives on the second shelf.");
    const fact = await engine.call(SOURCE, "gb_remember", { fact: "Acme renews in March", provenance: "smoke seed", entity: "Acme" }, "agt_smoke");
    check("gb_remember (old pin)", Boolean(fact), JSON.stringify(fact).slice(0, 160));
  }
  const recalled = await engine.recall("agent-smoke", SOURCE, "kettle teal", 5, "agt_smoke");
  check("recall finds the seeded page", recalled.rows.some((r: { documentId: string | null }) => r.documentId === "kdoc_01JSMKTEST0000000000000000"), JSON.stringify(recalled).slice(0, 300));
  if (phase === "verify") {
    const verbs = await engine.call(SOURCE, "gb_recall", { query: "Acme renews" }, "agt_smoke");
    check("gb_recall finds the old fact", JSON.stringify(verbs).includes("March"), JSON.stringify(verbs).slice(0, 200));
    const pack = await engine.call(SOURCE, "gb_context_pack", { entities: "Acme", budget_tokens: 400 }, "agt_smoke");
    check("gb_context_pack answers", pack !== null && pack !== undefined, JSON.stringify(pack).slice(0, 200));
    const batch = await engine.call(SOURCE, "gb_remember", { items: [{ fact: "Acme wants SSO", provenance: "smoke verify", entity: "Acme" }] }, "agt_smoke");
    check("gb_remember items[] (new pin)", Boolean(batch), JSON.stringify(batch).slice(0, 200));
    const page = await engine.call(SOURCE, "gb_get_page", { slug: "knowledge-docs/kdoc_01jsmktest0000000000000000" }, "agt_smoke");
    check("gb_get_page reads the old mirror page", JSON.stringify(page).includes("kettle"), JSON.stringify(page).slice(0, 160));
    await engine.removeDocument(SOURCE, "kdoc_01JSMKTEST0000000000000000");
    check("removeDocument (delete_page) on the new pin", true);
  }
  const settings = await engine.settings();
  check("settings readiness/counts", settings.counts !== null || settings.readiness !== null, JSON.stringify(settings).slice(0, 300));
} catch (error) {
  check("no exception", false, `${error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error)} | serve stderr: ${stderr.slice(-600)}`);
} finally {
  serve.kill("SIGTERM");
}
