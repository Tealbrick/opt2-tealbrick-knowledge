// C373 L2 real-to-real: the REAL Knowledge app (real Miniapp SDK 0.1.40: claim, slice, grants, op proofs, scope defaults and
// authorize()) driven by the conformance fake bridge. Two things are proven here, at the SDK gate and in Knowledge:
// 1. App writers (Observer deliveries): a companion APP caller lists areas and creates/updates documents in the company
//    area, named "Observer" on the document page; it never reaches an agent's private area, never any other op.
// 2. Governance between agents: agent A cannot read agent B's private area (scope_denied at the gate), the company area is
//    readable by every granted agent, and an owner narrowing still applies.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type AppClient, appEnv, createFakeBridge, type FakeBridge, type PersonSession, TEST_ROOTS_ENV } from "@opt2-tealbrick/conformance";
import type { InstanceId } from "@opt2-tealbrick/spec/credentials";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import start from "../conformance.start.ts";

const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as Manifest;
const OBSERVER = "ins_01M5PM73ZZ0BSERVER00000000" as InstanceId;
const OBSERVER_OPS = ["areas_list", "document_create", "document_update"];

let bridge: FakeBridge;
let app: { url: string; stop(): Promise<void> };
let client: AppClient;
let owner: PersonSession;
let dataDir: string;
let key = 0;
const idem = () => `c373-app-${String(++key).padStart(4, "0")}`;

before(async () => {
  bridge = await createFakeBridge({ manifest });
  await bridge.control.publishKeySet();
  dataDir = mkdtempSync(join(tmpdir(), "knowledge-c373-"));
  const env = appEnv(bridge, dataDir, { [TEST_ROOTS_ENV]: JSON.stringify(bridge.testRootJwks()), TBCONF_PORT: "0", TBCONF_STUB_ENGINE: "0" });
  app = await start(env);
  await bridge.control.waitForClaim(30_000);
  await bridge.control.waitForSliceRevision(1, 30_000);
  // Core lists Observer in the slice once its companion grant exists (product verified from the grant `prd` too)
  await bridge.control.listCompanionCaller({ product: "observer", ins: OBSERVER, name: "Observer", provider: "railway" });
  client = bridge.client(app.url);
  const session = await client.signIn();
  assert.ok(session, "owner session");
  owner = session;
});

