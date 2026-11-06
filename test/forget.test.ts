// C392 R2 forget person (Knowledge-local stores): owner only, never an agent; the person's rows go, one tombstone stays; the
// scan finds the person in every document place (title, body, an old revision, a comment, a soft-deleted document) and never
// returns text; a purge hard-deletes the picked documents and purges their engine pages through the helper (queued while the
// engine is down); every report states what is not possible yet. Synthetic "Acme LLC" data.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { knowledgeDefinition } from "../src/app.ts";
import { syncDirectory } from "../src/directory-feed.ts";
import { forgetTerms } from "../src/forget.ts";
import { NARROWING_POLICY } from "../src/handlers.ts";
import { areaSourceId } from "../src/ids.ts";
import { INLINE_PURGE_LIMIT, NOT_POSSIBLE_YET } from "../src/relationship-ops.ts";
import { context, FakeScopes, memoryDb, TestError } from "./helpers.ts";

const ADA = "agt_01AAAAAAAAAAAAAAAAAAAAAAAA"; // owned by ct_anna
const BO = "agt_01BBBBBBBBBBBBBBBBBBBBBBBB"; // owned by ct_ben

function feed(): Record<string, unknown> {
  return {
    v: 1,
    revision: 1,
    teams: [],
    contacts: [
      { id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: [] },
      { id: "ct_ben", kind: "person", status: "active", trust: "trusted", handles: [] },
    ],
    agents: [
      { id: ADA, status: "active", trust: "trusted", owner: "ct_anna" },
      { id: BO, status: "active", trust: "trusted", owner: "ct_ben" },
    ],
  };
}

const OWNER = { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } as const;
const rejects = (code: string) => (error: unknown) => error instanceof TestError && error.code === code;
const CITE = { source: "email", ref: "msg-acme-0042", at: "2026-11-05T09:30:00Z" };
const EMAIL = "Dana.Client@Acme-LLC.example";
const EMAIL_NORM = "dana.client@acme-llc.example";
const PHONE = "+49 151 2345 6789";
const LABEL = "Dana Client";
/** Document and comment text: never in any answer. */
const BODY_TEXT = ["agenda: pricing", EMAIL_NORM, "4915123456789", "phone numbers moved", "sent to dana client today", "notes about", "price list 2026"];
/** Titles and the label: in the owner's scan answer and confirmation only, never in the forget report, a receipt or the log. */
const TITLES = ["dana client", "Call with Dana Client", "Quarterly review", "Old contact sheet", "Deleted notes", "Pricing"];
const MISSING = "kdoc_01ZZZZZZZZZZZZZZZZZZZZZZZZ";

async function setup(opts: { engine?: boolean } = {}) {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env: Record<string, string> = { KNOWLEDGE_ENGINE: "gbrain" };
  // An engine is configured (never reached: the drain timer is off and forget talks only to the helper).
  if (opts.engine !== false) Object.assign(env, { KNOWLEDGE_GBRAIN_URL: "http://127.0.0.1:9", KNOWLEDGE_GBRAIN_ADMIN_TOKEN: "t".repeat(40) });
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0 });
  const callApp = (async () => ({ status: "ok", output: feed() })) as unknown as OpContext["callApp"];
  await syncDirectory(db, callApp as never);
  const helperCalls: { serviceId: string; path: string; body: unknown }[] = [];
  const engine = { answer: (async () => ({ status: "purged" })) as () => Promise<unknown> };
  const callServiceHelper = (async (serviceId: string, path: string, body: unknown) => {
    helperCalls.push({ serviceId, path, body });
    return engine.answer();
  }) as unknown as OpContext["callServiceHelper"];
  const receipts: string[] = [];
  const ctx = (agent: string, extra: Partial<OpContext> = {}) => context(db, scopes, agent, { callApp, callServiceHelper, ...extra });
  const owner = (extra: Partial<OpContext> = {}) => ctx(ADA, { caller: OWNER, ...extra });
  const declared = (name: string) => definition.manifest.operations.find((o) => o.id === name);
  const run = async (name: string, input: Record<string, unknown>, c: OpContext) => {
    const op = declared(name);
    assert.ok(op, name);
    assert.ok((validateInput({ ...op, standard: false } as never, input as never) as { ok: boolean }).ok, `${name} input ${JSON.stringify(input)}`);
    const spec = definition.handlers[name] as { run: (input: Json, ctx: OpContext) => Promise<unknown>; redact?: (input: Json, output?: Json) => string };
    const output = (await spec.run(input as Json, { ...c, op: { ...op, standard: false } } as OpContext)) as Record<string, any>;
    const checked = validateInput({ ...op, standard: false, input: op.output } as never, output as never) as { ok: boolean };
    assert.ok(checked.ok, `${name} output: ${JSON.stringify(checked)}`);
    if (spec.redact) receipts.push(spec.redact(input as Json, output as Json));
    return output;
  };
  const services = knowledge.bind(db);
  await services.areas.ensureShared(scopes.asStore());
  const agentArea = await services.areas.ensureAgentArea({ id: ADA, name: "Ada" }, scopes.asStore());
  return { db, definition, knowledge, services, agentArea: agentArea.id, ctx, owner, run, receipts, helperCalls, engine, scopes };
}

