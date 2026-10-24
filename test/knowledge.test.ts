// Knowledge behaviour through its handlers with a fake SDK context and a fake GBrain service:
// per-agent areas are walled, the shared area is READ by default (C1), memory is remembered and recalled.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { knowledgeDefinition } from "../src/app.ts";
import { NARROWING_POLICY } from "../src/handlers.ts";
import { areaSourceId } from "../src/ids.ts";
import { ENGINE_KEY_MISSING, ENGINE_MISSING, ENGINE_UNREACHABLE, KEY_REJECTED, memorySecrets, SECRET_NAME } from "../src/knowledge.ts";
import { context, type FakeGBrain, FakeScopes, fakeGBrain, memoryDb, TestError } from "./helpers.ts";

const ADA = "agt_01AAAAAAAAAAAAAAAAAAAAAAAA";
const BO = "agt_01BBBBBBBBBBBBBBBBBBBBBBBB";
const ADA_AREA = "agent-01aaaaaaaaaaaaaaaaaaaaaaaa";
const BO_AREA = "agent-01bbbbbbbbbbbbbbbbbbbbbbbb";

let gbrain: FakeGBrain;
before(async () => {
  gbrain = await fakeGBrain();
});
after(async () => {
  await gbrain.close();
});

async function setup() {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken, KNOWLEDGE_MODEL_PROVIDER: "openai" };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  for (const [id, name] of [[ADA, "Ada"], [BO, "Bo"]] as const) {
    await definition.events?.agentAdded?.({ id, name, mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("no companions"); }, statusChanged() {}, ownerLink: () => null });
    scopes.applyDefaults(id);
  }
  // C6 helper stand-in: `gbrain sources add` creates the source.
  const helperCalls: unknown[] = [];
  const callServiceHelper = (async (service: string, path: string, body: Json) => {
    helperCalls.push({ service, path, body });
    gbrain.sources.add(String((body as Record<string, unknown>).id));
    return {};
  }) as OpContext["callServiceHelper"];
  const ctx = (agent: string, extra: Partial<OpContext> = {}) => context(db, scopes, agent, { callServiceHelper, ...extra });
  const run = async (name: string, input: Record<string, unknown>, c: OpContext) => {
    const spec = definition.handlers[name];
    const handler = typeof spec === "function" ? spec : spec?.run;
    if (!handler) throw new Error(`no handler ${name}`);
    const declared = definition.manifest.operations.find((o) => o.id === name);
    if (declared?.input) {
      const inputCheck = validateInput({ ...declared, standard: false } as never, input as never) as { ok: boolean };
      assert.ok(inputCheck.ok, `${name} input: ${JSON.stringify(inputCheck)}`);
    }
    // The SDK hands every handler its OperationView (the G5 wrapper reads `op.effect` for ops it does not list).
    const withOp = c.op ? c : ({ ...c, op: declared ? { ...declared, standard: false } : null } as OpContext);
    const output = (await handler(input as Json, withOp)) as Record<string, any>;
    // The SDK refuses (500) an output that does not match the manifest output schema: check every call here too.
    const op = definition.manifest.operations.find((o) => o.id === name);
    if (op?.output) {
      const checked = validateInput({ ...op, standard: false, input: op.output } as never, output as never) as { ok: boolean };
      assert.ok(checked.ok, `${name} output: ${JSON.stringify(checked)}`);
    }
    return output;
  };
  return { db, scopes, definition, knowledge, ctx, run, helperCalls };
}

const rejects = (code: string) => (error: unknown) => error instanceof TestError && error.code === code;

test("every manifest operation has exactly one handler (dynamic op via dynamic handlers)", async () => {
  const { definition } = await setup();
  const ids = definition.manifest.operations.filter((op) => !op.dynamic).map((op) => op.id).sort();
  assert.deepEqual(Object.keys(definition.handlers).sort(), ids);
  assert.deepEqual(Object.keys(definition.dynamic ?? {}), ["engine"]);
});

test("J1: an agent remembers, the memory is projected to GBrain and recalled", async () => {
  const { ctx, run, knowledge, db, helperCalls } = await setup();
  const saved = await run("remember", { text: "Martin prefers annual billing for Acme.\nDecided on the call." }, ctx(ADA));
  assert.equal(saved.area, ADA_AREA);
  // Provisioning runs lazily on the first engine-backed call; drain the outbox.
  await run("recall", { query: "anything" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  assert.ok(helperCalls.length >= 1);
  const recalled = await run("recall", { query: "annual billing" }, ctx(ADA));
  assert.equal(recalled.degraded, false);
  assert.equal(recalled.results[0].documentId, saved.documentId);
  assert.deepEqual(recalled.results[0].areas, [ADA_AREA]);
  const state = db.prepare("SELECT state FROM kn_projection WHERE document_id = ?").get(saved.documentId);
  assert.equal(state?.state, "ready");
});

test("C336 M1: every recall hit cites its source: a document itself, an engine page by area and slug; a stale page is left out and counted", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "Acme kettle colour is teal.\nNoted at the office." }, ctx(ADA));
  await run("recall", { query: "anything" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const page = "notes/acme-kettle-m1";
  const stale = "knowledge-docs/kdoc_01zzzzzzzzzzzzzzzzzzzzzzzz";
  const sourcePages = gbrain.pages.get(areaSourceId(ADA_AREA));
  assert.ok(sourcePages, "Ada's engine source exists after the first recall");
  sourcePages.set(page, { content: "acme kettle m1 engine page", revision: "r-m1" });
  sourcePages.set(stale, { content: "acme kettle m1 stale mirror", revision: "r-m1s" });
  try {
    const out = await run("recall", { query: "kettle", area: ADA_AREA }, ctx(ADA));
    const doc = out.results.find((row: { documentId: string | null }) => row.documentId === saved.documentId);
    assert.deepEqual(doc.ref, { kind: "document", id: saved.documentId });
    assert.equal(doc.source.ref, `knowledge:document/${saved.documentId}`);
    assert.equal(doc.source.author, ADA);
    assert.equal(typeof doc.source.at, "number");
    const enginePage = out.results.find((row: { ref: { slug?: string } }) => row.ref.slug === page);
    assert.deepEqual(enginePage.ref, { kind: "page", area: ADA_AREA, slug: page });
    assert.deepEqual(enginePage.source, { ref: `knowledge:page/${ADA_AREA}/${page}` });
    assert.ok(!out.results.some((row: { text: string }) => row.text.includes("stale mirror")), "a page of a missing document is not returned");
    assert.ok((out.areas[0].uncited ?? 0) >= 1, JSON.stringify(out.areas));
    assert.ok(out.results.every((row: { source?: { ref?: unknown } }) => typeof row.source?.ref === "string"));
  } finally {
    sourcePages.delete(page);
    sourcePages.delete(stale);
  }
  // keyword path (no engine answer) cites too
  const keyword = await run("documents_search", { query: "kettle" }, ctx(ADA));
  assert.ok(keyword.hits.length >= 1);
});

test("C336 M3: remember items[] saves a batch once per area, cites its source, and stores kind as a tag", async () => {
  const { ctx, run, db, knowledge } = await setup();
  const source = { harness: "claude-code", session: "sess-m3-01", url: "https://example.invalid/sessions/sess-m3-01" };
  const first = await run("remember", { items: [{ text: "Acme renews in March.", kind: "fact", tags: ["work"] }, { text: "We chose  annual\nbilling for Acme.", kind: "decision" }], source }, ctx(ADA));
  assert.equal(first.area, ADA_AREA);
  assert.deepEqual(first.items.map((i: { created: boolean }) => i.created), [true, true]);
  // the hook sends an overlapping batch again: same texts (case and white space differ) are not stored twice
  const again = await run("remember", { items: [{ text: "acme renews in march." }, { text: "We chose annual billing for Acme." }, { text: "Acme wants SSO." }], source }, ctx(ADA));
  assert.deepEqual(again.items.map((i: { created: boolean }) => i.created), [false, false, true]);
  assert.equal(again.items[0].documentId, first.items[0].documentId);
  assert.equal(again.items[1].documentId, first.items[1].documentId);
  const stored = db.prepare("SELECT source_ref, source_url, tags FROM kn_documents WHERE id = ?").get(first.items[1].documentId);
  assert.equal(stored?.source_ref, "claude-code:session/sess-m3-01");
  assert.equal(stored?.source_url, source.url);
  assert.deepEqual(JSON.parse(String(stored?.tags)), ["decision"]);
  // the citation reaches recall
  await run("recall", { query: "x" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const out = await run("recall", { query: "renews", area: ADA_AREA }, ctx(ADA));
  const hit = out.results.find((row: { documentId: string }) => row.documentId === first.items[0].documentId);
  assert.deepEqual(hit.source, { ref: "claude-code:session/sess-m3-01", url: source.url, author: ADA, at: hit.source.at });
  // the single-text form dedupes the same way and says so
  const single = await run("remember", { text: "Acme wants SSO." }, ctx(ADA));
  assert.equal(single.created, false);
  assert.equal(single.documentId, again.items[2].documentId);
  // the same text in another area is another memory
  const shared = await run("remember", { text: "Acme wants SSO." }, ctx(BO));
  assert.equal(shared.created, true);
  // `digest` (a session summary from a pre-compaction hook) is a kind too
  const digest = await run("remember", { items: [{ text: "Session digest: Acme SSO scoped.", kind: "digest" }], source }, ctx(ADA));
  assert.equal(digest.items[0].created, true);
  // exactly one of text and items
  await assert.rejects(run("remember", { text: "a", items: [{ text: "b" }] }, ctx(ADA)), rejects("invalid_input"));
  await assert.rejects(run("remember", { tags: ["x"] }, ctx(ADA)), rejects("invalid_input"));
});

test("C336 M4: search finds words in documents and engine pages, cited; get opens a document, a mirror page and an engine page", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "Zephyr contract signed by Acme.", tags: ["work"] }, ctx(ADA));
  await run("recall", { query: "warm" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const sourcePages = gbrain.pages.get(areaSourceId(ADA_AREA));
  assert.ok(sourcePages);
  sourcePages.set("notes/zephyr-m4", { content: "zephyr engine-only note", revision: "r-m4" });
  try {
    const found = await run("search", { query: "zephyr" }, ctx(ADA));
    assert.equal(found.degraded, false);
    assert.ok(found.results.some((row: { ref: { kind: string; id?: string } }) => row.ref.kind === "document" && row.ref.id === saved.documentId));
    assert.ok(found.results.some((row: { ref: { slug?: string } }) => row.ref.slug === "notes/zephyr-m4"));
    assert.ok(found.results.every((row: { source?: { ref?: unknown } }) => typeof row.source?.ref === "string"));
    // get: the document, by ref and by its mirror page slug
    const doc = await run("get", { ref: { kind: "document", id: saved.documentId } }, ctx(ADA));
    assert.equal(doc.text, "Zephyr contract signed by Acme.");
    assert.equal(doc.source.ref, `knowledge:document/${saved.documentId}`);
    const mirror = await run("get", { ref: { kind: "page", area: ADA_AREA, slug: `knowledge-docs/${saved.documentId.toLowerCase()}` } }, ctx(ADA));
    assert.deepEqual(mirror.ref, { kind: "document", id: saved.documentId });
    const page = await run("get", { ref: { kind: "page", area: ADA_AREA, slug: "notes/zephyr-m4" } }, ctx(ADA));
    assert.equal(page.text, "zephyr engine-only note");
    assert.deepEqual(page.source, { ref: `knowledge:page/${ADA_AREA}/notes/zephyr-m4` });
    // walls: Bo cannot open Ada's document or page; a tag narrowing hides engine pages and non-matching documents
    await assert.rejects(run("get", { ref: { kind: "document", id: saved.documentId } }, ctx(BO)), rejects("not_found"));
    await assert.rejects(run("get", { ref: { kind: "page", area: ADA_AREA, slug: "notes/zephyr-m4" } }, ctx(BO)), rejects("not_found"));
    await assert.rejects(run("get", { ref: { kind: "page", area: ADA_AREA, slug: "notes/zephyr-m4" } }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }) })), rejects("not_found"));
    await assert.rejects(run("get", { ref: { kind: "document", id: saved.documentId } }, ctx(ADA, { context: narrowing({ anyOf: ["personal"] }) })), rejects("not_found"));
    const narrowed = await run("search", { query: "zephyr" }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }) }));
    assert.ok(narrowed.results.length >= 1 && narrowed.results.every((row: { ref: { kind: string } }) => row.ref.kind === "document"));
  } finally {
    sourcePages.delete("notes/zephyr-m4");
  }
});

