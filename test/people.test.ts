// C373 person and team memory (C312.4, C322(5)): the Governance directory copy decides which person and team areas an
// agent may use; the owner's team grants open another person's area; everything fails closed to today's access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { knowledgeDefinition } from "../src/app.ts";
import { Areas } from "../src/areas.ts";
import { directoryState, FEED_INVALID, MAX_STALE_MS, parseFeed, syncDirectory } from "../src/directory-feed.ts";
import { agentView, personAreaId, teamAreaId } from "../src/people.ts";
import { context, FakeScopes, memoryDb, TestError } from "./helpers.ts";

const ADA = "agt_01AAAAAAAAAAAAAAAAAAAAAAAA"; // owned by Anna
const BO = "agt_01BBBBBBBBBBBBBBBBBBBBBBBB"; // owned by Ben, Ben is in team sales
const CY = "agt_01CCCCCCCCCCCCCCCCCCCCCCCC"; // no owner
const DEX = "agt_01DDDDDDDDDDDDDDDDDDDDDDDD"; // owned by Ben, blocked
const ADA_AREA = "agent-01aaaaaaaaaaaaaaaaaaaaaaaa";
const CY_AREA = "agent-01cccccccccccccccccccccccc";
const ANNA = personAreaId("ct_anna");
const BEN = personAreaId("ct_ben");
const SALES = teamAreaId("team_sales");
const OPS = teamAreaId("team_ops");

/** A synthetic Acme LLC directory (fleet.directory_feed/1). */
function feed(revision = 7, patch: (f: Record<string, any>) => void = () => undefined): Record<string, any> {
  const f: Record<string, any> = {
    v: 1,
    revision,
    teams: [
      { id: "team_sales", name: "Sales", members: [{ kind: "contact", id: "ct_ben" }, { kind: "agent", id: DEX }] },
      { id: "team_ops", name: "Ops", members: [{ kind: "contact", id: "ct_anna", role: "lead" }] },
    ],
    contacts: [
      { id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: ["slack:U012ABCDEF"] },
      { id: "ct_ben", kind: "person", status: "active", trust: "trusted", handles: [] },
      { id: "ct_bot", kind: "outside_agent", status: "active", trust: "unreviewed", handles: [] },
    ],
    agents: [
      { id: ADA, status: "active", trust: "trusted", owner: "ct_anna" },
      { id: BO, status: "active", trust: "trusted", owner: "ct_ben" },
      { id: CY, status: "active", trust: "trusted", owner: null },
      { id: DEX, status: "active", trust: "blocked", owner: "ct_ben" },
    ],
  };
  patch(f);
  return f;
}

const OWNER = { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } as const;
const rejects = (code: string) => (error: unknown) => error instanceof TestError && error.code === code;

/** Knowledge with no memory engine (keyword recall), four agents, and a Governance stand-in answering `answer()`. */
async function setup(answer: () => unknown = () => feed()) {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const { definition, knowledge } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "gbrain" }, TestError, { drainIntervalMs: 0 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const governance = { calls: [] as Json[], answer };
  const callApp = (async (product: string, op: string, input: Json) => {
    assert.equal(product, "fleet");
    assert.equal(op, "directory_feed");
    governance.calls.push(input);
    const out = governance.answer();
    if (out instanceof Error) throw out;
    return { status: "ok", output: out };
  }) as OpContext["callApp"];
  for (const [id, name] of [[ADA, "Ada"], [BO, "Bo"], [CY, "Cy"], [DEX, "Dex"]] as const) {
    await definition.events?.agentAdded?.({ id, name, mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp, statusChanged() {}, ownerLink: () => null });
    scopes.applyDefaults(id);
  }
  await syncDirectory(db, callApp as never);
  const ctx = (agent: string, extra: Partial<OpContext> = {}) => context(db, scopes, agent, { callApp, ...extra });
  const owner = (extra: Partial<OpContext> = {}) => ctx(ADA, { caller: OWNER, ...extra });
  const run = async (name: string, input: Record<string, unknown>, c: OpContext) => {
    const spec = definition.handlers[name];
    const handler = typeof spec === "function" ? spec : spec?.run;
    if (!handler) throw new Error(`no handler ${name}`);
    const declared = definition.manifest.operations.find((o) => o.id === name);
    if (declared?.input) assert.ok((validateInput({ ...declared, standard: false } as never, input as never) as { ok: boolean }).ok, `${name} input`);
    const output = (await handler(input as Json, (c.op ? c : { ...c, op: declared ? { ...declared, standard: false } : null }) as OpContext)) as Record<string, any>;
    if (declared?.output) {
      const checked = validateInput({ ...declared, standard: false, input: declared.output } as never, output as never) as { ok: boolean };
      assert.ok(checked.ok, `${name} output: ${JSON.stringify(checked)}`);
    }
    return output;
  };
  const recallIds = async (agent: string, query: string, extra: Partial<OpContext> = {}) => (await run("recall", { query }, ctx(agent, extra))).results.map((r: Record<string, unknown>) => r.documentId).sort();
  return { db, scopes, definition, knowledge, governance, callApp, ctx, owner, run, recallIds };
}