/** ct_anna's agent proposes Dana (email + phone, label, history); ct_ben's agent knows the same email as its own person. */
async function people(env: Awaited<ReturnType<typeof setup>>) {
  const { run, ctx } = env;
  const dana = await run(
    "relationship_propose",
    { new: { label: LABEL, identities: [{ kind: "email", value: EMAIL }, { kind: "phone", value: PHONE }] }, type: "customer", history: [{ kind: "promise", text: "Dana Client asked for the Q4 price list", open: true }], citation: CITE },
    ctx(ADA),
  );
  await run("relationship_propose", { person: dana.person, label: "Dana C. Client", citation: CITE }, ctx(ADA));
  const bens = await run("relationship_propose", { new: { label: "Dana (Acme)", identities: [{ kind: "email", value: EMAIL }] }, history: [{ kind: "contact", text: "first call" }], citation: CITE }, ctx(BO));
  return { dana: String(dana.person), bens: String(bens.person) };
}

/** Documents that name Dana in each place, plus one that does not. */
function documents(env: Awaited<ReturnType<typeof setup>>) {
  const { store } = env.services;
  const actor = OWNER.id;
  const title = store.createDocument({ area: "company", title: "Call with Dana Client", body: "Agenda: pricing.", actor });
  const body = store.createDocument({ area: "company", title: "Quarterly review", body: `Contact: ${EMAIL.toUpperCase()} for the review.`, actor });
  const old = store.createDocument({ area: env.agentArea, title: "Old contact sheet", body: `Phone +4915123456789, ask for Dana.`, actor });
  store.updateDocument(old.id, { body: "Phone numbers moved to the CRM." }, undefined, actor);
  const comment = store.createDocument({ area: "company", title: "Pricing", body: "Price list 2026.", actor });
  store.addComment(comment.id, "Sent to dana client today.", undefined, actor);
  const deleted = store.createDocument({ area: "company", title: "Deleted notes", body: `Notes about ${EMAIL_NORM}.`, actor });
  store.deleteDocument(deleted.id, actor);
  const other = store.createDocument({ area: "company", title: "Unrelated", body: "Nothing about anyone. Dan was here.", actor });
  // a link and a comment on the body document (both must go with a purge)
  store.addLink(title.id, body.id, "related", actor);
  store.addComment(body.id, "Checked.", undefined, actor);
  return { title: title.id, body: body.id, old: old.id, comment: comment.id, deleted: deleted.id, other: other.id };
}

const count = (db: ReturnType<typeof memoryDb>, sql: string, ...args: unknown[]) => Number(db.prepare(sql).get(...args)?.n ?? 0);