test("C336 M4: context packs entities through the engine, adds cited matches, caps the size; ask runs think in the own area; engine tools are searchable", async () => {
  const { ctx, run, knowledge, definition } = await setup();
  await run("remember", { text: "Acme wants SSO next quarter." }, ctx(ADA));
  await run("recall", { query: "warm" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const pack = await run("context", { purpose: "session_start", entities: ["Acme"], maxChars: 4000 }, ctx(ADA));
  assert.equal(pack.via, "context_pack");
  assert.match(pack.text, /Acme renews in March/u);
  assert.match(pack.text, /Acme wants SSO/u);
  assert.match(pack.text, /\[knowledge:document\//u);
  assert.equal(pack.truncated, false);
  const contextCall = gbrain.calls.findLast((c: { name?: string }) => c.name === "context_pack") as { args?: Record<string, unknown> } | undefined;
  assert.equal(contextCall?.args?.entities, "Acme", "upstream takes a comma-separated string");
  const small = await run("context", { purpose: "prompt", query: "Acme SSO", maxChars: 200 }, ctx(ADA));
  assert.equal(small.via, "recall");
  assert.ok(small.text.length <= 200);
  const recent = await run("context", { purpose: "after_compact" }, ctx(ADA));
  assert.equal(recent.via, "recent");
  assert.ok(recent.refs.length >= 1);
  // a tag narrowing skips the engine pack (its tags cannot be matched) and keeps only allowed memories
  const narrowedPack = await run("context", { purpose: "session_start", entities: ["Acme"] }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }) }));
  assert.notEqual(narrowedPack.via, "context_pack");
  assert.doesNotMatch(narrowedPack.text, /Acme renews in March/u);
  // ask: engine think in the caller's own area; a tag narrowing refuses (fail closed)
  const asked = await run("ask", { question: "When does Acme renew?" }, ctx(ADA));
  assert.equal(asked.area, ADA_AREA);
  assert.match(JSON.stringify(asked.answer), /answer to When does Acme renew/u);
  await assert.rejects(run("ask", { question: "x" }, ctx(ADA, { context: narrowing({ noneOf: ["personal"] }) })), rejects("narrowing_unsupported"));
  await assert.rejects(run("ask", { question: "x", area: BO_AREA }, ctx(ADA)), rejects("not_found"));
  // engine tools in search mode: the bridge asks the catalog with the agent's words
  const hookCtx = ctx(ADA) as never;
  // (the fake engine lists query, remember, forget, get_page, entity, think; sources_list is excluded by policy)
  const found = await definition.dynamic?.engine?.catalog({ query: "forget a memory", limit: 5 } as never, hookCtx);
  assert.equal(found?.[0]?.name, "gb_forget", JSON.stringify(found?.map((e) => e.name)));
  assert.ok(!found?.some((entry) => entry.name === "gb_sources_list"));
  const none = await definition.dynamic?.engine?.catalog({ query: "zzzz", limit: 5 } as never, hookCtx);
  assert.deepEqual(none, []);
  const all = await definition.dynamic?.engine?.catalog(null as never, hookCtx);
  assert.equal(all?.length, 6);
});

test("walled areas: another agent can neither recall nor read nor target the area", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "Ada's private plan: zebra project" }, ctx(ADA));
  await run("recall", { query: "x" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const bo = await run("recall", { query: "zebra project" }, ctx(BO));
  assert.equal(bo.results.length, 0);
  await assert.rejects(run("document_get", { id: saved.documentId }, ctx(BO)), rejects("not_found"));
  await assert.rejects(run("recall", { query: "zebra", area: ADA_AREA }, ctx(BO)), rejects("not_found"));
  await assert.rejects(run("remember", { text: "intrusion", area: ADA_AREA }, ctx(BO)), rejects("not_found"));
  const search = await run("documents_search", { query: "zebra" }, ctx(BO));
  assert.equal(search.hits.length, 0);
});

test("shared company area: READ for everyone, WRITE only after the owner enables it (C1)", async () => {
  const { ctx, run, scopes } = await setup();
  await assert.rejects(run("remember", { text: "company fact", area: "company" }, ctx(ADA)), rejects("scope_denied"));
  scopes.set(ADA, "company", "read_write");
  const saved = await run("remember", { text: "Company holiday is May 1", area: "company" }, ctx(ADA));
  const doc = await run("document_get", { id: saved.documentId }, ctx(BO));
  assert.equal(doc.area, "company");
  const areas = await run("areas_list", {}, ctx(BO));
  assert.deepEqual(
    areas.areas.map((a: Record<string, unknown>) => [a.id, a.access, a.own]),
    [["company", "read", false], [BO_AREA, "read_write", true]],
  );
  await assert.rejects(run("document_update", { id: saved.documentId, body: "changed" }, ctx(BO)), rejects("scope_denied"));
});

