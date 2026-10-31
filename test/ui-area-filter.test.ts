// The filter of the long area lists (C382 batch 4): the area pickers (Library, Recall, Research) and the areas tables
// (Memory status, Settings). The areas load in full, so each filter reads all of them and says so. Compiled with the
// build tsconfig and rendered in happy-dom against a stub server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-area-filter");

const win = new Window({ url: "http://localhost/a/knowledge/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "localStorage", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const pad = (n: number) => String(n).padStart(2, "0");
const AREA_LABELS = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `area_${pad(i)}`, label: `Area ${pad(i)}`, kind: "shared", researchReady: true, engineReady: i % 2 === 0, documents: i, ready: i, pending: 0, failed: 0 }));
const stub = { areas: AREA_LABELS(10) };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/knowledge/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op === "library_overview") return json(200, { status: "ok", output: { areas: stub.areas } });
  if (op === "settings_overview") return json(200, { status: "ok", output: settings() });
  return json(404, { error: { code: "not_found", message: String(op) } });
}) as typeof fetch;

const settings = () => ({
  engine: { configured: "gbrain", running: true, choices: [{ value: "gbrain", label: "GBrain", note: "" }], state: "ok", detail: [], attention: null, version: "1" },
  research: false,
  roles: [],
  models: { provider: "openai", chatModel: "m", embeddingProvider: "openai", embeddingModel: "e", keys: [] },
  documents: { total: 0, inEngine: 0, waiting: 0, failed: 0 },
  embeddings: { chunks: null, embedded: null, pages: null, readiness: null, error: null },
  tools: { offered: null, error: null, surface: null },
  capabilities: [],
  areas: stub.areas,
});