test("C392 R2: only the owner forgets: an agent is refused; an unknown operator and another operator's person are refused", async () => {
  const env = await setup();
  const { dana, bens } = await people(env);
  await assert.rejects(env.run("relationship_forget", { operator: "ct_anna", person: dana }, env.ctx(ADA)), rejects("scope_denied"));
  await assert.rejects(env.run("relationship_forget_scan", { operator: "ct_anna", person: dana }, env.ctx(ADA)), rejects("scope_denied"));
  await assert.rejects(env.run("relationship_forget", { operator: "ct_nobody", person: dana }, env.owner()), rejects("person_unknown"));
  await assert.rejects(env.run("relationship_forget", { operator: "ct_ben", person: dana }, env.owner()), (e: unknown) => rejects("person_unknown")(e) && (e as TestError).httpStatus === 404);
  await assert.rejects(env.run("relationship_forget_scan", { operator: "ct_anna", person: bens }, env.owner()), rejects("person_unknown"));
  // nothing was deleted by the refused calls
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_people"), 2);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_log WHERE action = 'person_forgotten'"), 0);
});

test("C392 R2: forget deletes every row of the person, nothing of another person; one tombstone; kn_rel_log holds no identity value", async () => {
  const env = await setup();
  const { dana, bens } = await people(env);
  const before = (t: string, p: string) => count(env.db, `SELECT count(*) AS n FROM ${t} WHERE person_id = ?`, p);
  assert.equal(before("kn_rel_identities", dana), 2);
  const proposals = before("kn_rel_proposals", dana);
  assert.equal(proposals, 2, "type and label proposals");
  assert.equal(before("kn_rel_history", dana), 1);
  const benRows = ["kn_rel_identities", "kn_relationships", "kn_rel_history"].map((t) => before(t, bens));

  const out = await env.run("relationship_forget", { operator: "ct_anna", person: dana }, env.owner());
  assert.deepEqual(out.deleted.relationships, { people: 1, identities: 2, edges: 1, proposals, history: 1 });
  for (const t of ["kn_rel_identities", "kn_relationships", "kn_rel_proposals", "kn_rel_history"]) assert.equal(before(t, dana), 0, t);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_people WHERE id = ?", dana), 0);
  // ct_ben's person with the SAME email survives untouched
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_people WHERE id = ?", bens), 1);
  assert.deepEqual(["kn_rel_identities", "kn_relationships", "kn_rel_history"].map((t) => before(t, bens)), benRows);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_identities WHERE operator = 'ct_ben' AND value = ?", EMAIL_NORM), 1);

  const tomb = env.db.prepare("SELECT actor, operator, person_id, detail FROM kn_rel_log WHERE action = 'person_forgotten'").all();
  assert.equal(tomb.length, 1);
  assert.equal(tomb[0]?.actor, OWNER.id);
  assert.equal(tomb[0]?.operator, "ct_anna");
  assert.equal(tomb[0]?.person_id, dana);
  assert.match(String(tomb[0]?.detail), /^identities 2, edges 1, proposals 2, history 1; documents matched 0, purged 0, refused 0$/u);
  // the whole log (older rows of Dana included) carries no identity value and no label, in any column
  const log = JSON.stringify(env.db.prepare("SELECT * FROM kn_rel_log").all()).toLowerCase();
  for (const value of [EMAIL_NORM, "+4915123456789", "4915123456789", "dana client", "dana c. client", "dana (acme)", "q4 price list"]) assert.ok(!log.includes(value), `kn_rel_log holds ${value}`);
  assert.ok(env.receipts.every((r) => !r.toLowerCase().includes("dana")), "receipts name no person");
  // a second forget of the same person: the person is gone
  await assert.rejects(env.run("relationship_forget", { operator: "ct_anna", person: dana }, env.owner()), rejects("person_unknown"));
});