test("recall falls back to keyword search when the engine cannot answer (degraded, never silent)", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const { definition } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "gbrain" }, TestError, { drainIntervalMs: 0 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  await definition.events?.agentAdded?.({ id: ADA, name: "Ada", mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("no companions"); }, statusChanged() {}, ownerLink: () => null });
  scopes.applyDefaults(ADA);
  const spec = definition.handlers.remember as { run: (i: Json, c: OpContext) => Promise<Json> };
  await spec.run({ text: "the walrus sings at noon" }, context(db, scopes, ADA));
  const recall = definition.handlers.recall as { run: (i: Json, c: OpContext) => Promise<Record<string, any>> };
  const out = await recall.run({ query: "walrus" }, context(db, scopes, ADA));
  assert.equal(out.degraded, true);
  assert.equal(out.results.length, 1);
  assert.ok(out.areas.every((a: Record<string, unknown>) => a.via === "keyword"));
});

test("engine tools: catalog filters policy exclusions and source_id; calls are area-bound and guarded", async () => {
  const { ctx, run, definition } = await setup();
  await run("recall", { query: "warm up" }, ctx(ADA)); // provisions the sources
  const dynamic = definition.dynamic?.engine;
  assert.ok(dynamic);
  const hookCtx = { db: ctx(ADA).db, log: ctx(ADA).log, getKey: async () => null, signal: new AbortController().signal, secrets: memorySecrets() };
  const catalog = await dynamic.catalog(null, hookCtx);
  const names = catalog.map((entry) => entry.name);
  assert.ok(names.includes("gb_remember"));
  assert.ok(!names.includes("gb_sources_list"));
  const remember = catalog.find((entry) => entry.name === "gb_remember");
  assert.equal((remember?.inputSchema.properties as Record<string, unknown> | undefined)?.source_id, undefined);
  assert.deepEqual(await dynamic.resolve("gb_forget", hookCtx), { tool: "gb_forget", crud: ["delete"], effect: "destructive", holdFamily: "destructive" });
  assert.equal(await dynamic.resolve("gb_sources_list", hookCtx), null);

  gbrain.calls.length = 0;
  await dynamic.call("gb_remember", { fact: "Ada likes tea" }, ctx(ADA, { idempotencyKey: "idem-".padEnd(12, "0") }));
  const call = gbrain.calls.find((c) => c.name === "remember");
  assert.ok(call && typeof call.args.request_id === "string");
  assert.equal(call.args.area, undefined);

  await assert.rejects(dynamic.call("gb_remember", { fact: "x", source_id: "other" }, ctx(ADA)), rejects("argument_refused"));
  await assert.rejects(dynamic.call("gb_remember", { fact: "x", area: "company" }, ctx(ADA)), rejects("scope_denied"));
  await assert.rejects(dynamic.call("gb_entity", { name: "x", area: ADA_AREA }, ctx(BO)), rejects("not_found"));

  // Stateless reads fan out over every readable area; a foreign-source row is dropped by the sanitizer.
  gbrain.answer = (source, name) => (name === "entity" ? [{ name: "Acme", source_id: source }, { name: "Leak", source_id: "ka-other" }] : undefined);
  const fan = (await dynamic.call("gb_entity", { name: "Acme" }, ctx(BO))) as Record<string, any>;
  gbrain.answer = undefined;
  assert.deepEqual(fan.areas.map((a: Record<string, unknown>) => a.area).sort(), ["company", BO_AREA].sort());
  for (const result of fan.results) assert.deepEqual(result.data.map((row: Record<string, unknown>) => row.name), ["Acme"]);
});

test("delete removes the memory from the engine", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "temporary note about lemons" }, ctx(ADA));
  await run("recall", { query: "x" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  await run("document_delete", { id: saved.documentId }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const out = await run("recall", { query: "lemons" }, ctx(ADA));
  assert.equal(out.results.length, 0);
});

test("after a restore every live document is re-projected (engine state may differ from app.db)", async () => {
  const { ctx, run, knowledge, db } = await setup();
  await run("remember", { text: "restore check about plums" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'pending'").get()?.n, 0);
  assert.ok((knowledge.current()?.projector?.requeueAll() ?? 0) >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'pending' AND content_hash IS NULL").get()?.n, 1);
  await knowledge.current()?.projector?.drain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'ready'").get()?.n, 1);
});

test("QA S2: recall uses GBrain when it is up (not degraded) and engine client credentials use valid SDK secret names", async () => {
  const names: string[] = [];
  const strict = memorySecrets();
  const secrets = {
    ...strict,
    put: async (name: string, value: string) => {
      names.push(name);
      await strict.put(name, value);
    },
  };
  const { ctx, run, knowledge } = await setup();
  const withSecrets = (agent: string) => ctx(agent, { secrets } as never);
  const saved = await run("remember", { text: "GBrain path check: the quokka report" }, withSecrets(ADA));
  await knowledge.current()?.projector?.drain();
  gbrain.calls.length = 0;
  const out = await run("recall", { query: "quokka report" }, withSecrets(ADA));
  assert.equal(out.degraded, false, JSON.stringify(out.areas));
  assert.ok(out.areas.every((a: Record<string, unknown>) => a.via === "engine"));
  assert.ok(gbrain.calls.some((c) => c.name === "query"));
  assert.equal(out.results[0].documentId, saved.documentId);
  assert.ok(names.length > 0);
  for (const name of names) assert.match(name, SECRET_NAME);
});

test("C58 agent ops: collection get/tree/delete and link delete stay inside the caller's writable areas", async () => {
  const { ctx, run } = await setup();
  await run("remember", { text: "seed the default collection" }, ctx(ADA));
  const col = await run("collection_create", { name: "Projects" }, ctx(ADA));
  const parent = await run("document_create", { title: "Plan", collectionId: col.id }, ctx(ADA));
  const child = await run("document_create", { title: "Step", collectionId: col.id, parentId: parent.id }, ctx(ADA));
  const tree = await run("collection_tree", { id: col.id }, ctx(ADA));
  assert.equal(tree.nodes[0].id, parent.id);
  assert.equal(tree.nodes[0].children[0].id, child.id);
  assert.equal((await run("collection_get", { id: col.id }, ctx(ADA))).documentCount, 2);
  await assert.rejects(run("collection_get", { id: col.id }, ctx(BO)), rejects("not_found"));
  const link = await run("link_add", { sourceId: child.id, targetId: parent.id }, ctx(ADA));
  await assert.rejects(run("link_delete", { id: link.id }, ctx(BO)), rejects("not_found"));
  assert.equal((await run("link_delete", { id: link.id }, ctx(ADA))).deleted, true);
  await assert.rejects(run("collection_delete", { id: col.id }, ctx(BO)), rejects("not_found"));
  const deleted = await run("collection_delete", { id: col.id }, ctx(ADA));
  assert.equal(deleted.documents, 2);
  await assert.rejects(run("document_get", { id: parent.id }, ctx(ADA)), rejects("not_found"));
  const def = (await run("collections_list", {}, ctx(ADA))).collections.find((c: Record<string, unknown>) => c.isDefault);
  await assert.rejects(run("collection_delete", { id: def.id }, ctx(ADA)), rejects("default_collection"));
});

test("C58 person ops: the owner browses and curates every area", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "Ada's note about walruses" }, ctx(ADA));
  const bo = await run("remember", { text: "Bo's note about walruses" }, ctx(BO));
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } });
  const overview = await run("library_overview", {}, owner);
  assert.deepEqual(overview.areas.map((a: Record<string, unknown>) => a.id).sort(), ["company", ADA_AREA, BO_AREA].sort());
  assert.equal((await run("library_documents", { query: "walruses" }, owner)).hits.length, 2);
  assert.equal((await run("library_documents", { area: ADA_AREA, query: "walruses" }, owner)).hits.length, 1);
  const detail = await run("library_document", { id: saved.documentId }, owner);
  assert.equal(detail.document.area, ADA_AREA);
  assert.equal(detail.revisions.length, 1);
  const edited = await run("library_document_update", { id: saved.documentId, body: "edited by owner", expectedVersion: 1 }, owner);
  assert.equal(edited.version, 2);
  await assert.rejects(run("library_document_update", { id: saved.documentId, body: "stale", expectedVersion: 1 }, owner), rejects("version_conflict"));
  assert.equal((await run("library_revision", { id: saved.documentId, version: 1 }, owner)).body, "Ada's note about walruses");
  await run("library_comment_add", { documentId: saved.documentId, body: "checked" }, owner);
  assert.equal((await run("library_document", { id: saved.documentId }, owner)).comments.length, 1);
  await knowledge.current()?.projector?.drain();
  const recall = await run("library_recall", { query: "walruses" }, owner);
  assert.equal(recall.degraded, false, JSON.stringify(recall.areas));
  assert.ok(recall.results.some((r: Record<string, unknown>) => r.documentId === bo.documentId));
  assert.equal((await run("library_research", { area: ADA_AREA }, owner)).enabled, false);
  await run("library_document_delete", { id: saved.documentId }, owner);
  await assert.rejects(run("library_document", { id: saved.documentId }, owner), rejects("not_found"));
});

