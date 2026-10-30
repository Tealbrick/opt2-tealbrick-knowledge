// C380 B6 real path: the REAL Knowledge app on the REAL Miniapp SDK (claim, slice, companion grants, op proofs, input and output
// schemas, receipts, idempotency) behind the conformance fake bridge, serving the FULL manifest (production's, with the two
// Governance ops). The conformance suite cannot drive these ops, so this is the proof of the SDK pipeline in front of the guard.
// No memory engine runs here (as in the other real-app tests); the Governance directory is not reachable, so no team grant exists.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type AppClient, appEnv, createFakeBridge, type FakeBridge, TEST_ROOTS_ENV } from "@opt2-tealbrick/conformance";
import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { InstanceId } from "@opt2-tealbrick/spec/credentials";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { knowledgeDefinition } from "../src/app.ts";

const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as Manifest;
const FLEET = "ins_01M5PM73ZZ0F1EET0000000000" as InstanceId;
const OTHER = "ins_01M5PM73ZZ0APP00000000000F" as InstanceId;

let bridge: FakeBridge;
let app: { stop(): Promise<void>; port: number };
let client: AppClient;
let dataDir: string;
let key = 0;
const idem = () => `c380-kn-${String(++key).padStart(4, "0")}`;

before(async () => {
  bridge = await createFakeBridge({ manifest });
  await bridge.control.publishKeySet();
  dataDir = mkdtempSync(join(tmpdir(), "knowledge-c380-"));
  const env = appEnv(bridge, dataDir, { [TEST_ROOTS_ENV]: JSON.stringify(bridge.testRootJwks()), TBCONF_PORT: "0" });
  const { definition } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_RESEARCH: "false", KNOWLEDGE_MODEL_PROVIDER: "openai", ...env }, TbError);
  app = (await startApp(defineApp(definition), env, { portalRootKeys: JSON.parse(env[TEST_ROOTS_ENV] as string), port: 0 } as never)) as never;
  await bridge.control.waitForClaim(30_000);
  await bridge.control.waitForSliceRevision(1, 30_000);
  await bridge.control.listCompanionCaller({ product: "fleet", ins: FLEET, name: "Governance", provider: "railway" });
  await bridge.control.listCompanionCaller({ product: "observer", ins: OTHER, name: "Observer", provider: "railway" });
  client = bridge.client(`http://127.0.0.1:${app.port}`);
});

after(async () => {
  await app?.stop();
  await bridge?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const asFleet = (op: string, input: object, crud: string[], extra: object = {}) => client.callOp(op, input as never, { caller: FLEET, prd: "fleet", wf: [op], crud: crud as never, ...extra });
const body = (a: { body: unknown }) => (a.body as { output?: Record<string, any> } | null)?.output ?? {};

async function agents(): Promise<string[]> {
  const ids = bridge.ids.agents.filter((x) => x.mode === "free").map((x) => x.id as string);
  for (let i = 0; i < 50; i++) {
    const out = await asFleet("access_list", { v: 1, subjects: [{ kind: "all" }] }, ["read"]);
    if (ids.every((id) => body(out).items?.some((it: { id: string }) => it.id === `agent_area:${id}`))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return ids;
}

test("real path: Governance lists each agent's own memory area; the SDK validates the answer; notShown is stated", async () => {
  const ids = await agents();
  assert.ok(ids.length >= 2);
  const out = await asFleet("access_list", { v: 1, subjects: [{ kind: "agent", id: ids[0] as string }], sweepId: "sw_real" }, ["read"]);
  assert.equal(out.status, 200, `${out.code}`);
  const o = body(out);
  assert.equal(o.sweepId, "sw_real");
  assert.equal(o.complete, false);
  assert.deepEqual(o.notShown.map((n: { kind: string }) => n.kind).slice(0, 3), ["team_area", "scope_rows", "held_calls"]);
  assert.deepEqual(o.items.map((i: { id: string }) => i.id), [`agent_area:${ids[0]}`]);
  assert.equal(o.items[0].revocable, false);
  const sweep = body(await asFleet("access_list", { v: 1, subjects: [{ kind: "all" }], limit: 1 }, ["read"]));
  assert.equal(sweep.items.length, 1);
  assert.ok(sweep.nextCursor, "a second page follows");
});

test("real path: an app that is not Governance, and an agent, are refused on both ops", async () => {
  const [agent] = await agents();
  const revokeIn = { v: 1, plan: "pln_01TEST", attempt: 1, subject: { kind: "person", id: "ct_anna" }, items: [{ id: "team_grant:abc", digest: `sha256:${"0".repeat(64)}` }] };
  const listIn = { v: 1, subjects: [{ kind: "all" }] };
  for (const [op, input, crud] of [["access_list", listIn, ["read"]], ["access_revoke", revokeIn, ["update"]]] as const) {
    const app = await client.callOp(op, input as never, { caller: OTHER, prd: "observer", wf: [op], crud: crud as never, ...(op === "access_revoke" ? { idempotencyKey: idem() } : {}) });
    assert.equal(app.status, 403, `${op}: ${app.code}`);
    assert.equal(app.code, "no_access", op);
    const asAgent = await client.callOp(op, input as never, { agent: agent as never, ...(op === "access_revoke" ? { idempotencyKey: idem() } : {}) });
    assert.equal(asAgent.status, 403, `${op} as agent: ${asAgent.code}`);
  }
});

test("real path: access_revoke through the SDK (idempotency key, receipt, schema): areas are never revoked, an unknown grant is already gone", async () => {
  const [agent] = await agents();
  const first = await asFleet("access_revoke", { v: 1, plan: "pln_01TEST", attempt: 1, subject: { kind: "person", id: "ct_anna" }, items: [{ id: "team_grant:abc", digest: `sha256:${"0".repeat(64)}` }, { id: `agent_area:${agent}`, digest: `sha256:${"0".repeat(64)}` }] }, ["update"], { idempotencyKey: idem() });
  assert.equal(first.status, 200, `${first.code}`);
  assert.deepEqual(body(first).results, [{ id: "team_grant:abc", outcome: "already_gone" }, { id: `agent_area:${agent}`, outcome: "not_revocable", code: "areas_never_touched" }]);
  // no key on a write: the SDK refuses (idempotency required), nothing runs
  const bare = await asFleet("access_revoke", { v: 1, plan: "pln_01TEST", attempt: 2, subject: { kind: "person", id: "ct_anna" }, items: [{ id: "team_grant:abc", digest: `sha256:${"0".repeat(64)}` }] }, ["update"]);
  assert.ok(bare.status >= 400 && bare.status < 500, `${bare.status} ${bare.code}`);
});

test("real path: a bad call is refused by the schema before the handler", async () => {
  for (const input of [{ v: 1, subjects: [{ kind: "all" }, { kind: "unlinked" }] }, { v: 1, subjects: [{ kind: "all" }], limit: 500 }, { v: 2, subjects: [{ kind: "all" }] }])
    assert.equal((await asFleet("access_list", input, ["read"])).status, 400, JSON.stringify(input));
  const eleven = Array.from({ length: 11 }, (_, n) => ({ id: `team_grant:${n}x`, digest: `sha256:${"0".repeat(64)}` }));
  assert.equal((await asFleet("access_revoke", { v: 1, plan: "pln_01TEST", attempt: 1, subject: { kind: "person", id: "p" }, items: eleven }, ["update"], { idempotencyKey: idem() })).status, 400);
});