test("C392 R2: the scan finds title, body, an OLD revision only, a comment and a soft-deleted document in every area, with titles, never body text", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const d = documents(env);
  const scan = await env.run("relationship_forget_scan", { operator: "ct_anna", person: dana }, env.owner());
  const where = Object.fromEntries((scan.matched as { documentId: string; area: string; deleted: boolean; where: string[] }[]).map((m) => [m.documentId, [m.area, m.deleted, m.where]]));
  assert.deepEqual(where, {
    [d.title]: ["company", false, ["title", "revision"]],
    [d.body]: ["company", false, ["body", "revision"]],
    [d.old]: [env.agentArea, false, ["revision"]],
    [d.comment]: ["company", false, ["comment"]],
    [d.deleted]: ["company", true, ["body", "revision"]],
  });
  assert.deepEqual(scan.scan, { terms: 4, skippedShort: 0, truncated: false }, "label, email, phone with and without +");
  const titles = Object.fromEntries((scan.matched as { documentId: string; title: string }[]).map((m) => [m.documentId, m.title]));
  assert.deepEqual(titles, { [d.title]: "Call with Dana Client", [d.body]: "Quarterly review", [d.old]: "Old contact sheet", [d.comment]: "Pricing", [d.deleted]: "Deleted notes" });
  const text = JSON.stringify(scan).toLowerCase();
  for (const s of BODY_TEXT) assert.ok(!text.includes(s.toLowerCase()), `the scan returns no body or comment text (${s})`);
  // the scan changes nothing
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_people WHERE id = ?", dana), 1);
  // the forget's own scan returns the same matches
  const out = await env.run("relationship_forget", { operator: "ct_anna", person: dana }, env.owner());
  assert.deepEqual(
    out.documents.matched,
    scan.matched.map(({ title: _t, ...m }: Record<string, unknown>) => m),
    "the forget report (stored for an idempotent replay) has no titles",
  );
  const stored = [JSON.stringify(out), ...env.receipts, JSON.stringify(env.db.prepare("SELECT * FROM kn_rel_log").all())].join("\n").toLowerCase();
  for (const s of [...TITLES, ...BODY_TEXT]) assert.ok(!stored.includes(s.toLowerCase()), `no title, label or text in the forget report, receipts or log (${s})`);
  assert.deepEqual(out.documents.purged, []);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_documents"), 6, "no document is deleted without purgeDocuments");
});

test("C392 R2: forget terms: lower-cased, phone with and without +, short terms skipped", () => {
  assert.deepEqual(forgetTerms("Bo", ["+4915123456789", "U0ABC", "x@y"]), { terms: ["+4915123456789", "u0abc", "4915123456789"], skippedShort: 2 });
});

test("C392 R2: purge of a matched document leaves no row anywhere and purges its engine page through the helper", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const d = documents(env);
  const acme = () => count(env.db, "SELECT count(*) AS n FROM kn_documents_fts WHERE kn_documents_fts MATCH ?", '"acme"');
  assert.equal(acme(), 2, "the keyword index holds the email of both documents (the soft-deleted one too)");
  const out = await env.run("relationship_forget", { operator: "ct_anna", person: dana, purgeDocuments: [d.body, d.deleted] }, env.owner());
  assert.deepEqual(out.documents.purged, [
    { documentId: d.body, area: "company", engine: "purged" },
    { documentId: d.deleted, area: "company", engine: "purged" },
  ]);
  assert.deepEqual(out.documents.pending, []);
  assert.deepEqual(out.documents.refused, []);
  for (const id of [d.body, d.deleted]) {
    assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_documents WHERE id = ?", id), 0);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_revisions WHERE document_id = ?", id), 0);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_comments WHERE document_id = ?", id), 0);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_links WHERE source_id = ? OR target_id = ?", id, id), 0);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_projection WHERE document_id = ?", id), 0);
  }
  assert.equal(acme(), 0, "no keyword index entry names the purged text");
  assert.deepEqual(env.db.prepare("PRAGMA foreign_key_check").all(), []);
  // the engine page of each purged document, through the helper (upstream refuses purge over MCP)
  assert.deepEqual(env.helperCalls, [
    { serviceId: "gbrain", path: "/purge-page", body: { source: areaSourceId("company"), document: d.body } },
    { serviceId: "gbrain", path: "/purge-page", body: { source: areaSourceId("company"), document: d.deleted } },
  ]);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_forget_queue"), 0);
  // the other matched documents stay
  for (const id of [d.title, d.old, d.comment, d.other]) assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_documents WHERE id = ?", id), 1);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_links"), 0, "the link to the purged document went with it");
  assert.match(String(env.db.prepare("SELECT detail FROM kn_rel_log WHERE action = 'person_forgotten'").get()?.detail), /documents matched 5, purged 2, refused 0$/u);
  assert.ok(env.receipts.at(-1)?.endsWith(": 2 documents purged, 0 engine pages pending, 0 refused"), env.receipts.at(-1));
});