// ── G5 `rules.narrowing` (SDK-API §18; QA R4) ──

/** The context Rules' `rules_context` hook adds (opt2-tealbrick-rules src/hooks.ts): key `rules.narrowing`, value RulesNarrowingV1. */
const narrowing = (memoryTags: Record<string, string[]>, v: unknown = 1) => ({ "rules.narrowing": { v, ruleId: "rul_01TESTRULE0000000000000000", reason: "team Support: work only", memoryTags } }) as OpContext["context"];

async function taggedMemories() {
  gbrain.pages.clear(); // the fake engine is shared by every test in this file
  const env = await setup();
  const { ctx, run, knowledge } = env;
  const work = await run("remember", { text: "teal heron rollout plan for Acme", tags: ["work"] }, ctx(ADA));
  const personal = await run("remember", { text: "teal heron birthday gift for my sister", tags: ["personal"] }, ctx(ADA));
  const untagged = await run("remember", { text: "teal heron note without tags" }, ctx(ADA));
  const both = await run("remember", { text: "teal heron offsite dinner", tags: ["Work", "personal"] }, ctx(ADA));
  await run("recall", { query: "warm up" }, ctx(ADA)); // provisions the engine source
  await knowledge.current()?.projector?.drain();
  // A page written straight into the engine (gb_ tools), not a canonical document: its tags are unknown to Knowledge.
  gbrain.pages.get(areaSourceId(ADA_AREA))?.set("notes/native-heron", { content: "teal heron native engine page", revision: "r0" });
  return { ...env, work: work.documentId as string, personal: personal.documentId as string, untagged: untagged.documentId as string, both: both.documentId as string };
}

const ids = (results: Record<string, any>[]) => results.map((r) => r.documentId).sort();

test("G5: recall with anyOf [work] returns only work-tagged memories, each with its tags (engine path)", async () => {
  const { ctx, run, work, both } = await taggedMemories();
  const plain = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA));
  assert.equal(plain.degraded, false, JSON.stringify(plain.areas));
  assert.equal(plain.results.length, 5, "4 canonical memories + 1 engine page without narrowing");
  for (const r of plain.results) assert.ok(Array.isArray(r.tags) && r.tags.every((t: unknown) => typeof t === "string"), "every item carries tags[]");
  assert.deepEqual(plain.results.find((r: Record<string, unknown>) => r.documentId === null)?.tags, []);

  const metas: Json[] = [];
  const narrowed = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }), receipt: { summary() {}, meta: (m: Json) => metas.push(m) } }));
  assert.equal(narrowed.degraded, false);
  assert.deepEqual(ids(narrowed.results), [work, both].sort());
  assert.deepEqual(narrowed.results.find((r: Record<string, unknown>) => r.documentId === work)?.tags, ["work"]);
  assert.deepEqual(narrowed.results.find((r: Record<string, unknown>) => r.documentId === both)?.tags, ["work", "personal"]);
  assert.deepEqual(metas, [{ narrowing: { v: 1, ruleId: "rul_01TESTRULE0000000000000000" } }], "the rule id is recorded in the receipt meta");
});

test("G5: noneOf drops matching tags; an engine page of unknown tags never returns under a narrowing; tags compare case-insensitively", async () => {
  const { ctx, run, work, untagged, both } = await taggedMemories();
  const none = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA, { context: narrowing({ noneOf: ["personal"] }) }));
  assert.deepEqual(ids(none.results), [work, untagged].sort());
  const upper = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA, { context: narrowing({ anyOf: [" WORK "] }) }));
  assert.deepEqual(ids(upper.results), [work, both].sort());
  const mixed = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA, { context: narrowing({ anyOf: ["work"], noneOf: ["personal"] }) }));
  assert.deepEqual(ids(mixed.results), [work]);
  const empty = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA, { context: narrowing({ anyOf: [] }) }));
  assert.deepEqual(empty.results, [], "anyOf [] keeps nothing");
});

test("G5: unknown v or a malformed narrowing refuses with narrowing_unsupported (fail closed); no key = no narrowing", async () => {
  const { ctx, run, definition } = await taggedMemories();
  await assert.rejects(run("recall", { query: "teal heron" }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }, 2) })), rejects("narrowing_unsupported"));
  await assert.rejects(run("documents_search", { query: "teal" }, ctx(ADA, { context: { "rules.narrowing": "work" } })), rejects("narrowing_unsupported"));
  await assert.rejects(run("recall", { query: "teal" }, ctx(ADA, { context: { "rules.narrowing": { v: 1, ruleId: "rul_x", memoryTags: { anyOf: "work" } } } })), rejects("narrowing_unsupported"));
  // Another app's context key is not a narrowing.
  const other = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA, { context: { "kanban.narrowing": { v: 9 } } }));
  assert.equal(other.results.length, 5);
  // C150 (spec 0.1.28 §18.4): writes are narrowed too, so an unknown v refuses a write as well (fail closed).
  await assert.rejects(run("remember", { text: "written under a narrowing", tags: ["work"] }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }, 2) })), rejects("narrowing_unsupported"));
  // Engine read tools cannot match engine-side tags: refused under a tag narrowing, allowed without one.
  const dynamic = definition.dynamic?.engine;
  assert.ok(dynamic);
  await assert.rejects(dynamic.call("gb_get_page", { slug: "notes/native-heron", area: ADA_AREA }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }) })), rejects("narrowing_unsupported"));
  await assert.rejects(dynamic.call("gb_get_page", { slug: "notes/native-heron", area: ADA_AREA }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }, 3) })), rejects("narrowing_unsupported"));
  const page = (await dynamic.call("gb_get_page", { slug: "notes/native-heron", area: ADA_AREA }, ctx(ADA))) as Record<string, unknown>;
  assert.equal(page.slug, "notes/native-heron");
});

test("G5: search, get, revisions, comments, links, collections and tree honour the narrowing", async () => {
  const { ctx, run, work, personal, untagged, both } = await taggedMemories();
  const n = (memoryTags: Record<string, string[]>) => ctx(ADA, { context: narrowing(memoryTags) });
  const hits = await run("documents_search", { query: "teal heron", area: ADA_AREA }, n({ anyOf: ["work"] }));
  assert.deepEqual(hits.hits.map((h: Record<string, unknown>) => h.id).sort(), [work, both].sort());
  for (const h of hits.hits) assert.ok(h.tags.includes("work"));
  assert.equal((await run("document_get", { id: work }, n({ anyOf: ["work"] }))).id, work);
  await assert.rejects(run("document_get", { id: personal }, n({ anyOf: ["work"] })), rejects("not_found"));
  await assert.rejects(run("document_get", { id: untagged }, n({ anyOf: ["work"] })), rejects("not_found"));
  await assert.rejects(run("document_revisions", { id: personal }, n({ anyOf: ["work"] })), rejects("not_found"));
  await assert.rejects(run("comments_list", { documentId: personal }, n({ anyOf: ["work"] })), rejects("not_found"));
  await assert.rejects(run("links_list", { documentId: both }, n({ noneOf: ["personal"] })), rejects("not_found"));
  // a work document that WAS personal keeps only the revisions whose own tags pass
  await run("document_update", { id: personal, tags: ["work"], expectedVersion: 1 }, ctx(ADA));
  const revs = await run("document_revisions", { id: personal }, n({ anyOf: ["work"] }));
  assert.deepEqual(revs.revisions.map((r: Record<string, unknown>) => [r.version, r.tags]), [[2, ["work"]]]);
  // links: a link to a hidden document is not listed
  await run("link_add", { sourceId: work, targetId: untagged }, ctx(ADA));
  await run("link_add", { sourceId: work, targetId: both }, ctx(ADA));
  const links = await run("links_list", { documentId: work }, n({ anyOf: ["work"] }));
  assert.deepEqual(links.outbound.map((l: Record<string, unknown>) => [l.documentId, l.tags]), [[both, ["work", "personal"]]]);
  // collections: counts only visible documents; the tree lists only visible documents
  const cols = await run("collections_list", { area: ADA_AREA }, n({ anyOf: ["work"] }));
  const memories = cols.collections.find((c: Record<string, unknown>) => c.isDefault);
  assert.equal(memories.documentCount, 3, "work, both, and the formerly personal document now tagged work");
  assert.equal((await run("collection_get", { id: memories.id }, n({ anyOf: ["work"] }))).documentCount, 3);
  assert.equal((await run("collection_get", { id: memories.id }, ctx(ADA))).documentCount, 4);
  const tree = await run("collection_tree", { id: memories.id }, n({ noneOf: ["work"] }));
  assert.deepEqual(tree.nodes.map((node: Record<string, unknown>) => node.id), [untagged]);
});

