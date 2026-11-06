// C373 Foundry: the feed of Knowledge documents into the deep service (tables as datasets, text as one dataset,
// idempotent, deletions), and the agent tools deep_search / deep_ask / deep_status / deep_settings_set over a FAKE deep
// service that speaks foundry's API shapes (captured from the pinned helix-foundry on neuu, 2026-10-27).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { knowledgeDefinition } from "../src/app.ts";
import { matchSql, NEEDS_MODEL, searchWords } from "../src/deep.ts";
import { CsvError, parseCsv, parseCsvPages } from "../src/engines/deep/csv.ts";
import { SOURCE_COLUMN, tableKey, tableName } from "../src/engines/deep/sync.ts";
import { NARROWING_POLICY } from "../src/handlers.ts";
import { context, FakeScopes, memoryDb, TestError } from "./helpers.ts";

const TOKEN = "d".repeat(48);
const ADA = "agt_01AAAAAAAAAAAAAAAAAAAAAAAA";
const BO = "agt_01BBBBBBBBBBBBBBBBBBBBBBBB";
const ADA_AREA = "agent-01aaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER = { type: "person", id: "per_01OWNER000000000000000000", name: "Owner", mode: null } as unknown as OpContext["caller"];

type Row = Record<string, unknown>;
interface FakeDataset {
  id: string;
  name: string;
  description: string;
  versions: Row[][];
  active: number;
  pending: boolean;
}
interface FakeDeep {
  url: string;
  workspaces: Map<string, { name: string; datasets: Map<string, FakeDataset>; runs: Map<string, Row> }>;
  calls: { method: string; path: string; body?: Row }[];
  model: Row;
  /** what a run answers once polled (null = stays running) */
  runAnswer: Row | null;
  close(): Promise<void>;
}

/** Columns of a row list (name + DuckDB-ish type), as foundry profiles them. */
const profile = (rows: Row[]) => {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { rows: rows.length, columns: names.map((name) => ({ name, type: rows.every((r) => typeof r[name] === "number" || r[name] == null) ? "DOUBLE" : "VARCHAR" })) };
};