const sha = (path: string) => createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");

test("C373 contract: the vendored fleet.directory_feed/1 files match PROVENANCE.md; the fixtures read as the contract says", () => {
  const schema = "18d49f48f1196af77223acb38ea9b95f5786c587019b4688cd9417f5708df724";
  assert.equal(sha("./contracts/fleet.directory_feed.1.schema.json"), schema);
  assert.equal(sha("../src/contracts/fleet.directory_feed.1.schema.json"), schema, "the runtime copy is the same bytes");
  assert.equal(sha("./contracts/fleet.directory_feed.1.json"), "339d4b8c9377b0c035fd8937518565aac368bc4a3e8a3bb468559aedc7b4db71");
  const fixtures = JSON.parse(readFileSync(new URL("./contracts/fleet.directory_feed.1.json", import.meta.url), "utf8")) as Record<string, unknown[]>;
  for (const doc of fixtures.valid ?? []) assert.doesNotThrow(() => parseFeed(doc));
  for (const doc of [...(fixtures.invalid ?? []), ...(fixtures.invalidByNormalizeHandle ?? [])]) assert.throws(() => parseFeed(doc), (e: unknown) => (e as { code?: string }).code === FEED_INVALID);
});

test("C373 feed: Knowledge keeps ids and flags only (no handle, no trust); owner = an active person; blocked agent reads no team", () => {
  const parsed = parseFeed(
    feed(3, (f) => {
      f.contacts.push({ id: "ct_gone", kind: "person", status: "departed", trust: "trusted", handles: [] });
      f.agents.push({ id: "agt_01EEEEEEEEEEEEEEEEEEEEEEEE", status: "active", trust: "trusted", owner: "ct_gone" });
      f.agents.push({ id: "agt_01FFFFFFFFFFFFFFFFFFFFFFFF", status: "active", trust: "trusted", owner: "ct_bot" });
    }),
  );
  const text = JSON.stringify(parsed.model);
  assert.doesNotMatch(text, /slack:|trusted|unreviewed|blocked/u, "no handle and no trust value is kept (C88)");
  const owner = (id: string) => parsed.model?.agents.find((a) => a.id === id)?.owner;
  assert.equal(owner(ADA), "ct_anna");
  assert.equal(owner("agt_01EEEEEEEEEEEEEEEEEEEEEEEE"), null, "a departed person owns nothing");
  assert.equal(owner("agt_01FFFFFFFFFFFFFFFFFFFFFFFF"), null, "an outside agent is not an owner");
  assert.deepEqual(agentView(parsed.model, [], DEX).teams, [], "a blocked agent keeps its owner but reads no team");
  assert.equal(agentView(parsed.model, [], DEX).owner, "ct_ben");
  assert.deepEqual(agentView(parsed.model, [], BO).teams, ["team_sales"], "the owner's team counts for the agent");
});

test("C373: an agent's writes default to its owner's person area; the owner's other agents share it; recall finds it", async () => {
  const { run, ctx, recallIds } = await setup();
  const saved = await run("remember", { text: "Anna prefers the Acme LLC renewal in March" }, ctx(ADA));
  assert.equal(saved.area, ANNA, "the default write area is the owner's person area");
  const list = await run("areas_list", {}, ctx(ADA));
  assert.equal(list.defaultArea, ANNA);
  assert.equal(list.directory, "owner_known");
  const byId = new Map(list.areas.map((a: Record<string, unknown>) => [a.id, a]));
  assert.deepEqual([...byId.keys()].sort(), [ADA_AREA, "company", ANNA, OPS].sort(), "own agent area, person area, own team, company");
  assert.equal((byId.get(ANNA) as Record<string, unknown>).access, "read_write");
  assert.equal((byId.get(OPS) as Record<string, unknown>).access, "read", "team memory is read only");
  assert.equal((byId.get(ADA_AREA) as Record<string, unknown>).access, "read_write", "the own agent area stays");
  assert.deepEqual(await recallIds(ADA, "renewal"), [saved.documentId]);
  // an explicit write to the own agent area still works
  assert.equal((await run("remember", { text: "scratch note", area: ADA_AREA }, ctx(ADA))).area, ADA_AREA);
});