after(async () => {
  await app?.stop();
  await bridge?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

type Who = { agent?: string } | { app: true };
async function call(op: string, input: Json, who: Who = {}) {
  const view = client.opView(op);
  const write = view?.effect !== "read";
  const opts = "app" in who ? { caller: OBSERVER, prd: "observer", wf: OBSERVER_OPS, crud: ["read", "create", "update"] as never } : who.agent ? { agent: who.agent as never } : {};
  const answer = await client.callOp(op, input, { ...opts, ...(write ? { idempotencyKey: idem() } : {}) });
  return { status: answer.status, code: answer.code, output: (answer.body as { output?: Record<string, any> } | null)?.output ?? {} };
}
async function ok(op: string, input: Json, who: Who = {}) {
  const a = await call(op, input, who);
  assert.equal(a.status, 200, `${op}: ${a.code}`);
  return a.output;
}
async function personOp(op: string, input: Json) {
  const a = await client.personOp(owner, op, input, { idempotencyKey: idem() });
  assert.equal(a.status, 200, `${op}: ${a.code} ${a.text}`);
  return a.output as Record<string, any>;
}

/** Areas the slice's agents own (agentAdded runs when the app installs the slice). */
async function ownAreas(): Promise<{ a: string; b: string; agentA: string; agentB: string }> {
  const [agentA, agentB] = bridge.ids.agents.filter((x) => x.mode === "free").map((x) => x.id);
  let a: string | undefined;
  let b: string | undefined;
  for (let i = 0; i < 50 && (!a || !b); i++) {
    a = ((await ok("areas_list", {}, { agent: agentA })).areas as { id: string; own: boolean }[]).find((x) => x.own)?.id;
    b = ((await ok("areas_list", {}, { agent: agentB })).areas as { id: string; own: boolean }[]).find((x) => x.own)?.id;
    if (!a || !b) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(a && b && agentA && agentB);
  return { a, b, agentA, agentB };
}

test("C373 app writer allowed: Observer lists the company area only and creates/updates a document there, named 'Observer'", async () => {
  await ownAreas();
  const areas = (await ok("areas_list", {}, { app: true })).areas as { id: string; access: string; own: boolean }[];
  assert.deepEqual(areas, [{ id: "company", label: "Company", kind: "shared", own: false, access: "read_write" }]);
  const created = await ok("document_create", { title: "Mail digest: Acme LLC renewal", body: "Acme LLC renews in March (from mail@example.com).", tags: ["mail"] }, { app: true });
  assert.equal(created.area, "company", "no area given: the company area");
  const updated = await ok("document_update", { id: created.id, body: "Acme LLC renews on 1 March.", expectedVersion: created.version }, { app: true });
  assert.equal(updated.version, created.version + 1);
  const page = await personOp("library_document", { id: created.id });
  assert.equal(page.document.createdBy, OBSERVER, "the record keeps the verified instance id");
  assert.deepEqual(page.authors, { [OBSERVER]: "Observer" }, "the document page names the app");
});

test("C373 app writer refused: never an agent's private area (even with an owner row), no other op, and the owner can switch writes off", async () => {
  const { a, agentA } = await ownAreas();
  // an agent's area answers like a missing one
  assert.equal((await call("document_create", { title: "intrusion", area: a }, { app: true })).code, "not_found");
  const own = await ok("remember", { text: "Ada private: zebra plan" }, { agent: agentA });
  assert.equal((await call("document_update", { id: own.documentId, body: "changed" }, { app: true })).code, "not_found");
  // even an owner row on the agent's area gives the app nothing there (Knowledge rule, not only the default)
  await personOp("tb.scopes_set", { agent: OBSERVER, type: "area", id: a, access: "read_write" });
  assert.equal((await call("document_create", { title: "intrusion", area: a }, { app: true })).code, "not_found");
  assert.ok(!((await ok("areas_list", {}, { app: true })).areas as { id: string }[]).some((x) => x.id === a));
  await personOp("tb.scopes_set", { agent: OBSERVER, type: "area", id: a, access: null });
  // reads other than areas_list, and other writes, are refused (the grant names them here on purpose)
  for (const [op, input] of [["documents_search", { query: "zebra" }], ["document_get", { id: own.documentId }], ["remember", { text: "x", area: "company" }]] as const) {
    const answer = await client.callOp(op, input as Json, { caller: OBSERVER, prd: "observer", wf: [op], crud: ["read", "create"] as never, idempotencyKey: idem() });
    assert.equal(answer.code, "scope_denied", `${op}: ${answer.code}`);
  }
  // the owner switches Observer's writes off (its own write row → read): the SDK gate refuses, nothing is written
  await personOp("tb.scopes_set", { agent: OBSERVER, type: "area", id: OBSERVER, access: "read" });
  assert.equal((await call("document_create", { title: "after switch-off" }, { app: true })).code, "scope_denied");
  assert.equal(((await ok("areas_list", {}, { app: true })).areas as { access: string }[])[0]?.access, "read");
  await personOp("tb.scopes_set", { agent: OBSERVER, type: "area", id: OBSERVER, access: "read_write" });
  await ok("document_create", { title: "after switch-on" }, { app: true });
});

test("C373 governance: agent A cannot read agent B's area (scope_denied); the company area is readable by every agent; owner narrowing applies", async () => {
  const { a, b, agentA, agentB } = await ownAreas();
  await ok("remember", { text: "Bo private: falcon budget" }, { agent: agentB });
  for (const [op, input] of [["recall", { query: "falcon", area: b }], ["documents_search", { query: "falcon", area: b }], ["remember", { text: "x", area: b }]] as const) {
    assert.equal((await call(op, input as Json, { agent: agentA })).code, "scope_denied", `${op} into B's area`);
  }
  const fromA = await ok("documents_search", { query: "falcon" }, { agent: agentA });
  assert.equal(fromA.hits.length, 0, "an unscoped search never shows B's memory");
  // the company area: readable by every agent (default `shared` → read), written by Observer above
  for (const agent of [agentA, agentB]) {
    const hits = (await ok("documents_search", { query: "Acme", area: "company" }, { agent })).hits as unknown[];
    assert.ok(hits.length >= 1, `${agent} reads the company area`);
  }
  // owner narrowing: the owner removes A's company access → A's company read is refused at the gate; B still reads
  await personOp("tb.scopes_set", { agent: agentA, type: "area", id: "company", access: null });
  assert.equal((await call("documents_search", { query: "Acme", area: "company" }, { agent: agentA })).code, "scope_denied");
  assert.ok(((await ok("documents_search", { query: "Acme", area: "company" }, { agent: agentB })).hits as unknown[]).length >= 1);
  await personOp("tb.scopes_set", { agent: agentA, type: "area", id: "company", access: "read" });
  assert.ok(a !== b);
});
