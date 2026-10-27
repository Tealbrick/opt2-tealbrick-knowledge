// QA-KN24-2 (knowledge#24): the dynamic `engine` op is not wrapped by `narrowed`, so the app-caller guard (an app only lists
// areas and creates or updates documents in a shared area) must hold there too, also when the owner (or a companion grant that
// names `engine`) gives the app a row on an agent's private area. Ported from the QA repro (zz-qa-engine-app).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { knowledgeDefinition } from "../src/app.ts";
import { context, type FakeGBrain, FakeScopes, fakeGBrain, memoryDb, TestError } from "./helpers.ts";

const ADA = "agt_01AAAAAAAAAAAAAAAAAAAAAAAA";
const ADA_AREA = "agent-01aaaaaaaaaaaaaaaaaaaaaaaa";
const OBS = "ins_01M5PM73ZZ0BSERVER00000000";
let gbrain: FakeGBrain;
before(async () => {
  gbrain = await fakeGBrain();
});
after(async () => {
  await gbrain.close();
});

const code = (e: unknown) => (e as { code?: string }).code;

async function setup() {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken, KNOWLEDGE_MODEL_PROVIDER: "openai" };
  const { definition } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0 });
  const warns: string[] = [];
  const log = { debug() {}, info() {}, warn: (m: string) => void warns.push(m), error() {} };
  await definition.events?.agentAdded?.({ id: ADA, name: "Ada", mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("x"); }, statusChanged() {}, ownerLink: () => null });
  scopes.applyDefaults(ADA);
  // the app: default grants (shared read on company + its own write row) plus an owner row on Ada's area
  scopes.set(OBS, "company", "read");
  scopes.set(OBS, OBS, "read_write");
  scopes.set(OBS, ADA_AREA, "read_write");
  const callServiceHelper = (async (_s: string, _p: string, body: Json) => {
    gbrain.sources.add(String((body as Record<string, unknown>).id));
    return {};
  }) as OpContext["callServiceHelper"];
  const app = (extra: Partial<OpContext> = {}, listed = true) => ({ ...context(db, scopes, OBS, { callServiceHelper, log, ...extra }), caller: { type: "app", id: OBS, name: "Observer", product: "observer", listed } }) as unknown as OpContext;
  const agent = (extra: Partial<OpContext> = {}) => context(db, scopes, ADA, { callServiceHelper, ...extra });
  const dyn = definition.dynamic?.engine;
  assert.ok(dyn);
  // provision the sources through an agent call
  const recall = definition.handlers.recall;
  await (typeof recall === "function" ? recall : (recall as { run: (i: Json, c: OpContext) => Promise<unknown> }).run)({ query: "w" } as Json, agent());
  return { definition, dyn, app, agent, warns };
}

test("QA-KN24-2: an app caller is refused on every dynamic engine tool (write into an agent area, single read, fan-out); an agent still fans out", async () => {
  const { dyn, app, agent } = await setup();
  await assert.rejects(dyn.call("gb_remember", { fact: "intrusion by app", area: ADA_AREA }, app({ idempotencyKey: "idem-000000000001" })), (e) => code(e) === "scope_denied");
  await assert.rejects(dyn.call("gb_remember", { fact: "company by app" }, app({ idempotencyKey: "idem-000000000002" })), (e) => code(e) === "scope_denied", "not even the company area: the engine op is outside the app's three ops");
  await assert.rejects(dyn.call("gb_entity", { name: "x", area: ADA_AREA }, app()), (e) => code(e) === "scope_denied");
  await assert.rejects(dyn.call("gb_entity", { name: "x" }, app()), (e) => code(e) === "scope_denied", "the fan-out over readable areas reaches nobody");
  // control: the agent's own fan-out is unchanged (company + its own area)
  const out = (await dyn.call("gb_entity", { name: "x" }, agent())) as Record<string, any>;
  assert.deepEqual(out.areas.map((a: { area: string }) => a.area).sort(), ["company", ADA_AREA].sort());
});

test("QA-KN24-2: the static ops keep the same rule (an agent's area is not found for an app; delete is refused)", async () => {
  const { definition, app } = await setup();
  const run = (id: string) => {
    const h = definition.handlers[id];
    return typeof h === "function" ? h : (h as { run: (i: Json, c: OpContext) => Promise<unknown> }).run;
  };
  await assert.rejects(run("document_create")({ title: "t", area: ADA_AREA } as Json, app({ idempotencyKey: "idem-000000000003" })), (e) => code(e) === "not_found");
  await assert.rejects(run("document_delete")({ id: "kdoc_x" } as Json, app()), (e) => code(e) === "scope_denied");
});

test("QA-KN24-4: an app caller that is no longer listed (companion edge removed) still runs, but every write leaves a warning", async () => {
  const { definition, app, warns } = await setup();
  const create = definition.handlers.document_create;
  const run = typeof create === "function" ? create : (create as { run: (i: Json, c: OpContext) => Promise<unknown> }).run;
  await run({ title: "listed" } as Json, app({ idempotencyKey: "idem-000000000004" }));
  assert.equal(warns.filter((w) => /not listed/u.test(w)).length, 0, "a listed app is quiet");
  await run({ title: "unlisted" } as Json, app({ idempotencyKey: "idem-000000000005" }, false));
  assert.equal(warns.filter((w) => /not listed/u.test(w)).length, 1);
});
