// C392 R2 real-to-real: the REAL Knowledge app on the real Miniapp SDK (claim, slice, person session, CSRF, schema check,
// idempotency store) driven by the conformance fake bridge. Proves at the SDK gate:
// - the owner's forget is a person op the SDK runs at once (SDK handlePersonOp never holds a person op), so the owner sees
//   the confirmation from relationship_forget_scan (with titles) BEFORE the page calls the forget;
// - a retried forget with the same idempotency key answers the STORED report (not `person_unknown`), and runs once;
// - an agent cannot reach either op (audience person).
// Relationships rows are written straight into the app database (no Governance directory runs here).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { type AppClient, appEnv, createFakeBridge, type FakeBridge, type PersonSession, TEST_ROOTS_ENV } from "@opt2-tealbrick/conformance";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import start from "../conformance.start.ts";
import { conformanceManifest } from "../conformance.strip.ts";

const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as Manifest;
const PERSON = "rp_01HZXRSB6V0N7Q2M3K4J5P6W8Y";

let bridge: FakeBridge;
let app: { url: string; stop(): Promise<void> };
let client: AppClient;
let owner: PersonSession;
let dataDir: string;

before(async () => {
  bridge = await createFakeBridge({ manifest: conformanceManifest(manifest) });
  await bridge.control.publishKeySet();
  dataDir = mkdtempSync(join(tmpdir(), "knowledge-r2-"));
  const env = appEnv(bridge, dataDir, { [TEST_ROOTS_ENV]: JSON.stringify(bridge.testRootJwks()), TBCONF_PORT: "0", TBCONF_STUB_ENGINE: "0" });
  app = await start(env);
  await bridge.control.waitForClaim(30_000);
  await bridge.control.waitForSliceRevision(1, 30_000);
  client = bridge.client(app.url);
  const session = await client.signIn();
  assert.ok(session, "owner session");
  owner = session;
  // one third-party person of operator ct_anna, and one Knowledge document that names her (synthetic Acme LLC data)
  const db = new DatabaseSync(join(dataDir, "app.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  db.prepare("INSERT INTO kn_rel_people (id, operator, label, created_at, updated_at) VALUES (?, 'ct_anna', 'Dana Client', ?, ?)").run(PERSON, now, now);
  db.prepare("INSERT INTO kn_relationships (operator, person_id) VALUES ('ct_anna', ?)").run(PERSON);
  db.prepare("INSERT INTO kn_rel_identities (person_id, operator, kind, value, created_at, created_by) VALUES (?, 'ct_anna', 'email', 'dana.client@acme-llc.example', ?, 'test')").run(PERSON, now);
  db.close();
});

after(async () => {
  await app?.stop();
  await bridge?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("real path: scan (titles + confirmation) then forget run at once for the owner; the same key replays the stored report; agents cannot reach either op", async () => {
  const created = await client.personOp(owner, "library_document_create", { area: "company", title: "Call with Dana Client", body: "Agenda." }, { idempotencyKey: "r2-real-doc-0001" });
  assert.equal(created.status, 200, `${created.code} ${created.text}`);
  const doc = String((created.output as { id: string }).id);

  const scan = await client.personOp(owner, "relationship_forget_scan", { operator: "ct_anna", person: PERSON, purgeDocuments: [doc] });
  assert.equal(scan.status, 200, `${scan.code} ${scan.text}`);
  const s = scan.output as { matched: { documentId: string; title: string }[]; confirmation: string };
  assert.deepEqual(s.matched.map((m) => [m.documentId, m.title]), [[doc, "Call with Dana Client"]]);
  assert.match(s.confirmation, /^Forget "Dana Client" \(rp_\w+\) in the relationships of operator ct_anna\.\nThis delete is permanent\./u);

  const input = { operator: "ct_anna", person: PERSON, purgeDocuments: [doc] };
  const first = await client.personOp(owner, "relationship_forget", input, { idempotencyKey: "r2-real-forget-0001" });
  assert.equal(first.status, 200, `a person op is never held by the SDK: ${first.code} ${first.text}`);
  const report = first.output as { deleted: { relationships: { people: number } }; documents: { purged: { documentId: string; engine: string }[] } };
  assert.equal(report.deleted.relationships.people, 1);
  assert.deepEqual(report.documents.purged.map((p) => p.documentId), [doc]);
  assert.ok(!JSON.stringify(report).includes("Dana"), "the stored report has no label or title");

  // a retried call (same key, same input) answers the stored report; the handler does not run again (else person_unknown)
  const replay = await client.personOp(owner, "relationship_forget", input, { idempotencyKey: "r2-real-forget-0001" });
  assert.equal(replay.status, 200, `${replay.code} ${replay.text}`);
  assert.deepEqual(replay.output, first.output);
  // a NEW key runs the handler: ct_anna has no stored people any more and no directory runs here, so the operator check
  // answers directory_unavailable (with a directory copy listing her: person_unknown, see test/forget.test.ts)
  const fresh = await client.personOp(owner, "relationship_forget", input, { idempotencyKey: "r2-real-forget-0002" });
  assert.deepEqual([fresh.status, fresh.code], [409, "directory_unavailable"]);
  // the same key with another input is a conflict, never a second run
  const other = await client.personOp(owner, "relationship_forget", { operator: "ct_anna", person: PERSON }, { idempotencyKey: "r2-real-forget-0001" });
  assert.equal(other.status, 409);

  // agents: audience person, refused at the SDK gate before any handler
  const agent = bridge.ids.agents.find((x) => x.mode === "free")?.id;
  assert.ok(agent);
  for (const op of ["relationship_forget", "relationship_forget_scan"]) {
    const a = await client.callOp(op, { operator: "ct_anna", person: PERSON } as never, { agent: agent as never, idempotencyKey: "r2-real-agent-0001" });
    assert.equal(a.status, 403, `${op}: ${a.code}`);
  }
});
