// L2 real-to-real for QA F88/F90: the REAL Knowledge app (real Miniapp SDK, claim, slice, op proofs) driven by the
// conformance fake bridge, with the REAL GBrain client and transport talking HTTP to a GBrain stand-in whose `query`
// answer has the exact framing of a real upstream 0.60.57.0 keyless answer (fixture captured from the pinned upstream:
// bare row array, `[gbrain notice degraded_recall kind=degraded]` block, `_meta.gbrain_notices`, `_meta.retrieval`).
// Knowledge 0.1.15 read 0 rows from that answer and reported `ok, via engine, degraded:false` (F88).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type AppClient, appEnv, createFakeBridge, type FakeBridge, TEST_ROOTS_ENV } from "@opt2-tealbrick/conformance";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import start from "../conformance.start.ts";
import { conformanceManifest } from "../conformance.strip.ts";
import manifestJson from "../tealbrick.manifest.json" with { type: "json" };
import { type FakeGBrain, fakeGBrain } from "./helpers.ts";

const manifest = manifestJson as unknown as Manifest;
const RULE = "rul_01REALRULE0000000000000000";
const narrowing = (memoryTags: Record<string, string[]>): Record<string, Json> => ({
  "rules.narrowing": { v: 1, ruleId: RULE, reason: "Requests from team Support: only work-tagged memories", memoryTags },
});
/** manifest runtime.services gbrain.helper.port: the SDK calls the C6 helper on the engine host at this port */
const HELPER_PORT = (manifest.runtime.services?.find((s) => s.id === "gbrain") as { helper?: { port: number } } | undefined)?.helper?.port ?? 0;

let gbrain: FakeGBrain;
let helper: Server;
let bridge: FakeBridge;
let app: { url: string; stop(): Promise<void> };
let client: AppClient;
let dataDir: string;
let key = 0;
const idem = () => `f88-real-${String(++key).padStart(4, "0")}`;

before(async () => {
  gbrain = await fakeGBrain();
  // C6 helper stand-in (`gbrain sources add`): what tb-exec runs inside the gbrain service.
  helper = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/sources") gbrain.sources.add(String(JSON.parse(Buffer.concat(chunks).toString("utf8")).id));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => helper.listen(HELPER_PORT, "127.0.0.1", resolve));
  // C380: the harness serves the manifest without the guarded Governance ops (conformance.strip.ts), so the fake bridge serves that one
  bridge = await createFakeBridge({ manifest: conformanceManifest(manifest) });
  await bridge.control.publishKeySet();
  dataDir = mkdtempSync(join(tmpdir(), "knowledge-f88-"));
  const env = appEnv(bridge, dataDir, {
    [TEST_ROOTS_ENV]: JSON.stringify(bridge.testRootJwks()),
    TBCONF_PORT: "0",
    TBCONF_STUB_ENGINE: "0",
    KNOWLEDGE_GBRAIN_URL: gbrain.url,
    KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken,
  });
  app = await start(env);
  await bridge.control.waitForClaim(30_000);
  await bridge.control.waitForSliceRevision(1, 30_000);
  client = bridge.client(app.url);
});

after(async () => {
  await app?.stop();
  await bridge?.close();
  await new Promise<void>((resolve) => (helper ? helper.close(() => resolve()) : resolve()));
  await gbrain?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function ok(op: string, input: Json, context?: Record<string, Json>): Promise<Record<string, any>> {
  const write = client.opView(op)?.effect !== "read";
  const answer = await client.callOp(op, input, { ...(context ? { context } : {}), ...(write ? { idempotencyKey: idem() } : {}) });
  assert.equal(answer.status, 200, `${op}: ${answer.text}`);
  return (answer.body as { output: Record<string, any> }).output;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("L2 F88: a degraded upstream answer is read (rows found), reported degraded per area, and keyword search is added", async () => {
  const own = await until("own area", async () => ((await ok("areas_list", {})).areas as { id: string; own: boolean }[]).find((a) => a.own)?.id);
  const kettle = (await ok("remember", { text: "The office kettle is teal and lives on the second shelf.", tags: ["work"] })).documentId as string;
  // the projection reaches the engine (outbox drain after the write)
  await until("projection", async () => [...gbrain.pages.values()].some((pages) => [...pages.keys()].some((slug) => slug.endsWith(kettle.toLowerCase()))));
  gbrain.queryReply = "upstream-degraded";
  try {
    const out = await ok("recall", { query: "teal kettle", area: own });
    assert.deepEqual(out.results.map((r: { documentId: string }) => r.documentId), [kettle], JSON.stringify(out));
    assert.equal(out.degraded, true);
    assert.deepEqual(out.areas, [{ area: own, ok: true, via: "engine", degraded: ["embed_unavailable:no_provider"] }]);
    // F90 through the real SDK path: a write addressing a hidden memory answers like a missing one
    const secret = (await ok("remember", { text: "kettle descaling budget", tags: ["personal"] })).documentId as string;
    const hidden = await client.callOp("document_update", { id: secret, tags: ["work"] }, { context: narrowing({ anyOf: ["work"] }), idempotencyKey: idem() });
    const missing = await client.callOp("document_update", { id: "kdoc_01ZZZZZZZZZZZZZZZZZZZZZZZZ", tags: ["work"] }, { context: narrowing({ anyOf: ["work"] }), idempotencyKey: idem() });
    assert.deepEqual([hidden.status, hidden.code], [404, "not_found"]);
    assert.deepEqual([missing.status, missing.code], [404, "not_found"]);
    const violation = await client.callOp("remember", { text: "untagged under the rule" }, { context: narrowing({ anyOf: ["work"] }), idempotencyKey: idem() });
    assert.deepEqual([violation.status, violation.code], [409, "narrowing_violation"]);
  } finally {
    gbrain.queryReply = undefined;
  }
  // healthy engine: quiet (L34)
  const healthy = await ok("recall", { query: "teal kettle", area: own });
  assert.equal(healthy.degraded, false);
  assert.deepEqual(healthy.areas, [{ area: own, ok: true, via: "engine" }]);
});