test("C392 R2: engine down: the page purge is pending and queued; the drain purges it later; no engine: engine none", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const d = documents(env);
  env.engine.answer = async () => {
    throw new TestError("helper_unavailable", "the helper does not answer", 503);
  };
  const out = await env.run("relationship_forget", { operator: "ct_anna", person: dana, purgeDocuments: [d.title] }, env.owner());
  assert.deepEqual(out.documents.purged, [{ documentId: d.title, area: "company", engine: "pending" }]);
  assert.deepEqual(out.documents.pending, [{ documentId: d.title, area: "company", reason: "engine_pending" }]);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_documents WHERE id = ?", d.title), 0, "the document itself is gone at once");
  const row = env.db.prepare("SELECT source_id, attempts, last_error FROM kn_forget_queue WHERE document_id = ?").get(d.title);
  assert.deepEqual({ ...row }, { source_id: areaSourceId("company"), attempts: 1, last_error: "helper_unavailable" });
  // the background drain (projection timer) purges it once the helper answers; `absent` counts as done
  env.engine.answer = async () => ({ status: "absent" });
  env.db.prepare("UPDATE kn_forget_queue SET next_attempt_at = 0").run();
  const ctx = env.owner();
  const drained = await env.knowledge.drainForget(env.services, ctx);
  assert.deepEqual(drained, { done: [d.title], failed: [] });
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_forget_queue"), 0);
  // an unexpected helper answer is not "done"
  env.db.prepare("INSERT INTO kn_forget_queue (source_id, document_id, created_at) VALUES ('ka-000000000000000000000000', ?, 1)").run(MISSING);
  env.engine.answer = async () => ({ status: "maybe" });
  assert.deepEqual(await env.knowledge.drainForget(env.services, ctx), { done: [], failed: [MISSING] });
  assert.equal(env.db.prepare("SELECT last_error FROM kn_forget_queue").get()?.last_error, "purge_unconfirmed");

  const plain = await setup({ engine: false });
  const p = await people(plain);
  const pd = documents(plain);
  const none = await plain.run("relationship_forget", { operator: "ct_anna", person: p.dana, purgeDocuments: [pd.comment] }, plain.owner());
  assert.deepEqual(none.documents.purged, [{ documentId: pd.comment, area: "company", engine: "none" }]);
  assert.deepEqual(plain.helperCalls, []);
  assert.equal(count(plain.db, "SELECT count(*) AS n FROM kn_forget_queue"), 0);
});

test("C392 R2: a purge id the forget's scan did not match is refused and nothing of it is deleted", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const d = documents(env);
  const out = await env.run("relationship_forget", { operator: "ct_anna", person: dana, purgeDocuments: [d.other, MISSING, d.old] }, env.owner());
  assert.deepEqual(
    out.documents.refused.map((r: { documentId: string; reason: string }) => [r.documentId, r.reason.split(":")[0]]),
    [
      [d.other, "not_matched"],
      [MISSING, "not_matched"],
    ],
  );
  assert.deepEqual(out.documents.purged.map((p: { documentId: string }) => p.documentId), [d.old]);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_documents WHERE id = ?", d.other), 1);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_revisions WHERE document_id = ?", d.other), 1);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_projection WHERE document_id = ?", d.other), 1);
});

test("C392 R2: every scan and forget report states what is not possible yet (foundry, lcm-x, backups with the retention, research, unprojected GBrain pages)", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const scan = await env.run("relationship_forget_scan", { operator: "ct_anna", person: dana }, env.owner());
  const out = await env.run("relationship_forget", { operator: "ct_anna", person: dana }, env.owner());
  for (const report of [scan, out]) {
    const stores = (report.notPossibleYet as { store: string }[]).map((n) => n.store);
    for (const store of ["foundry", "lcm-x", "backups", "research", "gbrain_unprojected", "gbrain_tombstones"]) assert.ok(stores.includes(store), store);
    assert.deepEqual(report.notPossibleYet, NOT_POSSIBLE_YET);
  }
  const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));
  const backups = NOT_POSSIBLE_YET.find((n) => n.store === "backups")?.reason ?? "";
  assert.ok(backups.includes(`last ${manifest.backups.retain} scheduled backups`), backups);
  assert.ok(NOT_POSSIBLE_YET.every((n) => n.reason.length <= 400));
});

