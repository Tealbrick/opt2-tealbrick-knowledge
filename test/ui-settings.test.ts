// C296 Settings page (src/ui/settings.tsx) against the real SDK client and a stub server: Hindsight greyed "soon" and
// not selectable, the engine_missing reason shown, key presence (set/missing, never a value), embeddings n of N,
// capabilities and areas. Compiled with the build tsconfig into its own output folder and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";

type SettingsModule = typeof import("../src/ui/settings.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-settings");

const win = new Window({ url: "http://localhost/a/knowledge/settings", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = "sk-test-never-shown-1234567890";
const overview = (running: boolean) => ({
  engine: {
    configured: running ? "gbrain" : "hindsight",
    running,
    choices: [
      { value: "gbrain", label: "GBrain", note: "Sourced pages and facts." },
      { value: "hindsight", label: "Hindsight", note: "soon", disabled: true },
    ],
    state: running ? "ok" : "unknown",
    detail: [],
    attention: running ? null : { code: "engine_missing", reason: 'No memory engine runs: the engine setting "hindsight" is not available yet, so recall is keyword-only.' },
    version: running ? "0.60.57.0" : null,
  },
  research: false,
  models: { provider: "openai", chatModel: "m", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", keys: ["OPENAI_API_KEY"] },
  documents: { total: 52, inEngine: running ? 52 : 0, waiting: running ? 0 : 52, failed: 0 },
  embeddings: { chunks: running ? 366 : null, embedded: running ? 366 : null, pages: running ? 52 : null, readiness: running ? { state: "ok", reason: "configured" } : null, error: null },
  tools: { offered: running ? 88 : null, error: null, surface: running ? "full" : null },
  capabilities: [
    { id: "entities", label: "Entities (people, companies)", state: running ? "on" : "off", reason: "No model key needed." },
    { id: "reranker", label: "Reranker", state: "off", reason: "Needs VOYAGE_API_KEY, which is not a Knowledge key yet." },
  ],
  areas: [{ id: "company", label: "Company", kind: "shared", engineReady: running, documents: 3, ready: running ? 3 : 0, pending: running ? 0 : 3, failed: 0 }],
});
const stub = { running: true, keyPresent: false };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/knowledge/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op === "settings_overview") return json(200, { status: "ok", output: overview(stub.running) });
  // a stray value field: the page must never render it
  if (op === "tb.keys_status") return json(200, { status: "ok", output: [{ name: "OPENAI_API_KEY", required: true, present: stub.keyPresent, source: null, value: SECRET }] });
  return json(404, { error: { code: "not_found", message: String(op) } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function mount(Settings: SettingsModule["Settings"]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "knowledge" }, h(Settings))));
  for (let i = 0; i < 6; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}

let mod: SettingsModule;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  mod = (await import(pathToFileURL(join(outDir, "ui", "settings.js")).href)) as SettingsModule;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

describe("Settings page (C296)", () => {
  it("shows GBrain selected and Hindsight greyed 'soon' (not selectable), engine counts, key set/missing, capabilities, areas", async () => {
    stub.running = true;
    stub.keyPresent = false;
    const m = await mount(mod.Settings);
    const text = m.host.textContent ?? "";
    const rows = [...m.host.querySelectorAll('section[aria-label="Memory engine"] tr')].map((r) => r.textContent ?? "");
    assert.ok(rows.some((r) => /^GBrain\s*chosen$/u.test(r.trim())), rows.join("|"));
    assert.ok(rows.some((r) => /^Hindsight\s*soon$/u.test(r.trim())), "Hindsight greyed 'soon', never chosen");
    assert.equal(m.host.querySelectorAll('[role="radio"]').length, 0, "read-only: nothing to pick here");
    assert.match(text, /52 of 52/u);
    assert.match(text, /366 of 366/u);
    assert.match(text, /88 engine tools are offered/u);
    assert.match(text, /OPENAI_API_KEY\s*missing/u);
    assert.match(text, /Needs VOYAGE_API_KEY/u);
    assert.match(text, /Company/u);
    assert.ok(!text.includes(SECRET));
    await m.unmount();
  });

  it("shows the engine_missing reason and 'not running' when no engine runs; a set key reads 'set'", async () => {
    stub.running = false;
    stub.keyPresent = true;
    const m = await mount(mod.Settings);
    const text = m.host.textContent ?? "";
    assert.match(text, /not running/u);
    assert.match(text, /No memory engine runs/u);
    assert.match(text, /OPENAI_API_KEY\s*set/u);
    assert.match(text, /0 of 52/u);
    assert.match(text, /engine tools could not be read/u);
    await m.unmount();
  });
});
