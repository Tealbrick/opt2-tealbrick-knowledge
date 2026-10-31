// C382: Agents & scopes (src/ui/configure.tsx) against the real SDK client and a stub server: the kit's AccessEditor with the
// manifest's levels and default rule, no dropdown per agent and area, a row that differs, a write through tb.scopes_set.
// Compiled with the build tsconfig into its own output folder and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { agentAreaId } from "../src/ids.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-configure");
const win = new Window({ url: "http://localhost/a/knowledge/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const HENRY = "agt_01J00000000000000000000AAA";
const TEMPO = "agt_01J00000000000000000000BBB";
const own = (id: string) => agentAreaId(id);
const sets: Record<string, unknown>[] = [];
let henryRows: { type: string; instanceId: string; access: string }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/knowledge/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1] ?? "";
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  if (op === "tb.agents_list")
    return json(200, {
      status: "ok",
      output: {
        agents: [
          { id: HENRY, name: "Henry", mode: "free", status: "active", access: henryRows },
          { id: TEMPO, name: "Tempo", mode: "free", status: "active", access: [{ type: "area", instanceId: "company", access: "read" }, { type: "area", instanceId: own(TEMPO), access: "read_write" }] },
        ],
      },
    });
  if (op === "tb.scopes_set") {
    const i = body.input ?? {};
    sets.push(i);
    henryRows = henryRows.filter((r) => r.instanceId !== i.id);
    if (i.access) henryRows.push({ type: "area", instanceId: String(i.id), access: String(i.access) });
    return json(200, { status: "ok", output: {} });
  }
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");
let mod: typeof import("../src/ui/configure.tsx");

before(async () => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  mod = (await import(pathToFileURL(join(outDir, "ui", "configure.js")).href)) as typeof import("../src/ui/configure.tsx");
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const AREAS = [
  { id: "company", label: "Company", kind: "shared" as const },
  { id: own(HENRY), label: "Henry (own memory)", kind: "agent" as const },
  { id: own(TEMPO), label: "Tempo (own memory)", kind: "agent" as const },
  { id: "person-x", label: "A person", kind: "person" as const },
];

it("C382: the levels, the own-area id and the default rule are those of the manifest and src/ids.ts", () => {
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as { scopes: { type: string; access: { id: string; label: string }[]; defaultGrants: { kind: string; access: string }[] }[] };
  const scope = manifest.scopes.find((s) => s.type === "area");
  assert.deepEqual(mod.AREA_LEVELS, scope?.access.map((a) => ({ id: a.id, label: a.label })));
  assert.equal(mod.ownAreaId(HENRY), agentAreaId(HENRY));
  const grant = (kind: string) => scope?.defaultGrants.find((d) => d.kind === kind)?.access;
  assert.equal(mod.areaDefault(HENRY, AREAS[0]), grant("shared"));
  assert.equal(mod.areaDefault(HENRY, AREAS[1]), grant("own"));
  assert.equal(mod.areaDefault(HENRY, AREAS[2]), null);
});

it("C382: defaults show no row; a read on another agent's memory is one row, and Back to default removes it through tb.scopes_set", async () => {
  henryRows = [
    { type: "area", instanceId: "company", access: "read" },
    { type: "area", instanceId: own(HENRY), access: "read_write" },
    { type: "area", instanceId: own(TEMPO), access: "read" },
  ];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "knowledge" }, h(mod.Configure, { areas: { areas: AREAS, error: null, reload: () => {} } }))));
  await flush();
  assert.equal(host.querySelectorAll('[role="combobox"]').length, 3);
  const backs = [...host.querySelectorAll("button[aria-label^='Back to default']")];
  assert.deepEqual(backs.map((b) => b.getAttribute("aria-label")), ["Back to default: Henry to Tempo (own memory)"]);
  assert.doesNotMatch(host.textContent ?? "", /A person/u, "person and team areas stay on the Access page");
  await act(async () => (backs[0] as HTMLElement).click());
  await flush();
  assert.deepEqual(sets, [{ agent: HENRY, type: "area", id: own(TEMPO), access: null }]);
  assert.match(host.textContent ?? "", /Every agent has the default\./u);
  await act(async () => r.unmount());
  host.remove();
});