test("C373: owner A's agent cannot read or write person B's area (absent from recall, not_found, scope_denied on team areas)", async () => {
  const { run, ctx, recallIds } = await setup();
  const bens = await run("remember", { text: "Ben's private pricing idea for Acme LLC" }, ctx(BO));
  assert.equal(bens.area, BEN);
  assert.deepEqual(await recallIds(ADA, "pricing"), [], "absent from recall");
  assert.equal((await run("search", { query: "pricing" }, ctx(ADA))).results.length, 0);
  assert.equal((await run("documents_search", { query: "pricing" }, ctx(ADA))).hits.length, 0);
  await assert.rejects(run("document_get", { id: bens.documentId }, ctx(ADA)), rejects("not_found"));
  await assert.rejects(run("get", { ref: { kind: "document", id: bens.documentId } }, ctx(ADA)), rejects("not_found"));
  await assert.rejects(run("recall", { query: "pricing", area: BEN }, ctx(ADA)), rejects("not_found"));
  await assert.rejects(run("remember", { text: "intrusion", area: BEN }, ctx(ADA)), rejects("not_found"));
  await assert.rejects(run("collections_list", { area: BEN }, ctx(ADA)), rejects("not_found"));
  await assert.rejects(run("remember", { text: "team write", area: OPS }, ctx(ADA)), rejects("scope_denied"), "a team area is read only for members");
  await assert.rejects(run("recall", { query: "x", area: SALES }, ctx(ADA)), rejects("not_found"), "a team it is not in");
  // the SDK pre-check: a governed area id never reaches the SDK scope store (it has no row there)
  const spec = (await setup()).definition.handlers.remember as { scope?: (input: unknown, caller: unknown) => unknown };
  assert.equal(spec.scope?.({ area: BEN }, ctx(ADA).caller), null);
  assert.equal(spec.scope?.({ area: "company" }, ctx(ADA).caller), "company");
});

test("C373: team members' agents read the team area; the owner writes it from the Library; non-members and a blocked agent do not", async () => {
  const { run, owner, recallIds } = await setup();
  const doc = await run("library_document_create", { area: SALES, title: "Sales playbook", body: "Acme LLC discount ladder", status: "published" }, owner());
  assert.deepEqual(await recallIds(BO, "ladder"), [doc.id], "Ben's agent reads Sales through its owner");
  assert.deepEqual(await recallIds(ADA, "ladder"), [], "Anna is not in Sales");
  assert.deepEqual(await recallIds(DEX, "ladder"), [], "a blocked agent reads no team even as a member");
  assert.deepEqual(await recallIds(CY, "ladder"), [], "no owner, no team");
});

test("C373: a team grant opens person A's area to that team's agents (read only); revoking closes it; it is audited", async () => {
  const { run, ctx, owner, recallIds } = await setup();
  const annas = await run("remember", { text: "Anna's Acme LLC call notes" }, ctx(ADA));
  assert.deepEqual(await recallIds(BO, "call notes"), []);
  const set = await run("access_grant_set", { team: "team_sales", person: "ct_anna" }, owner());
  assert.deepEqual(set, { team: "team_sales", person: "ct_anna", tags: null, changed: true });
  assert.deepEqual(await recallIds(BO, "call notes"), [annas.documentId], "Sales (Ben) now reads Anna");
  assert.equal((await run("document_get", { id: annas.documentId }, ctx(BO))).id, annas.documentId);
  const area = (await run("areas_list", {}, ctx(BO))).areas.find((a: Record<string, unknown>) => a.id === ANNA);
  assert.equal(area.access, "read");
  assert.equal(area.via, "grant");
  await assert.rejects(run("remember", { text: "edit", area: ANNA }, ctx(BO)), rejects("scope_denied"), "a grant is read only");
  await assert.rejects(run("document_update", { id: annas.documentId, body: "x" }, ctx(BO)), rejects("scope_denied"));
  assert.deepEqual(await recallIds(CY, "call notes"), [], "only the granted team");
  assert.deepEqual(await recallIds(DEX, "call notes"), [], "a blocked member gets no team grant");
  const removed = await run("access_grant_remove", { team: "team_sales", person: "ct_anna" }, owner());
  assert.equal(removed.removed, true);
  assert.deepEqual(await recallIds(BO, "call notes"), [], "revoked: closed on the next call");
  await assert.rejects(run("document_get", { id: annas.documentId }, ctx(BO)), rejects("not_found"));
  const overview = await run("access_overview", {}, owner());
  assert.deepEqual(
    overview.log.map((l: Record<string, unknown>) => l.action),
    ["grant_removed", "grant_added"],
  );
});