async function fakeDeep(): Promise<FakeDeep> {
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const state: Omit<FakeDeep, "url" | "close"> = { workspaces: new Map(), calls: [], model: { state: "unset" }, runAnswer: null };
  const datasetJson = (ds: FakeDataset) => ({ id: ds.id, name: ds.name, description: ds.description, data: { activeVersion: `v${ds.active}`, pendingVersion: ds.pending ? `v${ds.versions.length - 1}` : null, table: `d_${ds.id.replace(/-/gu, "")}`, profile: profile(ds.versions[ds.active] ?? []) } });
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Row) : undefined;
    const path = req.url ?? "";
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
    state.calls.push({ method: req.method ?? "", path, ...(body ? { body } : {}) });
    if (path === "/deep/status") return json(200, { model: state.model });
    if (path === "/api/v1/me") return json(200, { user: { id: "local-user" }, workspaces: [...state.workspaces].map(([wid, w]) => ({ id: wid, name: w.name, role: "owner" })) });
    if (path === "/api/v1/workspaces" && req.method === "POST") {
      const wid = id();
      state.workspaces.set(wid, { name: String(body?.name), datasets: new Map(), runs: new Map() });
      return json(200, { id: wid, name: body?.name });
    }
    const m = /^\/api\/v1\/workspaces\/([^/]+)\/(.*)$/u.exec(path);
    const ws = m ? state.workspaces.get(m[1] as string) : undefined;
    if (!m || !ws) return json(404, { error: "Workspace not found" });
    const rest = m[2] as string;
    if (rest === "ingest") {
      const rows = body?.rows as Row[];
      if (!rows?.length) return json(400, { error: "Provide at least one row" });
      const known = typeof body?.datasetId === "string" ? ws.datasets.get(body.datasetId) : undefined;
      if (known) {
        const before = JSON.stringify(profile(known.versions[known.active] ?? []).columns);
        known.versions.push(rows);
        const drift = before !== JSON.stringify(profile(rows).columns);
        if (drift) known.pending = true;
        else known.active = known.versions.length - 1;
        return json(200, datasetJson(known));
      }
      const ds: FakeDataset = { id: id(), name: String(body?.name), description: "", versions: [rows], active: 0, pending: false };
      ws.datasets.set(ds.id, ds);
      return json(200, datasetJson(ds));
    }
    const accept = /^datasets\/([^/]+)\/accept-version$/u.exec(rest);
    if (accept) {
      const ds = ws.datasets.get(accept[1] as string);
      if (!ds?.pending) return json(400, { error: "No pending version" });
      ds.pending = false;
      ds.active = ds.versions.length - 1;
      return json(200, datasetJson(ds));
    }
    const patch = /^datasets\/([^/]+)$/u.exec(rest);
    if (patch && req.method === "PATCH") {
      const ds = ws.datasets.get(patch[1] as string);
      if (!ds) return json(404, {});
      ds.description = String(body?.description);
      return json(200, datasetJson(ds));
    }
    if (rest === "resources/dataset") return json(200, { items: [...ws.datasets.values()].map(datasetJson), total: ws.datasets.size });
    if (rest === "query") {
      // the fake runs the only SQL shape Knowledge sends: every `contains(..., '<word>')` group must match a column
      const ds = ws.datasets.get(String((body?.inputs as string[] | undefined)?.[0]));
      if (!ds) return json(404, { error: "Dataset is unavailable" });
      const sql = String(body?.sql);
      const words = [...sql.matchAll(/\(contains\(lower\(CAST\("[^"]+" AS VARCHAR\)\), '([^']+)'\)/gu)].map((x) => x[1] as string);
      const select = /^SELECT (\S+) FROM/u.exec(sql)?.[1];
      const rows = (ds.versions[ds.active] ?? []).filter((r) => words.every((w) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(w))));
      return json(200, { rows: rows.map((r) => (select === "*" ? r : { [select as string]: r[select as string] })), state: "dataset_snapshot" });
    }
    if (rest === "assistant/runs" && req.method === "POST") {
      const run = { id: id(), data: { goal: body?.goal, intent: body?.intent, status: "queued" } };
      ws.runs.set(run.id, run);
      return json(200, run);
    }
    const run = /^resources\/run\/([^/]+)$/u.exec(rest);
    if (run) {
      const found = ws.runs.get(run[1] as string) as { id: string; data: Row } | undefined;
      if (!found) return json(404, { error: "not found" });
      if (state.runAnswer) found.data = { ...found.data, status: "succeeded", answer: state.runAnswer };
      else found.data = { ...found.data, status: "running" };
      return json(200, found);
    }
    return json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return Object.assign(state, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
}

let deep: FakeDeep;
before(async () => {
  deep = await fakeDeep();
});
after(async () => {
  await deep.close();
});

async function setup(opts: { deep?: boolean } = {}) {
  deep.workspaces.clear();
  deep.calls.length = 0;
  deep.model = { state: "unset" };
  deep.runAnswer = null;
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", ...(opts.deep === false ? {} : { KNOWLEDGE_DEEP: "true", KNOWLEDGE_DEEP_URL: deep.url, KNOWLEDGE_DEEP_TOKEN: TOKEN }) };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0, deepSyncMs: 0, deepAskWaitMs: 300, deepAskPollMs: 10 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  for (const [agent, name] of [[ADA, "Ada"], [BO, "Bo"]] as const) {
    await definition.events?.agentAdded?.({ id: agent, name, mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("no companions"); }, statusChanged() {}, ownerLink: () => null, modelRole: async () => null } as never);
    scopes.applyDefaults(agent);
  }
  const ctx = (agent: string, extra: Partial<OpContext> = {}) => context(db, scopes, agent, extra);
  const run = async (name: string, input: Record<string, unknown>, c: OpContext) => {
    const spec = definition.handlers[name];
    const handler = typeof spec === "function" ? spec : spec?.run;
    if (!handler) throw new Error(`no handler ${name}`);
    const declared = definition.manifest.operations.find((o) => o.id === name);
    if (declared?.input) {
      const checked = validateInput({ ...declared, standard: false } as never, input as never) as { ok: boolean };
      assert.ok(checked.ok, `${name} input: ${JSON.stringify(checked)}`);
    }
    const withOp = c.op ? c : ({ ...c, op: declared ? { ...declared, standard: false } : null } as OpContext);
    const output = (await handler(input as Json, withOp)) as Record<string, any>;
    if (declared?.output) {
      const checked = validateInput({ ...declared, standard: false, input: declared.output } as never, output as never) as { ok: boolean };
      assert.ok(checked.ok, `${name} output: ${JSON.stringify(checked)}`);
    }
    return output;
  };
  const services = knowledge.bind(db, memorySecretsOf(ctx(ADA)));
  const owner = ctx(ADA, { caller: OWNER });
  /** what an Observer delivery leaves in the store (the app-caller document_create path is covered in knowledge.test.ts) */
  const deliver = async (title: string, body: string, tags: string[], area = "company") => services.store.createDocument({ area, title, body, tags, status: "published", actor: "app:observer" });
  const update = (id: string, body: string) => services.store.updateDocument(id, { body }, undefined, "app:observer");
  const remove = (id: string) => services.store.deleteDocument(id, "app:observer");
  return { db, scopes, definition, knowledge, services, ctx, run, owner, deliver, update, remove };
}
const memorySecretsOf = (c: OpContext) => (c as unknown as { secrets: never }).secrets;
const rejects = (code: string) => (error: unknown) => error instanceof TestError && error.code === code;
const narrowing = (memoryTags: Record<string, string[]>) => ({ "rules.narrowing": { v: 1, ruleId: "rul_01TESTRULE0000000000000000", reason: "test", memoryTags } }) as OpContext["context"];

const ORDERS_P1 = "order_id,customer,amount,status\n1001,Acme LLC,1200.50,paid\n1002,Globex,990,past_due\n";
const ORDERS_P2 = "order_id,customer,amount,status\n1003,Initech,450,past_due\n";

test("csv: header, quotes, CRLF, typed columns (leading-zero ids stay text), pages merge by column name", () => {
  const t = parseCsv('id,name,amount,zip,ok\r\n1,"Acme, LLC",12.5,0123,true\r\n2,"say ""hi""",-3,0456,false\r\n');
  assert.deepEqual(t.columns, ["id", "name", "amount", "zip", "ok"]);
  assert.deepEqual(t.rows[0], { id: 1, name: "Acme, LLC", amount: 12.5, zip: "0123", ok: true });
  assert.equal(t.rows[1]?.name, 'say "hi"');
  const merged = parseCsvPages(["a,b\n1,x\n", "b,c\ny,2\n"]);
  assert.deepEqual(merged.columns, ["a", "b", "c"]);
  assert.deepEqual(merged.rows[1], { a: null, b: "y", c: 2 });
  assert.deepEqual(merged.pages, [0, 1]);
  assert.throws(() => parseCsv('a,b\n"open,1\n'), CsvError);
  assert.throws(() => parseCsv(""), CsvError);
});

test("table key and name: Observer's source:<schema>.<table> tag groups pages; without it the document is its own table", () => {
  assert.equal(tableKey({ id: "kdoc_1", tags: ["kind:table", "source:public.orders"] }), "source:public.orders");
  assert.equal(tableKey({ id: "kdoc_1", tags: ["kind:table"] }), "doc:kdoc_1");
  assert.equal(tableName("source:public.orders", "Orders page 1"), "orders");
  assert.equal(tableName("doc:kdoc_1", "Q3 pipeline"), "Q3 pipeline");
});

test("search words and SQL: only letters, digits and @._:- reach the query (no quote), every word must match a column", () => {
  assert.deepEqual(searchWords("Globex  past_due'; DROP"), ["globex", "past_due", "drop"]);
  assert.deepEqual(searchWords("'\"%"), []);
  const sql = matchSql("d_1", ["a", 'we"ird'], ["x", "y"], 10);
  assert.equal(sql, `SELECT * FROM "d_1" WHERE (contains(lower(CAST("a" AS VARCHAR)), 'x') OR contains(lower(CAST("we""ird" AS VARCHAR)), 'x')) AND (contains(lower(CAST("a" AS VARCHAR)), 'y') OR contains(lower(CAST("we""ird" AS VARCHAR)), 'y')) LIMIT 10`);
});

test("feed: company table pages → one foundry dataset with a source column, text → knowledge_documents; idempotent on (id, version)", async () => {
  const { services, deliver, update } = await setup();
  const p1 = await deliver("orders page 1", ORDERS_P1, ["kind:table", "source:public.orders"]);
  await deliver("orders page 2", ORDERS_P2, ["kind:table", "source:public.orders"]);
  const memo = await deliver("Q3 board memo", "Globex asked for a payment plan. Initech renewal is at risk.", ["report", "source:drive"]);
  // an agent area is never fed (only the company area)
  await deliver("Ada private", "Globex private note", [], ADA_AREA);
  const sync = services.deepSync;
  assert.ok(sync);
  const report = await sync.run();
  assert.deepEqual(report.areas.map((a) => [a.area, a.ok, a.tables, a.sent]), [["company", true, 1, 2]]);
  assert.equal(deep.workspaces.size, 1, "one workspace: the company area");
  const ws = [...deep.workspaces.values()][0];
  const orders = [...(ws?.datasets.values() ?? [])].find((d) => d.name === "orders");
  assert.equal(orders?.versions[0]?.length, 3);
  assert.deepEqual(orders?.versions[0]?.[0], { order_id: 1001, customer: "Acme LLC", amount: 1200.5, status: "paid", [SOURCE_COLUMN]: p1.id });
  const text = [...(ws?.datasets.values() ?? [])].find((d) => d.name === "knowledge_documents");
  assert.deepEqual(
    text?.versions[0]?.map((r) => r.document_id),
    [memo.id],
  );
  // nothing changed → nothing sent
  const calls = deep.calls.length;
  assert.deepEqual((await sync.run()).areas[0]?.sent, 0);
  assert.equal(deep.calls.filter((c) => c.path.endsWith("/ingest")).length, deep.calls.slice(0, calls).filter((c) => c.path.endsWith("/ingest")).length);
  // a new version of one page → a new snapshot of the same dataset
  update(p1.id, `${ORDERS_P1}1004,Hooli,10,paid\n`);
  assert.equal((await sync.run()).areas[0]?.sent, 1);
  assert.equal(orders?.versions.length, 2);
  assert.equal(orders?.versions[1]?.length, 4);
});

test("feed: a schema change is accepted, a bad CSV is recorded (not retried until it changes), a deleted table gets a tombstone", async () => {
  const { services, deliver, update, remove } = await setup();
  const sync = services.deepSync;
  assert.ok(sync);
  const t = await deliver("invoices", "invoice,amount\nINV-1,10\n", ["kind:table", "source:public.invoices"]);
  const bad = await deliver("broken", 'a,b\n"open,1\n', ["kind:table", "source:public.broken"]);
  await sync.run();
  const tables = Object.fromEntries(sync.tables("company").map((x) => [x.name, x]));
  assert.equal(tables.invoices?.state, "synced");
  assert.equal(tables.broken?.state, "failed");
  assert.match(String(tables.broken?.lastError), /quoted field/u);
  const ingests = () => deep.calls.filter((c) => c.path.endsWith("/ingest")).length;
  const before = ingests();
  await sync.run();
  assert.equal(ingests(), before, "a failed table is not retried while its documents are unchanged");
  // new column → drift → pending → Knowledge accepts it
  update(t.id, "invoice,amount,status\nINV-1,10,open\n");
  await sync.run();
  assert.ok(deep.calls.some((c) => c.path.endsWith("/accept-version")));
  // the table's only document is deleted → tombstone snapshot (accepted) + description
  remove(t.id);
  await sync.run();
  const after = Object.fromEntries(sync.tables("company").map((x) => [x.name, x]));
  assert.equal(after.invoices?.state, "deleted");
  const ds = [...([...deep.workspaces.values()][0]?.datasets.values() ?? [])].find((d) => d.name === "invoices");
  assert.deepEqual(ds?.versions[ds.active], [{ removed: true }]);
  assert.match(String(ds?.description), /Removed/u);
  void bad;
});

test("deep_search: rows and documents with citations; tag narrowing hides tables and documents whose sources fail it", async () => {
  const { services, deliver, run, ctx } = await setup();
  const p1 = await deliver("orders page 1", ORDERS_P1, ["kind:table", "source:public.orders"]);
  await deliver("orders page 2", ORDERS_P2, ["kind:table", "source:public.orders"]);
  const memo = await deliver("Support escalation", "Globex escalated invoice 1002 twice.", ["support"]);
  await deliver("HR note", "Globex contact changed roles.", ["hr"]);
  await services.deepSync?.run();
  const out = await run("deep_search", { query: "globex" }, ctx(ADA));
  const rows = out.results.filter((r: any) => r.kind === "row");
  assert.deepEqual(rows.map((r: any) => [r.table, r.row.order_id, r.documentId]), [["orders", 1002, p1.id]]);
  assert.equal(rows[0].row[SOURCE_COLUMN], undefined, "the source column is the citation, not a value");
  assert.equal(rows[0].source.ref, `knowledge:document/${p1.id}`);
  const docs = out.results.filter((r: any) => r.kind === "document").map((r: any) => r.title);
  assert.deepEqual(docs.sort(), ["HR note", "Support escalation"]);
  // two words must both match
  assert.equal((await run("deep_search", { query: "past_due initech" }, ctx(ADA))).results.length, 1);
  // Rules: support only → the orders table (untagged as support) and the HR note are hidden
  const narrowed = await run("deep_search", { query: "globex" }, ctx(ADA, { context: narrowing({ anyOf: ["support"] }) }));
  assert.deepEqual(
    narrowed.results.map((r: any) => r.documentId),
    [memo.id],
  );
  // area named: only the company area
  await assert.rejects(run("deep_search", { query: "x", area: ADA_AREA }, ctx(ADA)), rejects("deep_area_unsupported"));
  await assert.rejects(run("deep_search", { query: "x", area: "agent-01bbbbbbbbbbbbbbbbbbbbbbbb" }, ctx(ADA)), rejects("not_found"));
});

test("deep tools respect area access: an agent without a company area grant gets nothing", async () => {
  const { services, deliver, run, ctx, scopes } = await setup();
  await deliver("orders", ORDERS_P1, ["kind:table", "source:public.orders"]);
  await services.deepSync?.run();
  scopes.set(BO, "company", null);
  assert.deepEqual((await run("deep_search", { query: "globex" }, ctx(BO))).results, []);
  assert.deepEqual((await run("deep_status", {}, ctx(BO))).areas, []);
  await assert.rejects(run("deep_ask", { question: "Who is past due?" }, ctx(BO)), rejects("not_found"));
});

test("deep_ask: without a reasoning model it says so plainly and points to deep_search; a tag narrowing refuses it", async () => {
  const { services, deliver, run, ctx } = await setup();
  await deliver("orders", ORDERS_P1, ["kind:table", "source:public.orders"]);
  await services.deepSync?.run();
  const out = await run("deep_ask", { question: "Which customers are past due?" }, ctx(ADA));
  assert.equal(out.answered, false);
  assert.equal(out.status, "no_model");
  assert.ok(out.message.startsWith(NEEDS_MODEL));
  assert.match(out.message, /deep_search/u);
  assert.ok(!deep.calls.some((c) => c.path.endsWith("/assistant/runs")), "no run is started without a model");
  deep.model = { state: "failed", error: "the reasoning model did not answer Foundry's test: 401" };
  assert.match((await run("deep_ask", { question: "Which customers are past due?" }, ctx(ADA))).message, /could not use the reasoning model/u);
  assert.equal(NARROWING_POLICY.deep_ask, "unsupported");
  await assert.rejects(run("deep_ask", { question: "Which customers are past due?" }, ctx(ADA, { context: narrowing({ anyOf: ["support"] }) })), rejects("narrowing_unsupported"));
});

test("deep_ask: with a model the analyst's rows, SQL and citations to Knowledge documents come back; a slow run hands back its runId", async () => {
  const { services, deliver, run, ctx } = await setup();
  const p1 = await deliver("orders page 1", ORDERS_P1, ["kind:table", "source:public.orders"]);
  const p2 = await deliver("orders page 2", ORDERS_P2, ["kind:table", "source:public.orders"]);
  await services.deepSync?.run();
  deep.model = { state: "ok", provider: "openai-compatible", model: "qwen" };
  const orders = services.deepSync?.tables("company")[0];
  // still running when the wait ends
  const pending = await run("deep_ask", { question: "Which customers are past due?" }, ctx(ADA));
  assert.equal(pending.answered, false);
  assert.ok(pending.runId);
  deep.runAnswer = {
    title: "Past due customers",
    sql: "SELECT customer FROM orders WHERE status = 'past_due'",
    inputs: [orders?.datasetId],
    rows: [
      { customer: "Globex", [SOURCE_COLUMN]: p1.id },
      { customer: "Initech", [SOURCE_COLUMN]: p2.id },
    ],
    total: 2,
    assumptions: ["past_due means unpaid after the due date"],
    citations: [{ datasetId: orders?.datasetId, version: "v0" }],
  };
  const out = await run("deep_ask", { runId: pending.runId }, ctx(ADA));
  assert.equal(out.answered, true);
  assert.equal(out.title, "Past due customers");
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.citations.map((c: any) => c.documentId).sort(), [p1.id, p2.id].sort());
  assert.equal(deep.calls.filter((c) => c.path.endsWith("/assistant/runs")).length, 1);
  assert.deepEqual(deep.calls.find((c) => c.path.endsWith("/assistant/runs"))?.body, { goal: "Which customers are past due?", intent: "answer" });
});

test("deep_status and the owner's area choice: company only; other areas refused; Settings shows Foundry", async () => {
  const { services, deliver, run, ctx, owner } = await setup();
  await deliver("orders", ORDERS_P1, ["kind:table", "source:public.orders"]);
  await deliver("memo", "text", ["report"]);
  await services.deepSync?.run();
  const status = await run("deep_status", {}, ctx(ADA));
  assert.equal(status.enabled, true);
  assert.equal(status.model.state, "unset");
  assert.deepEqual(status.areas.map((a: any) => [a.area, a.synced, a.tables.map((t: any) => [t.name, t.rows]), a.documents]), [["company", true, [["orders", 2]], 1]]);
  await assert.rejects(run("deep_settings_set", { areas: [ADA_AREA] }, owner), rejects("deep_area_unsupported"));
  assert.deepEqual((await run("deep_settings_set", { areas: [], syncNow: false }, owner)).areas, []);
  assert.deepEqual((await run("deep_status", {}, ctx(ADA))).areas, [], "a paused feed: no Foundry area");
  assert.deepEqual((await run("deep_settings_set", { areas: ["company"], syncNow: false }, owner)).areas, ["company"]);
  const settings = await run("settings_overview", {}, owner);
  assert.equal(settings.deep.running, true);
  assert.deepEqual(settings.deep.allowedAreas, ["company"]);
  assert.deepEqual(settings.deep.areas[0].tables, [{ name: "orders", rows: 2, documents: 1 }]);
});

test("without Foundry: deep_status says off, the other deep tools answer deep_disabled", async () => {
  const { run, ctx } = await setup({ deep: false });
  assert.deepEqual(await run("deep_status", {}, ctx(ADA)), { enabled: false, areas: [] });
  await assert.rejects(run("deep_search", { query: "x" }, ctx(ADA)), rejects("deep_disabled"));
  await assert.rejects(run("deep_ask", { question: "Who is past due?" }, ctx(ADA)), rejects("deep_disabled"));
});