test("C392 R2: manifest ops, owner-only shapes, narrowing refused, helper path declared, skill tells agents they cannot forget", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));
  const op = (id: string) => (manifest.operations as Record<string, any>[]).find((o) => o.id === id) as Record<string, any>;
  const forget = op("relationship_forget");
  assert.deepEqual([forget.audience, forget.crud, forget.effect, forget.holdFamily, forget.idempotency, forget.receipt], ["person", ["delete"], "destructive", "destructive", "required", true]);
  const library = op("library_document_delete");
  assert.deepEqual([forget.effect, forget.holdFamily], [library.effect, library.holdFamily], "mirrors the owner's destructive document delete");
  const scan = op("relationship_forget_scan");
  assert.deepEqual([scan.audience, scan.crud, scan.effect, scan.idempotency, scan.receipt], ["person", ["read"], "read", "none", false]);
  assert.equal(NARROWING_POLICY.relationship_forget, "unsupported");
  assert.equal(NARROWING_POLICY.relationship_forget_scan, "unsupported");
  // S3-3: `/purge-page` is declared ONLY as a helper path of the `gbrain` service (nowhere else in the manifest)
  const where: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v === "/purge-page") where.push(path);
    else if (Array.isArray(v)) for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(manifest, "$");
  const services = manifest.runtime.services as { id: string; helper?: { paths: string[] } }[];
  const gbrainAt = services.findIndex((x) => x.id === "gbrain");
  assert.deepEqual(where, [`$.runtime.services[${gbrainAt}].helper.paths[${services[gbrainAt]?.helper?.paths.indexOf("/purge-page")}]`]);
  assert.deepEqual(services.filter((x) => x.helper?.paths.includes("/purge-page")).map((x) => x.id), ["gbrain"]);
  const skill = readFileSync(new URL("../skills/knowledge-relationships/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /You cannot forget a person/u);
  assert.match(skill, /Relationships page in Knowledge/u);
  // a forget under a tag narrowing is refused before it runs
  const env = await setup();
  const { dana } = await people(env);
  const narrowed = env.owner({ context: { "rules.narrowing": { v: 1, ruleId: "rul_01TESTRULE0000000000000000", reason: "work only", memoryTags: { anyOf: ["work"] } } } as OpContext["context"] });
  await assert.rejects(env.run("relationship_forget", { operator: "ct_anna", person: dana }, narrowed), rejects("narrowing_unsupported"));
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_people WHERE id = ?", dana), 1);
});

test("C392 migration 0005: applies after 0001-0004 with data; the queue holds ids only", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("0005_forget_queue.sql"));
  for (const f of files.filter((f) => f < "0005")) raw.exec(readFileSync(new URL(f, dir), "utf8"));
  raw.exec("INSERT INTO kn_rel_people (id, operator, label, created_at, updated_at) VALUES ('rp_1', 'ct_anna', 'Dana', 1, 1)");
  raw.exec(readFileSync(new URL("0005_forget_queue.sql", dir), "utf8"));
  assert.equal(raw.prepare("SELECT count(*) AS n FROM kn_rel_people").get()?.n, 1);
  const columns = raw.prepare("PRAGMA table_info(kn_forget_queue)").all().map((c) => c.name);
  assert.deepEqual(columns, ["source_id", "document_id", "attempts", "next_attempt_at", "last_error", "created_at"]);
});