test("G5: research ops carry no tags — anyOf refuses, noneOf alone runs; every read op has a narrowing policy", async () => {
  const { ctx, run, definition } = await setup();
  await assert.rejects(run("research_sources_list", {}, ctx(ADA, { context: narrowing({ anyOf: ["work"] }) })), rejects("narrowing_unsupported"));
  await assert.rejects(run("research_ask", { sessionId: "s1", message: "q" }, ctx(ADA, { context: narrowing({ anyOf: ["work"] }) })), rejects("narrowing_unsupported"));
  // noneOf alone: the call runs (here research is off, so the research engine answers research_disabled)
  await assert.rejects(run("research_sources_list", {}, ctx(ADA, { context: narrowing({ noneOf: ["personal"] }) })), rejects("research_disabled"));
  // Person library views (no hook context in practice) refuse a narrowing they cannot apply.
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null }, context: narrowing({ anyOf: ["work"] }) });
  await assert.rejects(run("library_overview", {}, owner), rejects("narrowing_unsupported"));
  for (const op of definition.manifest.operations) {
    if (op.effect === "read" && !op.dynamic && op.audience !== "person") assert.ok(NARROWING_POLICY[op.id], `agent read op ${op.id} has a G5 policy`);
  }
});

// ── C150 / QA F90 (S1): a narrowing binds WRITES (spec 0.1.28 SDK-API §18.4). Each rule: quiet on the good case, fires on the bad case (L34). ──