const { act, createElement: h, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "knowledge" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const buttons = (host: Element, label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
const text = (host: Element) => host.textContent ?? "";
const options = (host: Element) => [...host.querySelectorAll('[role="option"]')].map((o) => (o.textContent ?? "").trim());
const filterInput = (host: Element) => host.querySelector(".tb-listfilter input") as HTMLInputElement | null;
const KEY = "tb-filter:/a/knowledge/:";

let area: typeof import("../src/ui/area-filter.tsx");
let status: typeof import("../src/ui/status.tsx");
let settingsMod: typeof import("../src/ui/settings.tsx");
let recall: typeof import("../src/ui/recall.tsx");
let research: typeof import("../src/ui/research.tsx");
let library: typeof import("../src/ui/library.tsx");
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const load = (f: string) => import(pathToFileURL(join(outDir, "ui", f)).href);
  [area, status, settingsMod, recall, research, library] = await Promise.all(["area-filter.js", "status.js", "settings.js", "recall.js", "research.js", "library.js"].map(load));
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const reset = (n = 10) => {
  localStorage.clear();
  stub.areas = AREA_LABELS(n);
};

function Picker({ start = "area_00", extra }: { start?: string; extra?: { value: string; label: string }[] }) {
  const [v, setV] = useState(start);
  return h(area.AreaPicker, { page: "test", label: "Memory area", areas: stub.areas, value: v, onChange: setV, extra });
}

describe("Area picker filter", () => {
  it("a short list shows no filter", async () => {
    reset(3);
    const m = await mount(h(Picker));
    assert.equal(filterInput(m.host), null);
    assert.equal(options(m.host).length, 3);
    await m.unmount();
  });

  it("narrows the choices, says N of M memory areas, keeps the chosen area, and Clear restores", async () => {
    reset();
    const m = await mount(h(Picker));
    assert.equal(options(m.host).length, 10);
    await type(filterInput(m.host) as HTMLInputElement, "Area 07");
    assert.match(text(m.host), /Showing 1 of 10 memory areas\./);
    assert.deepEqual(options(m.host), ["Area 00", "Area 07"], "the chosen area stays selectable");
    assert.equal(m.host.querySelector(".tb-select-value")?.textContent, "Area 00");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(options(m.host).length, 10);
    assert.doesNotMatch(text(m.host), /Showing/);
    await m.unmount();
  });

  it("a regex works, and a filter with no match says it searched all areas", async () => {
    reset();
    const m = await mount(h(Picker, { extra: [{ value: "", label: "All areas" }] }));
    await type(filterInput(m.host) as HTMLInputElement, "Area 0[12]$");
    assert.match(text(m.host), /Showing 2 of 10 memory areas\./);
    assert.deepEqual(options(m.host), ["All areas", "Area 00", "Area 01", "Area 02"]);
    await type(filterInput(m.host) as HTMLInputElement, "zzz");
    assert.match(text(m.host), /No memory area matches\. The filter searched all 10 memory areas\./);
    assert.deepEqual(options(m.host), ["All areas", "Area 00"]);
    await m.unmount();
  });

  it("a remembered filter shows after a remount", async () => {
    reset();
    localStorage.setItem(`${KEY}test:area`, "Area 03");
    const m = await mount(h(Picker));
    assert.equal(filterInput(m.host)?.value, "Area 03");
    assert.match(text(m.host), /Showing 1 of 10 memory areas\./);
    await m.unmount();
  });

  it("a remembered filter shows even when the list is short", async () => {
    reset(3);
    localStorage.setItem(`${KEY}test:area`, "Area 01");
    const m = await mount(h(Picker));
    assert.equal(filterInput(m.host)?.value, "Area 01");
    assert.match(text(m.host), /Showing 1 of 3 memory areas\./);
    await m.unmount();
  });
});

describe("Area pickers on the pages", () => {
  it("Recall: filter with its own key, All areas stays offered", async () => {
    reset();
    const m = await mount(h(recall.Recall, { onOpen: () => {} }));
    assert.equal(options(m.host).length, 11);
    await type(filterInput(m.host) as HTMLInputElement, "Area 04");
    assert.deepEqual(options(m.host), ["All areas", "Area 04"]);
    assert.equal(localStorage.getItem(`${KEY}recall:area`), "Area 04");
    await m.unmount();
  });

  it("Research: filter with its own key", async () => {
    reset();
    const m = await mount(h(research.Research));
    await type(filterInput(m.host) as HTMLInputElement, "Area 05");
    assert.match(text(m.host), /Showing 1 of 10 memory areas\./);
    assert.ok(options(m.host).includes("Area 05"));
    assert.equal(localStorage.getItem(`${KEY}research:area`), "Area 05");
    await m.unmount();
  });

  it("Library: filter with its own key, the chosen area stays", async () => {
    reset();
    function Lib() {
      const [nav, setNav] = useState({ area: "area_00", collectionId: "", documentId: "" });
      return h(library.Library, { nav, setNav: (p: Partial<typeof nav>) => setNav((cur) => ({ ...cur, ...p })) });
    }
    const m = await mount(h(Lib));
    await type(filterInput(m.host) as HTMLInputElement, "Area 09");
    assert.match(text(m.host), /Showing 1 of 10 memory areas\./);
    assert.deepEqual(options(m.host).slice(0, 2), ["Area 00", "Area 09"]);
    assert.equal(localStorage.getItem(`${KEY}library:area`), "Area 09");
    await m.unmount();
  });
});

describe("Areas tables", () => {
  const rows = (host: Element) => host.querySelectorAll("tbody tr").length;
  const loaded = (n = 10) => ({ areas: AREA_LABELS(n) as unknown as import("../src/ui/status.tsx").AreaStatus[], error: null, reload: () => {} });

  it("Memory status: a short list shows no filter; a long one filters by name and by state", async () => {
    reset(3);
    let m = await mount(h(status.Status, { areas: loaded(3) }));
    assert.equal(filterInput(m.host), null);
    assert.equal(rows(m.host), 3);
    await m.unmount();
    reset();
    m = await mount(h(status.Status, { areas: loaded() }));
    assert.equal(rows(m.host), 10);
    await type(filterInput(m.host) as HTMLInputElement, "preparing");
    assert.equal(rows(m.host), 5);
    assert.match(text(m.host), /Showing 5 of 10 memory areas\./);
    await type(filterInput(m.host) as HTMLInputElement, "^Area 02$");
    assert.equal(rows(m.host), 1);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(rows(m.host), 10);
    assert.equal(localStorage.getItem(`${KEY}status`), "");
    await m.unmount();
  });

  it("Memory status: no match says all areas were searched; a remembered filter shows after a remount", async () => {
    reset();
    localStorage.setItem(`${KEY}status`, "zzz");
    const m = await mount(h(status.Status, { areas: loaded() }));
    assert.equal(rows(m.host), 0);
    assert.equal(filterInput(m.host)?.value, "zzz");
    assert.match(text(m.host), /Showing 0 of 10 memory areas\./);
    assert.match(text(m.host), /No memory area matches\. The filter searched all 10 memory areas\./);
    await m.unmount();
  });

  it("Settings: filters the memory areas with its own key, N of M, Clear restores, remembered after a remount", async () => {
    reset();
    let m = await mount(h(settingsMod.Settings));
    const areasRows = (host: Element) => host.querySelectorAll('section[aria-label="Memory areas"] tbody tr').length;
    assert.equal(areasRows(m.host), 10);
    const input = m.host.querySelector('section[aria-label="Memory areas"] input') as HTMLInputElement;
    await type(input, "Area 0[12]");
    assert.equal(areasRows(m.host), 2);
    assert.match(text(m.host), /Showing 2 of 10 memory areas\./);
    assert.equal(localStorage.getItem(`${KEY}settings`), "Area 0[12]");
    await m.unmount();
    m = await mount(h(settingsMod.Settings));
    assert.equal(areasRows(m.host), 2, "the remembered filter is on after a reload");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(areasRows(m.host), 10);
    await m.unmount();
  });

  it("Settings: a short list shows no filter", async () => {
    reset(3);
    const m = await mount(h(settingsMod.Settings));
    assert.equal(m.host.querySelector('section[aria-label="Memory areas"] input'), null);
    await m.unmount();
  });
});