test("C373: a tag-limited grant returns only memories with one of the tags; other reads of that area answer not_found", async () => {
  const { run, ctx, owner, recallIds } = await setup();
  const work = await run("remember", { text: "Acme LLC quarterly target", tags: ["work"] }, ctx(ADA));
  const personal = await run("remember", { text: "Acme LLC quarterly dentist", tags: ["personal"] }, ctx(ADA));
  await run("access_grant_set", { team: "team_sales", person: "ct_anna", tags: ["Work"] }, owner());
  assert.deepEqual(await recallIds(BO, "quarterly"), [work.documentId], "tags compare normalised");
  assert.deepEqual((await run("documents_search", { query: "quarterly" }, ctx(BO))).hits.map((h: Record<string, unknown>) => h.id), [work.documentId]);
  await assert.rejects(run("document_get", { id: personal.documentId }, ctx(BO)), rejects("not_found"));
  assert.equal((await run("document_get", { id: work.documentId }, ctx(BO))).id, work.documentId);
  await assert.rejects(run("collections_list", { area: ANNA }, ctx(BO)), rejects("not_found"), "an op that cannot filter items refuses the limited area");
  const area = (await run("areas_list", {}, ctx(BO))).areas.find((a: Record<string, unknown>) => a.id === ANNA);
  assert.deepEqual(area.onlyTags, ["work"]);
  // the owner's own agents still read everything of their own person area
  assert.deepEqual(await recallIds(ADA, "quarterly"), [work.documentId, personal.documentId].sort());
});

test("C373: Rules narrowing still applies on top of person and team access", async () => {
  const { run, ctx, recallIds } = await setup();
  const work = await run("remember", { text: "Acme LLC heron plan", tags: ["work"] }, ctx(ADA));
  await run("remember", { text: "Acme LLC heron holiday", tags: ["personal"] }, ctx(ADA));
  const narrowing = { "rules.narrowing": { v: 1, ruleId: "rul_01TESTRULE0000000000000000", memoryTags: { anyOf: ["work"] } } } as Record<string, Json>;
  assert.deepEqual(await recallIds(ADA, "heron", { context: narrowing }), [work.documentId]);
  await assert.rejects(run("remember", { text: "personal again", tags: ["personal"] }, ctx(ADA, { context: narrowing })), rejects("narrowing_violation"));
});

test("C373 fail closed: no Governance answer → today's access (own agent area + company), and the Access page says why", async () => {
  const noAccess = Object.assign(new Error("directory_feed is for the Rules app only"), { code: "no_access", httpStatus: 403 });
  const { run, ctx, owner, recallIds, governance, db, callApp } = await setup();
  const annas = await run("remember", { text: "Anna's renewal memo" }, ctx(ADA));
  assert.equal(annas.area, ANNA);
  governance.answer = () => noAccess; // Governance before 0.3.0
  await syncDirectory(db, callApp as never);
  assert.equal(directoryState(db).status, "needs_update");
  const saved = await run("remember", { text: "while Governance refuses" }, ctx(ADA));
  assert.equal(saved.area, ADA_AREA, "writes fall back to the own agent area");
  const list = await run("areas_list", {}, ctx(ADA));
  assert.deepEqual(list.areas.map((a: Record<string, unknown>) => a.id).sort(), [ADA_AREA, "company"].sort());
  assert.equal(list.directory, "unavailable");
  assert.deepEqual(await recallIds(ADA, "renewal memo"), [], "the person area is closed too (fail closed)");
  await assert.rejects(run("access_grant_set", { team: "team_sales", person: "ct_anna" }, owner()), rejects("directory_unavailable"));
  const overview = await run("access_overview", {}, owner());
  assert.equal(overview.directory.status, "needs_update");
  assert.match(overview.directory.note, /Update Governance to 0\.3\.0/u);
  assert.deepEqual(overview.people, []);
});