test("S2: the confirmation (scan answer and hold view) names the person, says it is permanent, lists each document with area and title, and the not-possible-yet lines; the hold summary keeps ids and counts", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const d = documents(env);
  const input = { operator: "ct_anna", person: dana, purgeDocuments: [d.body, d.deleted, d.other] };
  const scan = await env.run("relationship_forget_scan", input, env.owner());
  const text = String(scan.confirmation);
  assert.ok(text.startsWith(`Forget "${LABEL}" (${dana}) in the relationships of operator ct_anna.`), text);
  assert.match(text, /This delete is permanent\. It cannot be undone/u);
  assert.match(text, /the person, 2 identities, 2 proposals, 1 history items/u);
  assert.ok(text.includes(`their memory engine pages (2):\n- company: "Quarterly review" (${d.body})\n- company: "Deleted notes" (${d.deleted}), already deleted in the Library\n`), text);
  assert.ok(text.includes(`Kept (this forget's scan does not match them, so they are not deleted): ${d.other}`), text);
  assert.match(text, /Other documents that name the person and stay: 3\./u);
  for (const n of NOT_POSSIBLE_YET) assert.ok(text.includes(`- ${n.store}: ${n.reason}`), n.store);
  for (const s of BODY_TEXT) assert.ok(!text.toLowerCase().includes(s), `no document text in the confirmation (${s})`);
  // the hold view of the forget is the same text (if the SDK ever holds the person op); its summary = ids + counts
  const forget = env.definition.handlers.relationship_forget as { holdView: (i: Json) => string; redact: (i: Json, o?: Json) => string };
  assert.equal(forget.holdView(input as unknown as Json), text);
  assert.equal(forget.redact(input as unknown as Json), `forget person ${dana} of ct_anna: 3 documents to delete for good`);
  // unbound (no database yet): ids and the warning, never a throw
  const { definition: fresh } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "gbrain" }, TestError, { drainIntervalMs: 0 });
  const view = (fresh.handlers.relationship_forget as { holdView: (i: Json) => string }).holdView(input as unknown as Json);
  assert.match(view, /^Forget person rp_\w+ in the relationships of operator ct_anna\.\nThis delete is permanent\./u);
  // a very long title is cut to 120 characters in the scan answer
  const long = env.services.store.createDocument({ area: "company", title: `${"Long ".repeat(40)}Dana Client`, body: "x", actor: OWNER.id });
  const again = await env.run("relationship_forget_scan", { operator: "ct_anna", person: dana }, env.owner());
  const t = (again.matched as { documentId: string; title: string }[]).find((m) => m.documentId === long.id)?.title ?? "";
  assert.equal([...t].length, 120);
});

test("S3-4: an app caller is refused on relationship_forget and relationship_forget_scan; nothing changes", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const app = env.ctx(ADA, { caller: { type: "app", id: "ins_01M5PM73ZZ0BSERVER00000000", name: "Observer", product: "observer", mode: null } as unknown as OpContext["caller"] });
  await assert.rejects(env.run("relationship_forget", { operator: "ct_anna", person: dana }, app), rejects("scope_denied"));
  await assert.rejects(env.run("relationship_forget_scan", { operator: "ct_anna", person: dana }, app), rejects("scope_denied"));
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_people WHERE id = ?", dana), 1);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_rel_log WHERE action = 'person_forgotten'"), 0);
});

test("S3-5: at most 10 engine pages are purged inside the forget call; the rest stay queued (pending) for the drain timer", async () => {
  const env = await setup();
  const { dana } = await people(env);
  const ids = Array.from({ length: 12 }, (_, i) => env.services.store.createDocument({ area: "company", title: `Dana Client note ${i}`, body: "x", actor: OWNER.id }).id);
  const out = await env.run("relationship_forget", { operator: "ct_anna", person: dana, purgeDocuments: ids }, env.owner());
  assert.equal(env.helperCalls.length, INLINE_PURGE_LIMIT);
  assert.equal(out.documents.purged.length, 12);
  assert.equal(out.documents.purged.filter((p: { engine: string }) => p.engine === "purged").length, 10);
  assert.equal(out.documents.pending.length, 2);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_forget_queue"), 2);
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_documents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)), 0, "every document itself is gone at once");
  assert.deepEqual(await env.knowledge.drainForget(env.services, env.owner()), { done: out.documents.pending.map((p: { documentId: string }) => p.documentId), failed: [] });
  assert.equal(count(env.db, "SELECT count(*) AS n FROM kn_forget_queue"), 0);
});
