// C373 Access page (src/ui/access.tsx) against the real SDK client and a stub server: the directory note in plain words
// (including "Update Governance to 0.3.0"), people by id with their agents' names, teams with members and grants, add and
// remove a grant (the ops the page calls). Compiled with the build tsconfig into its own output folder, rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";

type AccessModule = typeof import("../src/ui/access.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-access");

const win = new Window({ url: "http://localhost/a/knowledge/access", width: 1280, height: 860 });
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

const ready = {
  directory: { status: "ready", available: true, note: "Knowledge follows the Governance directory: each person's agents share that person's memory.", revision: 7, syncedAt: 1_800_000_000_000, checkedAt: 1_800_000_000_000 },
  people: [
    { id: "ct_anna", active: true, area: "person-a", areaExists: true, documents: 3, agents: [{ id: "agt_a", name: "Ada" }], readBy: [{ team: "team_sales", teamName: "Sales", tags: ["work"] }] },
    { id: "ct_ben", active: true, area: "person-b", areaExists: false, documents: 0, agents: [{ id: "agt_b", name: "Bo" }], readBy: [] },
  ],
  teams: [{ id: "team_sales", name: "Sales", area: "team-s", areaExists: true, documents: 1, people: ["ct_ben"], agents: [], grants: [{ person: "ct_anna", tags: ["work"] }] }],
  agentsWithoutOwner: [{ id: "agt_c", name: "Cy" }],
  grants: [{ team: "team_sales", teamName: "Sales", person: "ct_anna", tags: ["work"] }],
  log: [{ at: 1_800_000_000_000, actor: "per_1", action: "grant_added", team: "team_sales", person: "ct_anna", tags: ["work"] }],
};
const stub: { overview: unknown; calls: { op: string; input: unknown }[] } = { overview: ready, calls: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/knowledge/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op === "access_overview") return json(200, { status: "ok", output: stub.overview });
  if (op === "access_grant_remove" || op === "access_grant_set") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
    stub.calls.push({ op, input: body.input });
    return json(200, { status: "ok", output: { team: "team_sales", person: "ct_anna", removed: true } });
  }
  return json(404, { error: { code: "not_found", message: String(op) } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
async function mount(Access: AccessModule["Access"]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "knowledge" }, h(Access))));
  await settle();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}

let mod: AccessModule;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  mod = (await import(pathToFileURL(join(outDir, "ui", "access.js")).href)) as AccessModule;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

describe("Access page (C373)", () => {
  it("lists people by id with their agents, teams with members and grants, agents with no owner, and the change log", async () => {
    stub.overview = ready;
    const m = await mount(mod.Access);
    const text = m.host.textContent ?? "";
    assert.match(text, /Knowledge follows the Governance directory/u);
    assert.match(text, /ct_anna/u);
    assert.match(text, /Ada/u);
    assert.match(text, /Sales \(only memories tagged work\)/u, "who else reads Anna's memory");
    assert.match(text, /ct_ben \(Bo\)/u, "a team member shows as id + agent names");
    assert.match(text, /not used yet/u);
    assert.match(text, /Agents with no owner/u);
    assert.match(text, /Cy/u);
    assert.match(text, /Grant added/u);
    assert.ok(m.host.querySelector('section[aria-label="Access"]'));
    await m.unmount();
  });

  it("Remove calls access_grant_remove for that team and person", async () => {
    stub.overview = ready;
    stub.calls = [];
    const m = await mount(mod.Access);
    const remove = [...m.host.querySelectorAll("button")].find((b) => b.textContent === "Remove") as unknown as HTMLButtonElement;
    assert.ok(remove, "a Remove button per grant");
    await act(async () => remove.click());
    await settle();
    assert.deepEqual(stub.calls, [{ op: "access_grant_remove", input: { team: "team_sales", person: "ct_anna" } }]);
    await m.unmount();
  });

  it("says plainly when Governance is too old: no grant form, today's access", async () => {
    stub.overview = { ...ready, directory: { status: "needs_update", available: false, note: "Governance refuses to share its directory with Knowledge. Update Governance to 0.3.0. Until then, each agent has only its own memory and the company memory.", revision: null, syncedAt: null, checkedAt: 1 }, people: [], teams: [], grants: [], log: [] };
    const m = await mount(mod.Access);
    const text = m.host.textContent ?? "";
    assert.match(text, /Update Governance to 0\.3\.0/u);
    assert.match(text, /No people yet/u);
    assert.doesNotMatch(text, /Let this team read/u);
    await m.unmount();
  });
});