test("C373 fail closed: Governance not installed, never read, or a broken answer; an agent with no owner keeps today's behaviour", async () => {
  const notInstalled = Object.assign(new Error("no companion grant"), { code: "no_grant", httpStatus: 403 });
  const { run, ctx, db, governance, callApp } = await setup(() => notInstalled);
  assert.equal(directoryState(db).status, "not_connected");
  assert.equal((await run("remember", { text: "x" }, ctx(ADA))).area, ADA_AREA);
  governance.answer = () => ({ v: 1, revision: 1, teams: [], contacts: [{ id: "ct_x", kind: "person", status: "active", trust: "trusted", handles: ["buzz:not-a-key"] }], agents: [] });
  await syncDirectory(db, callApp as never);
  assert.equal(directoryState(db).status, "refused", "a broken answer is a refusal, never a partial read");
  governance.answer = () => feed();
  await syncDirectory(db, callApp as never);
  assert.equal(directoryState(db).status, "ready");
  const cy = await run("remember", { text: "Cy's note" }, ctx(CY));
  assert.equal(cy.area, CY_AREA, "no owner: today's own agent area");
  const list = await run("areas_list", {}, ctx(CY));
  assert.equal(list.directory, "no_owner");
  assert.deepEqual(list.areas.map((a: Record<string, unknown>) => a.id).sort(), [CY_AREA, "company"].sort());
});

test("C373 feed polling: sinceRevision + unchanged; a transient failure keeps the copy for 10 minutes, then fails closed", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const db = memoryDb();
  const calls: Json[] = [];
  let answer: () => unknown = () => feed(5);
  const callApp = async (_p: string, _o: string, input: Json) => {
    calls.push(input);
    const out = answer();
    if (out instanceof Error) throw out;
    return { status: "ok" as const, output: out };
  };
  await syncDirectory(db, callApp, clock);
  assert.deepEqual(calls, [{}]);
  answer = () => ({ v: 1, revision: 5, unchanged: true });
  now += 60_000;
  await syncDirectory(db, callApp, clock);
  assert.deepEqual(calls[1], { sinceRevision: 5 });
  assert.equal(directoryState(db, now).available, true);
  answer = () => ({ v: 1, revision: 4, unchanged: true });
  await syncDirectory(db, callApp, clock);
  assert.equal(directoryState(db, now).status, "refused", "unchanged for another revision is a broken answer");
  answer = () => feed(6);
  await syncDirectory(db, callApp, clock);
  answer = () => Object.assign(new Error("timeout"), { code: "timeout", httpStatus: 504 });
  now += 5 * 60_000;
  await syncDirectory(db, callApp, clock);
  assert.equal(directoryState(db, now).available, true, "a transient failure keeps the last copy");
  now += MAX_STALE_MS;
  assert.equal(directoryState(db, now).available, false, "no good read for 10 minutes: the copy decides nothing");
  assert.equal(directoryState(db, now).status, "unreachable");
});

test("C373 never in a call: agent ops read only the local copy (no Governance call); the owner's Access page lists people and teams without handles or trust", async () => {
  const { run, ctx, owner, governance } = await setup();
  const before = governance.calls.length;
  await run("remember", { text: "a" }, ctx(ADA));
  await run("recall", { query: "a" }, ctx(BO));
  await run("areas_list", {}, ctx(CY));
  assert.equal(governance.calls.length, before, "no directory read inside an agent call");
  const overview = await run("access_overview", {}, owner());
  assert.equal(overview.directory.status, "ready");
  assert.deepEqual(overview.people.map((p: Record<string, unknown>) => p.id).sort(), ["ct_anna", "ct_ben"], "outside agents are not people");
  const anna = overview.people.find((p: Record<string, unknown>) => p.id === "ct_anna");
  assert.deepEqual(anna.agents, [{ id: ADA, name: "Ada" }]);
  assert.equal(anna.area, ANNA);
  assert.deepEqual(overview.teams.find((t: Record<string, unknown>) => t.id === "team_sales").agents, [{ id: DEX, name: "Dex" }]);
  assert.deepEqual(overview.agentsWithoutOwner, [{ id: CY, name: "Cy" }]);
  assert.doesNotMatch(JSON.stringify(overview), /slack:|buzz:|"trust"|trusted|blocked/u, "no handle, no trust value (C88)");
  await assert.rejects(run("access_grant_set", { team: "team_nope", person: "ct_anna" }, owner()), rejects("team_unknown"));
  await assert.rejects(run("access_grant_set", { team: "team_sales", person: "ct_bot" }, owner()), rejects("person_unknown"), "an outside agent has no memory to share");
});

