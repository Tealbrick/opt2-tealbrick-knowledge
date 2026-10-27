// C331 (demo gap 10): the document page (src/ui/library.tsx) names who wrote what. Header, history and comments show the agent's
// name from tb.agents_list and "you" for the signed-in person, never a bare agent id; an id the list does not know stays as stored.
// Real SDK client against a stub server; compiled with the build tsconfig into its own output folder and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";

type LibraryModule = typeof import("../src/ui/library.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-library-authors");

const win = new Window({ url: "http://localhost/a/knowledge/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT = "agt_01M5PM72GE2Q843A6AJ77DWQH0";
const GONE = "agt_01M5PM72QW76BQM2QBN0DBZE8K";
const OBSERVER = "ins_01M5PM73ZZ0BSERVER00000000"; // C373: an app writer (Observer deliveries)
const T = Date.parse("2026-10-24T09:00:00.000Z");
const stub = { agentsFail: false };
const doc = {
  document: {
    id: "doc_1", area: "company", collectionId: "col_1", parentId: null, title: "Finance note", slug: "finance-note", summary: null, body: "MRR",
    status: "published", tags: [], version: 2, createdBy: AGENT, updatedBy: AGENT, createdAt: T, updatedAt: T,
  },
  revisions: [
    { version: 1, title: "Finance note", summary: null, createdBy: "per_1", createdAt: T },
    { version: 2, title: "Finance note", summary: null, createdBy: AGENT, createdAt: T },
  ],
  comments: [
    { id: "cmt_1", parentId: null, body: "Checked.", createdBy: "per_1", createdAt: T },
    { id: "cmt_2", parentId: null, body: "Old note.", createdBy: GONE, createdAt: T },
    { id: "cmt_3", parentId: null, body: "Delivered from mail.", createdBy: OBSERVER, createdAt: T },
  ],
  authors: { [OBSERVER]: "Observer" },
  links: { outbound: [], backlinks: [] },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/knowledge/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op === "library_overview") return json(200, { status: "ok", output: { areas: [{ id: "company", label: "Company" }] } });
  if (op === "library_document") return json(200, { status: "ok", output: doc });
  if (op === "tb.agents_list") {
    if (stub.agentsFail) return json(500, { error: { code: "internal", message: "down" } });
    return json(200, { status: "ok", output: { agents: [{ id: AGENT, name: "Finance Analyst", status: "active" }] } });
  }
  return json(404, { error: { code: "not_found", message: String(op) } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function mount(Library: LibraryModule["Library"]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  const nav = { area: "company", collectionId: "col_1", documentId: "doc_1" };
  await act(async () => r.render(h(TbProvider, { product: "knowledge" }, h(Library, { nav, setNav: () => {} }))));
  for (let i = 0; i < 8; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}

let mod: LibraryModule;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  mod = (await import(pathToFileURL(join(outDir, "ui", "library.js")).href)) as LibraryModule;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const text = (host: Element) => (host.textContent ?? "").replace(/\s+/gu, " ");

describe("Document page: who wrote it (C331 demo gap 10)", () => {
  it("names the agent and 'you' in the header, the history and the comments; never the agent id", async () => {
    stub.agentsFail = false;
    const m = await mount(mod.Library);
    const t = text(m.host);
    assert.match(t, /Version 2, updated .+ by Finance Analyst/u);
    const by = [...m.host.querySelectorAll("tbody tr td:nth-child(3)")].map((c) => c.textContent);
    assert.deepEqual(by, ["you", "Finance Analyst"]);
    assert.match(t, /you, /u);
    assert.ok(!t.includes(AGENT), "no agent id on the page");
    assert.ok(t.includes(GONE), "an id the agent list does not know stays as stored");
    await m.unmount();
  });

  it("C373: names an app writer by the name Knowledge recorded (Observer), never its instance id", async () => {
    stub.agentsFail = false;
    const m = await mount(mod.Library);
    const t = text(m.host);
    assert.match(t, /Observer, /u);
    assert.ok(!t.includes(OBSERVER), "no instance id on the page");
    await m.unmount();
  });

  it("when the agent list cannot be read, the page still shows the document with the stored ids", async () => {
    stub.agentsFail = true;
    const m = await mount(mod.Library);
    assert.match(text(m.host), /Finance note/u);
    assert.match(text(m.host), new RegExp(`by ${AGENT}`, "u"));
    await m.unmount();
  });
});
