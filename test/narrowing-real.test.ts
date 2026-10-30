// L2 real-to-real: the REAL Knowledge app (real Miniapp SDK: claim, slice, op-proof verification incl. the context
// digest) driven by the conformance fake bridge, which signs op calls exactly like the bridge does after the context
// hook chain. The context is the one Rules' `rules_context` hook adds (opt2-tealbrick-rules src/hooks.ts):
// `rules.narrowing {v: 1, ruleId, reason, memoryTags}`. No memory engine runs here, so recall answers from keyword
// search (`degraded: true`); the engine path is covered in knowledge.test.ts with the fake GBrain.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type AppClient, appEnv, createFakeBridge, type FakeBridge, TEST_ROOTS_ENV } from "@opt2-tealbrick/conformance";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import start from "../conformance.start.ts";
import { conformanceManifest } from "../conformance.strip.ts";

const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as Manifest;
const RULE = "rul_01REALRULE0000000000000000";
const narrowing = (memoryTags: Record<string, string[]>, v = 1): Record<string, Json> => ({
  "rules.narrowing": { v, ruleId: RULE, reason: "Requests from team Support: only work-tagged memories", memoryTags },
});

let bridge: FakeBridge;
let app: { url: string; stop(): Promise<void> };
let client: AppClient;
let dataDir: string;
let key = 0;
const idem = () => `g5-real-${String(++key).padStart(4, "0")}`;

before(async () => {
  // C380: the harness serves the manifest without the guarded Governance ops (conformance.strip.ts), so the fake bridge serves that one
  bridge = await createFakeBridge({ manifest: conformanceManifest(manifest) });
  await bridge.control.publishKeySet();
  dataDir = mkdtempSync(join(tmpdir(), "knowledge-g5-"));
  const env = appEnv(bridge, dataDir, { [TEST_ROOTS_ENV]: JSON.stringify(bridge.testRootJwks()), TBCONF_PORT: "0", TBCONF_STUB_ENGINE: "0" });
  app = await start(env);
  await bridge.control.waitForClaim(30_000);
  await bridge.control.waitForSliceRevision(1, 30_000);
  client = bridge.client(app.url);
});

after(async () => {
  await app?.stop();
  await bridge?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function ok(op: string, input: Json, context?: Record<string, Json>): Promise<Record<string, any>> {
  const view = client.opView(op);
  const write = view?.effect !== "read";
  const answer = await client.callOp(op, input, { ...(context ? { context } : {}), ...(write ? { idempotencyKey: idem() } : {}) });
  assert.equal(answer.status, 200, `${op}: ${answer.text}`);
  const body = answer.body as { status: string; output: Record<string, any> };
  assert.equal(body.status, "ok");
  return body.output;
}

test("L2 G5: a Rules narrowing {anyOf: [work]} reaches the real app and only work-tagged memories return", async () => {
  // agentAdded runs when the app installs the slice; wait for the agent's own area.
  let own: string | undefined;
  for (let i = 0; i < 50 && !own; i++) {
    own = ((await ok("areas_list", {})).areas as { id: string; own: boolean }[]).find((a) => a.own)?.id;
    if (!own) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(own, "the agent's own area exists");
  const work = (await ok("remember", { text: "osprey quarterly plan for the Support desk", tags: ["work"] })).documentId;
  const personal = (await ok("remember", { text: "osprey holiday photos from my family", tags: ["personal"] })).documentId;
  const untagged = (await ok("remember", { text: "osprey note with no tags" })).documentId;

  const plain = await ok("recall", { query: "osprey", area: own });
  assert.deepEqual(plain.results.map((r: { documentId: string }) => r.documentId).sort(), [work, personal, untagged].sort());
  for (const r of plain.results) assert.ok(Array.isArray(r.tags), "every recall item carries tags[] for Rules' after hook");

  const narrowed = await ok("recall", { query: "osprey", area: own }, narrowing({ anyOf: ["work"] }));
  assert.deepEqual(
    narrowed.results.map((r: { documentId: string; tags: string[] }) => [r.documentId, r.tags]),
    [[work, ["work"]]],
    "only the work-tagged memory; the personal and the untagged memory do not return",
  );

  const search = await ok("documents_search", { query: "osprey", area: own }, narrowing({ anyOf: ["work"] }));
  assert.deepEqual(search.hits.map((h: { id: string }) => h.id), [work]);

  const hidden = await client.callOp("document_get", { id: personal }, { context: narrowing({ anyOf: ["work"] }) });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.code, "not_found");

  const nothing = await ok("recall", { query: "osprey", area: own }, narrowing({ anyOf: [] }));
  assert.deepEqual(nothing.results, [], "anyOf [] (Rules: disjoint merged lists) = nothing passes (C115)");

  const upper = await ok("recall", { query: "osprey", area: own }, narrowing({ anyOf: [" WORK "] }));
  assert.deepEqual(upper.results.map((r: { documentId: string }) => r.documentId), [work], "tags compare after normalizeTag");

  const none = await ok("recall", { query: "osprey", area: own }, narrowing({ noneOf: ["personal"] }));
  assert.deepEqual(none.results.map((r: { documentId: string }) => r.documentId).sort(), [work, untagged].sort());
});

test("L2 G5: an unknown narrowing version is refused with narrowing_unsupported (409, fail closed)", async () => {
  const answer = await client.callOp("recall", { query: "osprey" }, { context: narrowing({ anyOf: ["work"] }, 2) });
  assert.equal(answer.status, 409, answer.text);
  assert.equal(answer.code, "narrowing_unsupported");
});