test("C373: a companion app caller gets no person or team area (not listed, not writable)", async () => {
  const { run, ctx } = await setup();
  await run("remember", { text: "Anna's secret Acme LLC memo" }, ctx(ADA));
  const app = ctx(ADA, { caller: { type: "app", id: "ins_01APPAPPAPPAPPAPPAPPAPPAPP" as `ins_${string}`, name: "Observer", mode: null, product: "observer" as never } });
  const listed = await run("areas_list", {}, app);
  assert.ok(!listed.areas.some((a: Record<string, unknown>) => String(a.id).startsWith("person-") || String(a.id).startsWith("team-")));
  await assert.rejects(run("document_create", { title: "intrusion", area: ANNA }, app), rejects("not_found"));
  await assert.rejects(run("document_create", { title: "intrusion", area: SALES }, app), rejects("not_found"));
});

test("C373 migration 0003: existing areas, documents and foreign keys survive; person and team kinds are stored and constrained", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("0003_people.sql"));
  const apply = (file: string) => {
    raw.exec("BEGIN");
    raw.exec(readFileSync(new URL(file, dir), "utf8"));
    raw.exec("COMMIT");
  };
  for (const f of files.filter((f) => f < "0003")) apply(f);
  raw.exec("INSERT INTO kn_areas (id, kind, label, agent_id, source_id, created_at) VALUES ('company', 'shared', 'Company', NULL, 'ka-1', 1), ('agent-x', 'agent', 'X', 'agt_x', 'ka-2', 1)");
  raw.exec("INSERT INTO kn_collections (id, area_id, name, is_default, created_by, created_at, updated_at) VALUES ('kcol_1', 'agent-x', 'Main', 1, 'a', 1, 1)");
  raw.exec("INSERT INTO kn_documents (id, area_id, collection_id, title, slug, created_by, updated_by, created_at, updated_at) VALUES ('kdoc_1', 'agent-x', 'kcol_1', 'T', 't', 'a', 'a', 1, 1)");
  for (const f of files.filter((f) => f >= "0003")) apply(f);
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const st = raw.prepare(sql);
      return { run: (...p: unknown[]) => st.run(...(p as never[])) as never, get: (...p: unknown[]) => st.get(...(p as never[])) as never, all: (...p: unknown[]) => st.all(...(p as never[])) as never };
    },
    transaction: <T>(fn: () => T) => fn(),
  };
  const areas = new Areas(db);
  assert.deepEqual(areas.list().map((a) => [a.id, a.kind, a.subjectId]).sort(), [["agent-x", "agent", null], ["company", "shared", null]]);
  areas.ensureSubject("person", ANNA, "ct_anna", "Person ct_anna (personal memory)");
  areas.ensureSubject("team", SALES, "team_sales", "Sales (team memory)");
  assert.equal(areas.get(ANNA)?.kind, "person");
  assert.equal(areas.get(SALES)?.kind, "team");
  assert.equal(areas.get(SALES)?.subjectId, "team_sales");
  assert.throws(() => raw.exec("INSERT INTO kn_areas (id, kind, label, agent_id, subject_kind, subject_id, source_id, created_at) VALUES ('p2', 'agent', 'x', 'agt_y', 'person', 'c', 'ka-9', 1)"), /CHECK/u);
  assert.throws(() => raw.exec("INSERT INTO kn_areas (id, kind, label, subject_kind, source_id, created_at) VALUES ('p3', 'shared', 'x', 'team', 'ka-8', 1)"), /CHECK/u);
  assert.throws(() => raw.exec("INSERT INTO kn_collections (id, area_id, name, is_default, created_by, created_at, updated_at) VALUES ('kcol_2', 'nope', 'M', 0, 'a', 1, 1)"), /FOREIGN KEY/u);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM kn_documents").get()?.n, 1);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  raw.exec("INSERT INTO kn_access_log (at, actor, action, team_id, person_id) VALUES (1, 'per_x', 'grant_added', 't', 'p')");
  assert.throws(() => raw.exec("DELETE FROM kn_access_log"), /append-only/u);
});