/** The error a call answers with, reduced to what a caller can observe. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TestError, String(error));
    return { code: error.code, message: error.message, status: error.httpStatus };
  }
  assert.fail("the call was expected to be refused");
}

const MISSING_DOC = "kdoc_01ZZZZZZZZZZZZZZZZZZZZZZZZ";

test("F90: document_update — a hidden document answers exactly like a missing one and is not changed; a visible one updates (receipt names the rule)", async () => {
  const { ctx, run, db, work, personal, both } = await taggedMemories();
  const metas: Json[] = [];
  const n = (memoryTags: Record<string, string[]>) => ctx(ADA, { context: narrowing(memoryTags), receipt: { summary() {}, meta: (m: Json) => metas.push(m) } });
  // good: a visible document updates
  assert.equal((await run("document_update", { id: work, body: "teal heron rollout plan v2", expectedVersion: 1 }, n({ anyOf: ["work"] }))).version, 2);
  assert.deepEqual(metas.at(-1), { narrowing: { v: 1, ruleId: "rul_01TESTRULE0000000000000000" } });
  // bad (the QA repro): re-tag a hidden document to an allowed tag, then read it
  const hidden = await refusal(run("document_update", { id: personal, tags: ["work"] }, n({ anyOf: ["work"] })));
  const missing = await refusal(run("document_update", { id: MISSING_DOC, tags: ["work"] }, n({ anyOf: ["work"] })));
  assert.deepEqual(hidden, missing, "no existence oracle: hidden id = missing id");
  assert.equal(hidden.code, "not_found");
  // a stale expectedVersion must not tell a hidden document apart either (visibility is checked first)
  assert.deepEqual(await refusal(run("document_update", { id: personal, body: "x", expectedVersion: 9 }, n({ anyOf: ["work"] }))), missing);
  await assert.rejects(run("document_get", { id: personal }, n({ anyOf: ["work"] })), rejects("not_found"));
  // bad (QA H-SECRET): remove the noneOf tag of a hidden document
  assert.deepEqual(await refusal(run("document_update", { id: both, tags: ["work"] }, n({ noneOf: ["personal"] }))), missing);
  const row = db.prepare("SELECT version, tags FROM kn_documents WHERE id = ?").get(both) as Record<string, unknown>;
  assert.deepEqual([row.version, JSON.parse(String(row.tags))], [1, ["work", "personal"]], "nothing was written");
  assert.equal((await run("document_get", { id: personal }, ctx(ADA))).version, 1, "the hidden document is unchanged");
});

test("F90: a write whose result the writer could not read is refused with narrowing_violation (update, remember, document_create)", async () => {
  const { ctx, run, db, work } = await taggedMemories();
  const n = (memoryTags: Record<string, string[]>) => ctx(ADA, { context: narrowing(memoryTags) });
  // update: keep an allowed tag → runs; drop every allowed tag → refused; add a noneOf tag → refused
  assert.equal((await run("document_update", { id: work, tags: ["work", "acme"], expectedVersion: 1 }, n({ anyOf: ["work"] }))).version, 2);
  const violation = await refusal(run("document_update", { id: work, tags: ["personal"] }, n({ anyOf: ["work"] })));
  assert.equal(violation.code, "narrowing_violation");
  assert.equal(violation.status, 409);
  assert.match(violation.message, /rul_01TESTRULE0000000000000000/u);
  assert.equal((await refusal(run("document_update", { id: work, tags: ["work", " Secret "] }, n({ noneOf: ["secret"] })))).code, "narrowing_violation");
  assert.equal((await run("document_get", { id: work }, ctx(ADA))).version, 2, "refused updates wrote nothing");
  // an update that leaves the tags alone runs (the result keeps its visible tags)
  assert.equal((await run("document_update", { id: work, body: "body only" }, n({ anyOf: ["work"] }))).version, 3);
  // remember / document_create: an allowed tag → runs; untagged or outside anyOf → refused, nothing written
  const before = (db.prepare("SELECT COUNT(*) AS n FROM kn_documents").get() as { n: number }).n;
  assert.ok((await run("remember", { text: "allowed memory", tags: ["WORK"] }, n({ anyOf: ["work"] }))).documentId);
  assert.equal((await refusal(run("remember", { text: "untagged memory" }, n({ anyOf: ["work"] })))).code, "narrowing_violation");
  assert.equal((await refusal(run("remember", { text: "other memory", tags: ["personal"] }, n({ anyOf: ["work"] })))).code, "narrowing_violation");
  assert.ok((await run("document_create", { title: "Allowed doc", tags: ["work"] }, n({ anyOf: ["work"] }))).id);
  assert.equal((await refusal(run("document_create", { title: "Secret doc", tags: ["secret"] }, n({ noneOf: ["secret"] })))).code, "narrowing_violation");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM kn_documents").get() as { n: number }).n, before + 2, "only the two allowed creates wrote");
  // without a narrowing nothing is refused (quiet on the good case)
  assert.ok((await run("remember", { text: "untagged without a rule" }, ctx(ADA))).documentId);
});

test("F90: comment_add, link_add, link_delete, document_delete and a hidden parent answer like missing items under a narrowing", async () => {
  const { ctx, run, db, work, personal, untagged, both } = await taggedMemories();
  const n = () => ctx(ADA, { context: narrowing({ anyOf: ["work"] }) });
  // comment_add: visible → runs; hidden = missing
  assert.ok((await run("comment_add", { documentId: work, body: "ok" }, n())).id);
  assert.deepEqual(await refusal(run("comment_add", { documentId: personal, body: "peek" }, n())), await refusal(run("comment_add", { documentId: MISSING_DOC, body: "peek" }, n())));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM kn_comments WHERE document_id = ?").get(personal) as { n: number }).n, 0);
  // link_add: visible → visible runs; a hidden source = missing source; a hidden target = missing target
  assert.ok((await run("link_add", { sourceId: work, targetId: both }, n())).id);
  assert.deepEqual(await refusal(run("link_add", { sourceId: personal, targetId: work }, n())), await refusal(run("link_add", { sourceId: MISSING_DOC, targetId: work }, n())));
  const hiddenTarget = await refusal(run("link_add", { sourceId: work, targetId: untagged }, n()));
  assert.deepEqual(hiddenTarget, await refusal(run("link_add", { sourceId: work, targetId: MISSING_DOC }, n())));
  assert.equal(hiddenTarget.code, "link_target_not_found");
  // link_delete: a link with a hidden end answers like a missing link; a visible link is deleted
  const hiddenLink = await run("link_add", { sourceId: work, targetId: untagged }, ctx(ADA));
  assert.deepEqual(await refusal(run("link_delete", { id: hiddenLink.id }, n())), await refusal(run("link_delete", { id: "klnk_01ZZZZZZZZZZZZZZZZZZZZZZZZ" }, n())));
  const visibleLink = await run("link_add", { sourceId: both, targetId: work }, ctx(ADA));
  assert.equal((await run("link_delete", { id: visibleLink.id }, n())).deleted, true);
  // document_delete: hidden = missing (and stays); visible runs
  assert.deepEqual(await refusal(run("document_delete", { id: personal }, n())), await refusal(run("document_delete", { id: MISSING_DOC }, n())));
  assert.ok(await run("document_get", { id: personal }, ctx(ADA)));
  // document_create under a hidden parent = under a missing parent
  const collectionId = (await run("document_get", { id: work }, ctx(ADA))).collectionId as string;
  const hiddenParent = await refusal(run("document_create", { title: "child", collectionId, parentId: personal, tags: ["work"] }, n()));
  assert.deepEqual(hiddenParent, await refusal(run("document_create", { title: "child", collectionId, parentId: MISSING_DOC, tags: ["work"] }, n())));
  assert.equal(hiddenParent.code, "parent_invalid");
  assert.ok((await run("document_create", { title: "child", collectionId, parentId: work, tags: ["work"] }, n())).id);
  assert.equal((await run("document_delete", { id: both }, n())).deleted, true);
});

test("F90: a hidden company document answers like a missing one even where the agent may not write (no scope_denied oracle)", async () => {
  const { ctx, run } = await setup();
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } });
  const secret = await run("library_document_create", { area: "company", title: "Company secret", tags: ["secret"] }, owner);
  const open = await run("library_document_create", { area: "company", title: "Company notice", tags: ["work"] }, owner);
  const n = () => ctx(ADA, { context: narrowing({ anyOf: ["work"] }) });
  const missing = await refusal(run("document_update", { id: MISSING_DOC, body: "x" }, n()));
  assert.deepEqual(await refusal(run("document_update", { id: secret.id, body: "x" }, n())), missing);
  // the visible company document still answers scope_denied (read-only area): the check order is unchanged for it
  assert.equal((await refusal(run("document_update", { id: open.id, body: "x" }, n()))).code, "scope_denied");
});

test("F90: writes that cannot be checked item by item refuse a tag narrowing (collection_delete, research, engine tools, person library); collection_create runs", async () => {
  const { ctx, run, definition } = await taggedMemories();
  const n = (memoryTags: Record<string, string[]> = { anyOf: ["work"] }) => ctx(ADA, { context: narrowing(memoryTags) });
  const collection = await run("collection_create", { name: "Narrowed" }, n());
  assert.ok(collection.id, "a container without tags can be created");
  await assert.rejects(run("collection_delete", { id: collection.id }, n()), rejects("narrowing_unsupported"));
  assert.equal((await run("collection_delete", { id: collection.id }, ctx(ADA))).deleted, true, "runs without a narrowing");
  await assert.rejects(run("research_source_add", { title: "t", content: "c" }, n()), rejects("narrowing_unsupported"));
  await assert.rejects(run("research_chat_start", {}, n()), rejects("narrowing_unsupported"));
  await assert.rejects(run("research_source_delete", { id: "source:x" }, n()), rejects("narrowing_unsupported"));
  // noneOf alone: research writes run (research is off here, so the engine answers research_disabled)
  await assert.rejects(run("research_source_add", { title: "t", content: "c" }, n({ noneOf: ["personal"] })), rejects("research_disabled"));
  const dynamic = definition.dynamic?.engine;
  assert.ok(dynamic);
  await assert.rejects(dynamic.call("gb_remember", { fact: "x", area: ADA_AREA }, n()), rejects("narrowing_unsupported"));
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null }, context: narrowing({ anyOf: ["work"] }) });
  await assert.rejects(run("library_document_update", { id: MISSING_DOC, body: "x" }, owner), rejects("narrowing_unsupported"));
  await assert.rejects(run("library_comment_add", { documentId: MISSING_DOC, body: "x" }, owner), rejects("narrowing_unsupported"));
});

test("F90: every agent write op has a decided narrowing policy; every write that names an existing item is checked per item", async () => {
  const { definition } = await setup();
  const ADDRESSING = ["document_update", "document_delete", "comment_add", "link_add", "link_delete", "document_create", "remember"];
  for (const id of ADDRESSING) assert.equal(NARROWING_POLICY[id], "items", id);
  for (const op of definition.manifest.operations) {
    if (op.effect === "read" || op.dynamic || op.audience === "person") continue;
    const decided = NARROWING_POLICY[op.id] ?? (["collection_delete"].includes(op.id) ? "unsupported" : undefined);
    assert.ok(decided, `agent write op ${op.id} has a G5 write policy (§18.4)`);
  }
});

// ── QA F88 / F89: a degraded engine answer is read, reported and never silent (L3) ──

test("F88 (real upstream framing): recall reads the result item of a degraded GBrain answer, reports degraded and adds keyword search", async () => {
  const { ctx, run, knowledge, definition } = await taggedMemories();
  gbrain.queryReply = "upstream-degraded";
  try {
    const out = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA));
    // 0.1.15 read 0 rows here (2 text items → raw result) and said ok / degraded:false
    assert.ok(out.results.length >= 4, JSON.stringify(out));
    assert.equal(out.degraded, true);
    // `uncited` counts stale pages the shared fake keeps from earlier tests (C336 M1); its value depends on test order
    assert.deepEqual(
      out.areas.map(({ uncited: _uncited, ...rest }: Record<string, unknown>) => rest),
      [{ area: ADA_AREA, ok: true, via: "engine", degraded: ["embed_unavailable:no_provider"] }],
    );
    assert.ok(out.results.every((row: { source?: { ref?: unknown } }) => typeof row.source?.ref === "string"), "every hit is cited");
    assert.equal(knowledge.engineStatus().state, "degraded");
    assert.match(knowledge.attention()?.reason ?? "", /without embeddings \(embed_unavailable:no_provider\)/u);
    // the engine tools return the result item too (never the raw MCP envelope with notice text)
    const rows = await definition.dynamic?.engine?.call("gb_query", { query: "teal heron", area: ADA_AREA }, ctx(ADA));
    assert.ok(Array.isArray(rows) && rows.length >= 4, "gb_query answers the row array, not the MCP envelope");
  } finally {
    gbrain.queryReply = undefined;
  }
  // healthy again: quiet (L34)
  const healthy = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA));
  assert.equal(healthy.degraded, false);
  assert.equal(knowledge.engineStatus().state, "ok");
  assert.equal(knowledge.attention(), null);
});

test("F88: an engine answer that cannot be read falls back to keyword search with degraded:true (never an ok empty answer)", async () => {
  const { ctx, run, knowledge } = await taggedMemories();
  gbrain.queryReply = "unparsable";
  try {
    const out = await run("recall", { query: "teal heron", area: ADA_AREA }, ctx(ADA));
    assert.equal(out.degraded, true);
    assert.deepEqual(out.areas, [{ area: ADA_AREA, ok: true, via: "keyword", error: "engine_unparsable" }]);
    assert.ok(out.results.length >= 4, "keyword search still finds the memories");
    assert.equal(knowledge.attention()?.code, "memory_engine_failing");
  } finally {
    gbrain.queryReply = undefined;
  }
});

test("F89: the engine probe reports a degraded engine through attention and pushes the status once per change", async () => {
  const { ctx, run, knowledge } = await taggedMemories();
  await run("recall", { query: "warm up", area: "company" }, ctx(ADA)); // company source provisioned
  const s = knowledge.current();
  assert.ok(s);
  let pushes = 0;
  gbrain.queryReply = "upstream-degraded";
  try {
    await knowledge.watchEngine(s, () => pushes++, 0);
    assert.equal(knowledge.attention()?.code, "memory_engine_degraded");
    assert.equal(pushes, 1);
    await knowledge.probeEngine(s);
    assert.equal(pushes, 1, "no push without a change");
  } finally {
    gbrain.queryReply = undefined;
  }
  await knowledge.probeEngine(s);
  assert.equal(knowledge.attention(), null);
  assert.equal(pushes, 2, "the recovery is pushed too");
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } });
  const overview = await run("library_overview", {}, owner);
  assert.equal(overview.engine.state, "ok");
});

test("R-2: a provider_error on the embedding stage reads as a rejected key (fires); other degraded stages keep the generic reason (quiet)", async () => {
  const { knowledge } = await taggedMemories();
  knowledge.noteEngine({ state: "degraded", detail: ["embed_unavailable:provider_error"] });
  assert.equal(knowledge.attention()?.code, KEY_REJECTED);
  assert.match(knowledge.attention()?.reason ?? "", /^Key rejected by the provider: .*embed_unavailable:provider_error.*Enter a valid model key on the bridge key page\.$/u);
  knowledge.noteEngine({ state: "degraded", detail: ["embed_unavailable:no_provider"] });
  assert.equal(knowledge.attention()?.code, "memory_engine_degraded");
  knowledge.noteEngine({ state: "ok", detail: [] });
  assert.equal(knowledge.attention(), null);
});

test("C296: no memory engine is never silent: engine_missing for a setting that is not available and for a missing service (fires); quiet with GBrain", async () => {
  const { definition } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "hindsight", KNOWLEDGE_MODEL_PROVIDER: "openai" }, TestError, { drainIntervalMs: 0 });
  assert.equal((await definition.attention?.())?.code, ENGINE_MISSING);
  assert.match((await definition.attention?.())?.reason ?? "", /"hindsight" is not available yet.*Choose GBrain in Portal/u);
  const noService = knowledgeDefinition({ KNOWLEDGE_ENGINE: "gbrain" }, TestError, { drainIntervalMs: 0 });
  assert.equal(noService.knowledge.attention()?.code, ENGINE_MISSING);
  assert.match(noService.knowledge.attention()?.reason ?? "", /GBrain service is not deployed/u);
  const { knowledge } = await setup();
  assert.equal(knowledge.attention(), null);
});

test("C296: documents written with no engine reach GBrain on the first GBrain boot (hindsight → gbrain switch); a restore requeues in onStart", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const none = knowledgeDefinition({ KNOWLEDGE_ENGINE: "hindsight" }, TestError, { drainIntervalMs: 0 }).knowledge;
  const s0 = none.bind(db);
  await s0.areas.ensureShared(scopes.asStore());
  for (const title of ["c296 one", "c296 two", "c296 three"]) s0.store.createDocument({ area: "company", title, body: `${title} body`, status: "published", actor: ADA });
  assert.equal(s0.projector, null, "no engine: nothing projects");
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken };
  const boot = async (restore: boolean) => {
    const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0, engineProbeMs: 0 });
    const lines: string[] = [];
    const log = { debug() {}, info: (msg: string) => void lines.push(msg), warn() {}, error() {} };
    const callServiceHelper = (async (_service: string, _path: string, body: Json) => {
      gbrain.sources.add(String((body as Record<string, unknown>).id));
      return {};
    }) as OpContext["callServiceHelper"];
    if (restore) await definition.backup?.afterRestore?.();
    await definition.onStart({ db, secrets: memorySecrets(), log: log as never, scopes: scopes.asStore(), getKey: async () => null, callServiceHelper, statusChanged() {} });
    await knowledge.current()?.projector?.drain();
    knowledge.stop();
    return { lines, attention: knowledge.attention() };
  };
  const first = await boot(false);
  assert.deepEqual(db.prepare("SELECT state, COUNT(*) AS n FROM kn_projection GROUP BY state").all().map((r) => ({ ...r })), [{ state: "ready", n: 3 }]);
  const company = [...gbrain.pages.values()].flatMap((pages) => [...pages.values()].map((p) => p.content)).filter((c) => c.includes("c296"));
  assert.equal(company.length, 3, "every document is a GBrain page");
  assert.notEqual(first.attention?.code, ENGINE_MISSING);
  assert.ok(!first.lines.includes("projection requeued after restore"), "quiet without a restore");
  const puts = () => gbrain.calls.filter((c) => c.name === "put_page").length;
  const before = puts();
  const second = await boot(true);
  assert.ok(second.lines.includes("projection requeued after restore"), "a restore before onStart requeues (the SDK restores before bind)");
  assert.equal(puts() - before, 3, "every document is projected again (hashes cleared: a restore may leave the engine older or newer)");
});

test("C296 (prod): the engine comes up after Knowledge: provisioning retries in the background and every document reaches GBrain", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const none = knowledgeDefinition({ KNOWLEDGE_ENGINE: "hindsight" }, TestError, { drainIntervalMs: 0 }).knowledge;
  const s0 = none.bind(db);
  await s0.areas.ensureShared(scopes.asStore());
  for (const title of ["late one", "late two"]) s0.store.createDocument({ area: "company", title, body: `${title} body`, status: "published", actor: ADA });
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0, engineProbeMs: 0, provisionRetryMs: 5 });
  let down = 3; // the companion is not reachable for the boot provision and two retries
  const callServiceHelper = (async (_service: string, _path: string, body: Json) => {
    if (down-- > 0) throw new Error("service_unreachable");
    gbrain.sources.add(String((body as Record<string, unknown>).id));
    return {};
  }) as OpContext["callServiceHelper"];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  try {
    await definition.onStart({ db, secrets: memorySecrets(), log: log as never, scopes: scopes.asStore(), getKey: async () => null, callServiceHelper, statusChanged() {} });
    assert.equal(knowledge.current()?.areas.get("company")?.sourceReady, false, "the boot provision failed");
    // A drain while the area is not ready makes the rows fail area_not_ready (what prod showed).
    await knowledge.current()?.projector?.drain();
    db.prepare("UPDATE kn_projection SET state = 'failed', attempts = 12").run(); // a long outage: the rows gave up
    const state = () => db.prepare("SELECT state, COUNT(*) AS n FROM kn_projection GROUP BY state").all().map((r) => ({ ...r }));
    for (let i = 0; i < 200 && JSON.stringify(state()) !== JSON.stringify([{ state: "ready", n: 2 }]); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(state(), [{ state: "ready", n: 2 }], "no agent call and no manual drain: the retry kicks the outbox");
    assert.equal(knowledge.current()?.areas.get("company")?.sourceReady, true);
    assert.equal(knowledge.provisionRetrying(), false, "the retry loop ends once every area is ready");
    // A new agent's area gets its source in the background too (no agent call).
    await definition.events?.agentAdded?.({ id: BO, name: "Bo", mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("no companions"); }, statusChanged() {}, ownerLink: () => null });
    for (let i = 0; i < 200 && !knowledge.current()?.areas.get(BO_AREA)?.sourceReady; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(knowledge.current()?.areas.get(BO_AREA)?.sourceReady, true);
  } finally {
    knowledge.stop();
  }
});

test("C296 review: an engine that never answers is reported (memory_engine_unreachable) and clears when it comes up; stop() ends the loop", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0, engineProbeMs: 0, provisionRetryMs: 1 });
  let up = false;
  const callServiceHelper = (async (_service: string, _path: string, body: Json) => {
    if (!up) throw new Error("service_unreachable");
    gbrain.sources.add(String((body as Record<string, unknown>).id));
    return {};
  }) as OpContext["callServiceHelper"];
  const warned: string[] = [];
  let pushes = 0;
  const log = { debug() {}, info() {}, warn: (msg: string) => void warned.push(msg), error() {} };
  try {
    await definition.onStart({ db, secrets: memorySecrets(), log: log as never, scopes: scopes.asStore(), getKey: async () => "sk-test", callServiceHelper, statusChanged: () => void pushes++ });
    const wait = async (done: () => boolean) => {
      for (let i = 0; i < 300 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await wait(() => knowledge.attention()?.code === ENGINE_UNREACHABLE);
    assert.equal(knowledge.attention()?.code, ENGINE_UNREACHABLE, "never silent (fires)");
    assert.ok(pushes >= 1, "the status is pushed when it becomes unreachable");
    assert.ok(warned.includes("area provisioning failed; retrying later"), "the first failure is logged");
    up = true;
    await wait(() => !knowledge.provisionRetrying());
    assert.equal(knowledge.current()?.areas.get("company")?.sourceReady, true);
    assert.notEqual(knowledge.attention()?.code, ENGINE_UNREACHABLE, "clears once the engine answers (quiet)");
  } finally {
    knowledge.stop();
  }
  assert.equal(knowledge.provisionRetrying(), false);
});

test("C296 review: stop() during an in-flight background provision does not schedule another retry", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0, engineProbeMs: 0, provisionRetryMs: 1 });
  let calls = 0;
  let release: () => void = () => undefined;
  const callServiceHelper = (async () => {
    calls++;
    if (calls === 1) throw new Error("service_unreachable");
    await new Promise<void>((resolve) => (release = resolve));
    throw new Error("service_unreachable");
  }) as OpContext["callServiceHelper"];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  await definition.onStart({ db, secrets: memorySecrets(), log: log as never, scopes: scopes.asStore(), getKey: async () => null, callServiceHelper, statusChanged() {} });
  for (let i = 0; i < 200 && calls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(calls, 2, "the background retry is in flight");
  knowledge.stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(knowledge.provisionRetrying(), false);
  assert.equal(calls, 2, "no retry after stop()");
});

test("C296 (prod): the engine catalog fails visibly before the company source exists and lists the tools once it does", async () => {
  const { ctx, run, definition } = await setup();
  const dynamic = definition.dynamic?.engine;
  assert.ok(dynamic);
  const warned: string[] = [];
  const hookCtx = { db: ctx(ADA).db, log: { debug() {}, info() {}, warn: (msg: string) => void warned.push(msg), error() {} }, getKey: async () => null, signal: new AbortController().signal, secrets: memorySecrets() };
  gbrain.sources.clear();
  // Before: no source in the engine yet. An empty list would be cached by the bridge as "no tools" with no signal.
  await assert.rejects(dynamic.catalog(null, hookCtx as never), Error);
  assert.ok(warned.includes("engine catalog failed"));
  await run("recall", { query: "warm up" }, ctx(ADA)); // provisions the sources
  const names = (await dynamic.catalog(null, hookCtx as never)).map((entry) => entry.name);
  assert.ok(names.includes("gb_query") && names.includes("gb_get_page"), "the engine tools are listed once the source exists");
});

test("C296 Settings: engine (GBrain, Hindsight greyed soon), models and key names, documents, capabilities, areas; never a key value", async () => {
  const { ctx, run } = await setup();
  await run("remember", { text: "Settings probe memory" }, ctx(ADA));
  await run("recall", { query: "warm up" }, ctx(ADA)); // provisions the sources
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } });
  const out = await run("settings_overview", {}, owner);
  assert.equal(out.engine.configured, "gbrain");
  assert.equal(out.engine.running, true);
  assert.deepEqual(out.engine.choices, [{ value: "gbrain", label: "GBrain", note: "Sourced pages and facts, hybrid search, a typed graph of people and companies." }, { value: "hindsight", label: "Hindsight", note: "soon", disabled: true }]);
  assert.deepEqual(out.models.keys, ["OPENAI_API_KEY"]);
  assert.equal(out.documents.total, 1);
  assert.ok(Array.isArray(out.areas) && out.areas.some((a: Record<string, unknown>) => a.id === ADA_AREA && a.engineReady === true));
  assert.equal(out.tools.error, null);
  assert.ok(out.tools.offered >= 1);
  const cap = (id: string) => out.capabilities.find((c: Record<string, unknown>) => c.id === id);
  assert.equal(cap("entities").state, "on");
  assert.equal(cap("think").state, "off", "the engine reports no chat model key");
  assert.match(cap("think").reason, /Needs OPENAI_API_KEY in the engine/u, "the configured provider's key is named");
  assert.equal(out.embeddings.readiness.state, "ok");
  assert.ok(out.embeddings.chunks >= 2 && out.embeddings.embedded === out.embeddings.chunks, "chunks embedded n of N from the engine");
  assert.equal(out.engine.version, "0.60.424.0");
  assert.equal(cap("reranker").state, "off");
  assert.match(cap("reranker").reason, /VOYAGE_API_KEY/u);
  const text = JSON.stringify(out);
  for (const secret of [gbrain.adminToken, "gbrain_admin=s1", "must-not-leak"]) assert.ok(!text.includes(secret), `no ${secret} in the answer`);
});

test("C296 Settings without an engine: engine_missing, nothing running, every capability off", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const { definition } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "hindsight" }, TestError, { drainIntervalMs: 0 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  await definition.events?.agentAdded?.({ id: ADA, name: "Ada", mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("no companions"); }, statusChanged() {}, ownerLink: () => null });
  const spec = definition.handlers.settings_overview;
  const handler = typeof spec === "function" ? spec : spec?.run;
  assert.ok(handler);
  const owner = context(db, scopes, ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } });
  const out = (await handler({} as Json, owner)) as Record<string, any>;
  assert.equal(out.engine.configured, "hindsight");
  assert.equal(out.engine.running, false);
  assert.equal(out.engine.attention.code, ENGINE_MISSING);
  assert.ok(out.capabilities.every((c: Record<string, unknown>) => c.state === "off"));
  assert.equal(out.tools.offered, null);
});

test("C296 review: Settings reads the engine counts again after an engine restart forgot the admin session (one re-login)", async () => {
  const { ctx, run } = await setup();
  await run("remember", { text: "Restart probe" }, ctx(ADA));
  await run("recall", { query: "warm up" }, ctx(ADA));
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } });
  assert.ok((await run("settings_overview", {}, owner)).embeddings.chunks !== null);
  gbrain.adminSessionsLost = true;
  const out = await run("settings_overview", {}, owner);
  assert.ok(out.embeddings.chunks !== null, "counts after one re-login");
  assert.equal(out.embeddings.error, null);
});

test("C296 INFO-2: while the engine waits for its provider key the attention names the key; it clears when the key is set (quiet)", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken, KNOWLEDGE_MODEL_PROVIDER: "openai" };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0, engineProbeMs: 0, provisionRetryMs: 1_000_000 });
  let key: string | null = null;
  let pushes = 0;
  const callServiceHelper = (async (_service: string, _path: string, body: Json) => {
    gbrain.sources.add(String((body as Record<string, unknown>).id));
    return {};
  }) as OpContext["callServiceHelper"];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  try {
    await definition.onStart({ db, secrets: memorySecrets(), log: log as never, scopes: scopes.asStore(), getKey: async () => key, callServiceHelper, statusChanged: () => void pushes++ });
    assert.equal(knowledge.attention()?.code, ENGINE_KEY_MISSING, "fires");
    assert.match(knowledge.attention()?.reason ?? "", /waits for OPENAI_API_KEY.*bridge key page.*starts by itself/u);
    assert.ok(pushes >= 1, "the status is pushed");
    key = "sk-test-value";
    await definition.events?.keysChanged?.(["OPENAI_API_KEY"], { db, scopes: scopes.asStore(), log, callApp: async () => ({}) as never, statusChanged() {}, ownerLink: () => null } as never);
    assert.notEqual(knowledge.attention()?.code, ENGINE_KEY_MISSING, "quiet once the key is set");
    assert.ok(!JSON.stringify(knowledge.attention() ?? {}).includes("sk-test-value"), "never the value");
  } finally {
    knowledge.stop();
  }
});

test("C296 INFO-2: an unknown key state is not 'missing'; the Anthropic provider names both keys; no engine keeps engine_missing first", async () => {
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken, KNOWLEDGE_MODEL_PROVIDER: "anthropic" };
  const { knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0 });
  assert.deepEqual(await knowledge.checkProviderKeys({ getKey: async () => { throw new Error("key_unavailable"); } }), [], "the bridge did not answer: unknown, not missing");
  assert.deepEqual(await knowledge.checkProviderKeys({ getKey: async () => null }), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  // review: a known-missing key stays missing while the bridge cannot answer (paused, updating) — no flapping
  assert.deepEqual(await knowledge.checkProviderKeys({ getKey: async () => { throw new Error("key_unavailable"); } }), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  assert.match(knowledge.attention()?.reason ?? "", /waits for ANTHROPIC_API_KEY, OPENAI_API_KEY, so recall is keyword-only\. Enter them/u);
  const none = knowledgeDefinition({ KNOWLEDGE_ENGINE: "hindsight" }, TestError, { drainIntervalMs: 0 }).knowledge;
  assert.deepEqual(await none.checkProviderKeys({ getKey: async () => null }), [], "no engine: no engine key to wait for");
  assert.equal(none.attention()?.code, ENGINE_MISSING);
});

test("C296 INFO-2 review: once the key arrives the owner never reads 'cannot be set up'; provisioning starts over at once; each retry re-checks the key", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken, KNOWLEDGE_MODEL_PROVIDER: "openai" };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0, engineProbeMs: 0, provisionRetryMs: 1 });
  let key: string | null | "error" = "error"; // the bridge cannot answer at boot
  const getKey = async () => {
    if (key === "error") throw new Error("key_unavailable");
    return key;
  };
  // tb-exec holds GBrain without its key: sources cannot be created until the key is set
  const callServiceHelper = (async (_service: string, _path: string, body: Json) => {
    if (key === null || key === "error") throw new Error("upstream_not_started");
    gbrain.sources.add(String((body as Record<string, unknown>).id));
    return {};
  }) as OpContext["callServiceHelper"];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const wait = async (done: () => boolean) => {
    for (let i = 0; i < 300 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    await definition.onStart({ db, secrets: memorySecrets(), log: log as never, scopes: scopes.asStore(), getKey, callServiceHelper, statusChanged() {} });
    assert.notEqual(knowledge.attention()?.code, ENGINE_KEY_MISSING, "unknown at boot: not missing");
    key = null; // now the bridge answers: unset — a background retry finds it (no event needed)
    await wait(() => knowledge.attention()?.code === ENGINE_KEY_MISSING);
    assert.equal(knowledge.attention()?.code, ENGINE_KEY_MISSING, "each retry re-checks the key");
    await new Promise((resolve) => setTimeout(resolve, 100)); // retries climb past the unreachable threshold meanwhile
    key = "sk-test-value";
    await definition.events?.keysChanged?.(["OPENAI_API_KEY"], { db, scopes: scopes.asStore(), log, callApp: async () => ({}) as never, statusChanged() {}, ownerLink: () => null } as never);
    assert.notEqual(knowledge.attention()?.code, ENGINE_UNREACHABLE, "never 'cannot be set up' right after the key arrives");
    await wait(() => knowledge.current()?.areas.get("company")?.sourceReady === true);
    assert.equal(knowledge.current()?.areas.get("company")?.sourceReady, true, "provisioning started over and succeeded");
  } finally {
    knowledge.stop();
  }
});
