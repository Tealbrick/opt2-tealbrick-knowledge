// C380 B6 (tb.access/1, Knowledge): the guard (a fire-on-bad and a quiet-on-good test per caller case), the list (kinds, paging,
// subject filter, notShown, digest, no content), the revoke (team grants only, digest check, audit row, areas untouched) and the
// conformance strip. The harness mirrors test/people.test.ts: no memory engine, four agents, a Governance stand-in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { conformanceManifest, GUARDED_OPS as STRIPPED } from "../conformance.strip.ts";
import { knowledgeDefinition } from "../src/app.ts";
import { syncDirectory } from "../src/directory-feed.ts";
import { personAreaId } from "../src/people.ts";
import { digestOf, GOVERNANCE_PRODUCT, GUARDED_OPS, TARGET } from "../src/tb-access.ts";
import { context, FakeScopes, memoryDb, TestError } from "./helpers.ts";

const ADA = "agt_01AAAAAAAAAAAAAAAAAAAAAAAA"; // owned by Anna
const BO = "agt_01BBBBBBBBBBBBBBBBBBBBBBBB"; // owned by Ben, Ben is in team sales
const CY = "agt_01CCCCCCCCCCCCCCCCCCCCCCCC"; // no owner
const DEX = "agt_01DDDDDDDDDDDDDDDDDDDDDDDD"; // owned by Ben, blocked
const ANNA = personAreaId("ct_anna");
const BEN = personAreaId("ct_ben");

function feed(revision = 7): Record<string, any> {
  return {
    v: 1,
    revision,
    teams: [
      { id: "team_sales", name: "Sales", members: [{ kind: "contact", id: "ct_ben" }, { kind: "agent", id: DEX }] },
      { id: "team_ops", name: "Ops", members: [{ kind: "contact", id: "ct_anna", role: "lead" }] },
    ],
    contacts: [
      { id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: ["slack:U012ABCDEF"] },
      { id: "ct_ben", kind: "person", status: "active", trust: "trusted", handles: [] },
    ],
    agents: [
      { id: ADA, status: "active", trust: "trusted", owner: "ct_anna" },
      { id: BO, status: "active", trust: "trusted", owner: "ct_ben" },
      { id: CY, status: "active", trust: "trusted", owner: null },
      { id: DEX, status: "active", trust: "blocked", owner: "ct_ben" },
    ],
  };
}

type Caller = { type: string; id: string; name: string; mode?: null; product?: string; listed?: boolean };
const OWNER: Caller = { type: "person", id: "per_01OWNER000000000000000000", name: "Owner", mode: null };
const fleet: Caller = { type: "app", id: "ins_01FLEET0000000000000000000", name: "Governance", product: GOVERNANCE_PRODUCT, listed: true };
const rejects = (code: string, status?: number) => (error: unknown) => error instanceof TestError && error.code === code && (status === undefined || error.httpStatus === status);

async function setup(answer: () => unknown = () => feed()) {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const { definition } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "gbrain" }, TestError, { drainIntervalMs: 0 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const state = { answer };
  const callApp = (async () => {
    const out = state.answer();
    if (out instanceof Error) throw out;
    return { status: "ok", output: out };
  }) as OpContext["callApp"];
  for (const [id, name] of [[ADA, "Ada"], [BO, "Bo"], [CY, "Cy"], [DEX, "Dex"]] as const) {
    await definition.events?.agentAdded?.({ id, name, mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp, statusChanged() {}, ownerLink: () => null });
    scopes.applyDefaults(id);
  }
  await syncDirectory(db, callApp as never);
  const ctx = (agent: string, extra: Partial<OpContext> = {}) => context(db, scopes, agent, { callApp, ...extra });
  const as = (caller: Caller) => ctx(ADA, { caller: caller as never });
  const run = async (name: string, input: Record<string, unknown>, c: OpContext, opts: { skipSchema?: boolean } = {}) => {
    const spec = definition.handlers[name];
    const handler = typeof spec === "function" ? spec : spec?.run;
    if (!handler) throw new Error(`no handler ${name}`);
    const declared = definition.manifest.operations.find((o) => o.id === name);
    // the SDK refuses a call that breaks the schema before any handler runs; `skipSchema` reaches the handler's own checks (defence in depth)
    if (declared?.input && !opts.skipSchema) assert.ok((validateInput({ ...declared, standard: false } as never, input as never) as { ok: boolean }).ok, `${name} input`);
    const output = (await handler(input as Json, (c.op ? c : { ...c, op: declared ? { ...declared, standard: false } : null }) as OpContext)) as Record<string, any>;
    if (declared?.output) {
      const checked = validateInput({ ...declared, standard: false, input: declared.output } as never, output as never) as { ok: boolean };
      assert.ok(checked.ok, `${name} output: ${JSON.stringify(checked)}`);
    }
    return output;
  };
  const list = (subjects: unknown[], extra: Record<string, unknown> = {}, caller: Caller = fleet, opts: { skipSchema?: boolean } = {}) => run("access_list", { v: 1, subjects, ...extra }, as(caller), opts);
  const revoke = (subject: unknown, items: unknown[], caller: Caller = fleet, extra: Record<string, unknown> = {}) => run("access_revoke", { v: 1, plan: "pln_01TEST", attempt: 1, subject, items, ...extra }, as(caller));
  const grant = (team: string, person: string, tags?: string[]) => run("access_grant_set", { team, person, ...(tags ? { tags } : {}) }, ctx(ADA, { caller: OWNER as never }));
  return { db, state, definition, ctx, run, list, revoke, grant, callApp };
}

const ids = (out: Record<string, any>) => out.items.map((i: { id: string }) => i.id);

test("manifest: access_list and access_revoke are the LAST two operations, agent audience, listing workflow, no standard op", async () => {
  const { definition } = await setup();
  const ops = definition.manifest.operations as unknown as Record<string, unknown>[];
  assert.deepEqual(ops.slice(-2).map((o) => o.id), ["access_list", "access_revoke"]);
  assert.deepEqual(ops.slice(-2).map((o) => [o.audience, o.listing, o.effect, o.idempotency, o.receipt]), [["agent", "workflow", "read", "none", false], ["agent", "workflow", "write", "required", true]]);
  assert.deepEqual(ops.slice(-2).map((o) => o.crud), [["read"], ["update"]]);
  assert.equal(ops.slice(-2).some((o) => "holdFamily" in o), false, "no holdFamily (design §3)");
  assert.deepEqual([...GUARDED_OPS], ["access_list", "access_revoke"]);
});

test("guard fire: every caller but a listed, verified `fleet` app is refused, on both ops, with the exact code and status", async () => {
  const { list, revoke, grant } = await setup();
  await grant("team_sales", "ct_anna");
  const cases: [string, Caller, string][] = [
    ["person", OWNER, "no_access"],
    ["agent", { type: "agent", id: ADA, name: "Ada", mode: null }, "no_access"],
    ["app of another product (Observer writes company memory, but not this)", { ...fleet, product: "observer" }, "no_access"],
    ["app named like Governance but another product", { ...fleet, name: "fleet", product: "rules" }, "no_access"],
    ["app with no verified product", { type: "app", id: fleet.id, name: "Governance", listed: true }, "caller_unverified"],
    ["app with an empty product", { ...fleet, product: "" }, "caller_unverified"],
    ["app with no `listed` flag (older SDK)", { type: "app", id: fleet.id, name: "Governance", product: "fleet" }, "caller_unverified"],
    ["fleet no longer listed", { ...fleet, listed: false }, "caller_unverified"],
  ];
  for (const [label, caller, code] of cases) {
    await assert.rejects(() => list([{ kind: "all" }], {}, caller), rejects(code, 403), `list: ${label}`);
    await assert.rejects(() => revoke({ kind: "person", id: "ct_anna" }, [{ id: "team_grant:x", digest: `sha256:${"0".repeat(64)}` }], caller), rejects(code, 403), `revoke: ${label}`);
  }
});

test("guard quiet: a listed fleet app is served on both ops", async () => {
  const { list, revoke } = await setup();
  assert.equal((await list([{ kind: "all" }])).v, 1);
  assert.equal((await revoke({ kind: "person", id: "ct_anna" }, [{ id: "team_grant:gone", digest: `sha256:${"0".repeat(64)}` }])).results[0].outcome, "already_gone");
});

test("list: an agent subject gets its own area and the person areas it reaches; level write for its owner, read for a team grant", async () => {
  const { list, grant } = await setup();
  const ada = await list([{ kind: "agent", id: ADA }]);
  assert.deepEqual(ids(ada), [`agent_area:${ADA}`, `person_area:${ADA}:${ANNA}`].sort());
  const byKind = Object.fromEntries(ada.items.map((i: { kind: string }) => [i.kind, i]));
  assert.equal(byKind.agent_area.resource, "agent-01aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(byKind.person_area.level, "write");
  assert.equal(byKind.person_area.resource, ANNA);
  assert.equal(byKind.person_area.revocable, false);
  await grant("team_sales", "ct_anna");
  const bo = await list([{ kind: "agent", id: BO }]);
  const reach = Object.fromEntries(bo.items.filter((i: { kind: string }) => i.kind === "person_area").map((i: { resource: string }) => [i.resource, i]));
  assert.equal(reach[BEN].level, "write");
  assert.equal(reach[ANNA].level, "read", "a grant is read only");
  const cy = await list([{ kind: "agent", id: CY }]);
  assert.deepEqual(ids(cy), [`agent_area:${CY}`], "an agent with no owner reaches no person area");
});

test("list: a person subject gets the team grants about them (revocable), and no content leaves", async () => {
  const { list, grant, run, ctx } = await setup();
  await run("remember", { text: "Anna's secret renewal terms" }, ctx(ADA));
  await grant("team_sales", "ct_anna", ["work"]);
  const out = await list([{ kind: "person", id: "ct_anna", handles: ["slack:U012ABCDEF"] }], { sweepId: "sw_1" });
  assert.equal(out.sweepId, "sw_1");
  assert.equal(out.items.length, 1);
  const [g] = out.items;
  assert.match(g.id, /^team_grant:[0-9a-f]{32}$/u);
  assert.equal(g.direction, "about");
  assert.equal(g.revocable, true);
  assert.equal(g.resource, ANNA);
  assert.deepEqual(g.subject, { kind: "person", id: "ct_anna" });
  assert.equal(g.label, "Team Sales may read this person's memory (some tags only)");
  const text = JSON.stringify(out);
  for (const secret of ["secret renewal", "slack:U012ABCDEF", "work"]) assert.equal(text.includes(secret), false, `nothing leaves: ${secret}`);
  assert.deepEqual(ids(await list([{ kind: "person", id: "ct_ben", handles: [] }])), [], "another person has no grant about them");
  assert.deepEqual(ids(await list([{ kind: "unlinked" }])), []);
});

test("list: notShown always names team memory, scope rows and held calls, so complete is false; no directory adds person_area", async () => {
  const s = await setup();
  const out = await s.list([{ kind: "agent", id: ADA }]);
  assert.deepEqual(out.notShown.map((n: { kind: string }) => n.kind), ["team_area", "scope_rows", "held_calls"]);
  assert.equal(out.complete, false);
  assert.equal(out.nextCursor, null);
  // no good directory read for 10 minutes: the copy is unavailable, and Knowledge says so instead of showing no person area
  const late = await s.run("access_list", { v: 1, subjects: [{ kind: "agent", id: ADA }] }, s.ctx(ADA, { caller: fleet as never }));
  assert.ok(late.items.some((i: { kind: string }) => i.kind === "person_area"));
  s.db.prepare("UPDATE kn_directory SET synced_at = ? WHERE id = 1").run(Date.now() - 11 * 60_000);
  const stale = await s.list([{ kind: "agent", id: ADA }]);
  assert.deepEqual(stale.notShown.map((n: { kind: string }) => n.kind), ["team_area", "scope_rows", "held_calls", "person_area"]);
  assert.deepEqual(ids(stale), [`agent_area:${ADA}`], "no person area is claimed without the directory");
});

test("sweep: `all` pages by cursor in id order, no repeats, no gaps; the last page has nextCursor null", async () => {
  const { list, grant } = await setup();
  await grant("team_sales", "ct_anna");
  await grant("team_ops", "ct_ben");
  const everything = (await list([{ kind: "all" }], { limit: 200 })).items.map((i: { id: string }) => i.id);
  assert.ok(everything.length >= 8);
  assert.deepEqual(everything, [...everything].sort());
  const got: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const out = await list([{ kind: "all" }], { limit: 3, ...(cursor ? { cursor } : {}) });
    assert.ok(out.items.length <= 3);
    got.push(...ids(out));
    cursor = out.nextCursor ?? undefined;
    pages++;
  } while (cursor && pages < 20);
  assert.deepEqual(got, everything);
  assert.equal(pages, Math.ceil(everything.length / 3));
});

test("digest: stable when only state or label changes; changes with subject, resource or level", async () => {
  const { list, grant, db } = await setup();
  await grant("team_sales", "ct_anna");
  const first = (await list([{ kind: "person", id: "ct_anna", handles: [] }])).items[0];
  // a tag limit and a renamed team change label text only
  await grant("team_sales", "ct_anna", ["work"]);
  const second = (await list([{ kind: "person", id: "ct_anna", handles: [] }])).items[0];
  assert.notEqual(first.label, second.label);
  assert.equal(first.digest, second.digest);
  assert.equal(TARGET, "knowledge");
  const base = { id: first.id, kind: "team_grant" as const, subject: first.subject, resource: first.resource, level: "read" as const };
  assert.equal(digestOf(base), first.digest);
  assert.notEqual(digestOf({ ...base, level: "write" }), first.digest);
  assert.notEqual(digestOf({ ...base, resource: personAreaId("ct_ben") }), first.digest);
  assert.notEqual(digestOf({ ...base, subject: { kind: "person", id: "ct_ben" } }), first.digest);
  assert.ok(db);
});

test("invalid calls: `all` must be alone, ids, limit and cursor are checked, with the exact code and status 400", async () => {
  const { list } = await setup();
  const bad: [unknown[], Record<string, unknown>, string][] = [
    [[{ kind: "all" }, { kind: "agent", id: ADA }], {}, "invalid_subjects"],
    [[{ kind: "agent", id: "not-an-agent" }], {}, "invalid_subjects"],
    [[{ kind: "person", id: "ct_anna" }], {}, "invalid_subjects"],
    [[{ kind: "all" }], { cursor: "AAAA" }, "bad_cursor"],
    [[{ kind: "all" }], { cursor: Buffer.from("document:x").toString("base64url") }, "bad_cursor"],
  ];
  for (const [subjects, extra, code] of bad) await assert.rejects(() => list(subjects, extra, fleet, { skipSchema: true }), rejects(code, 400), code);
  // the SDK refuses these before any handler runs: the same cases break the embedded schema, and so do the limits
  const { definition } = await setup();
  const op = definition.manifest.operations.find((o) => o.id === "access_list");
  for (const input of [{ v: 1, subjects: [] }, { v: 1, subjects: [{ kind: "all" }], limit: 0 }, { v: 1, subjects: [{ kind: "all" }], limit: 201 }, { v: 2, subjects: [{ kind: "all" }] }, { v: 1, subjects: [{ kind: "all" }, { kind: "agent", id: ADA }] }, { v: 1, subjects: [{ kind: "agent", id: "not-an-agent" }] }])
    assert.equal((validateInput({ ...op, standard: false } as never, input as never) as { ok: boolean }).ok, false, JSON.stringify(input));
});

test("revoke fire/quiet: a team grant ends, is audited with the plan, and the team's agents lose the person's area at once; areas are untouched", async () => {
  const { list, revoke, grant, run, ctx, db } = await setup();
  const annas = await run("remember", { text: "Anna's Acme LLC call notes" }, ctx(ADA));
  await grant("team_sales", "ct_anna");
  assert.deepEqual((await run("recall", { query: "call notes" }, ctx(BO))).results.map((r: Record<string, unknown>) => r.documentId), [annas.documentId]);
  const subject = { kind: "person", id: "ct_anna" };
  const item = (await list([{ kind: "person", id: "ct_anna", handles: [] }])).items[0];
  const out = await revoke(subject, [{ id: item.id, digest: item.digest }]);
  assert.equal(out.v, 1);
  assert.deepEqual(out.results, [{ id: item.id, outcome: "revoked" }]);
  assert.deepEqual((await run("recall", { query: "call notes" }, ctx(BO))).results, [], "closed on the next call");
  const log = db.prepare("SELECT action, actor, team_id, person_id FROM kn_access_log ORDER BY id DESC LIMIT 1").get();
  assert.equal(log?.action, "grant_removed");
  assert.equal(log?.team_id, "team_sales");
  assert.equal(log?.person_id, "ct_anna");
  assert.match(String(log?.actor), /^fleet plan pln_01TEST attempt 1$/u);
  // Anna's memory, her agent's area and the scope rows are untouched
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM kn_documents").get()?.n) >= 1, true);
  assert.deepEqual(ids(await list([{ kind: "agent", id: ADA }])), [`agent_area:${ADA}`, `person_area:${ADA}:${ANNA}`].sort());
  // the same call again (a lost answer, a retry): nothing happens twice
  assert.deepEqual((await revoke(subject, [{ id: item.id, digest: item.digest }])).results, [{ id: item.id, outcome: "already_gone" }]);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM kn_access_log WHERE action = 'grant_removed'").get()?.n), 1);
});

test("revoke: a wrong digest changes nothing; areas and unknown kinds are not revocable; a team grant needs a person subject", async () => {
  const { list, revoke, grant, db } = await setup();
  await grant("team_sales", "ct_anna");
  const subject = { kind: "person", id: "ct_anna" };
  const item = (await list([{ kind: "person", id: "ct_anna", handles: [] }])).items[0];
  const zero = `sha256:${"0".repeat(64)}`;
  assert.deepEqual((await revoke(subject, [{ id: item.id, digest: zero }])).results, [{ id: item.id, outcome: "changed", code: "digest_differs" }]);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM kn_team_grants").get()?.n), 1, "a changed item removes nothing");
  assert.deepEqual((await revoke({ kind: "agent", id: ADA }, [{ id: item.id, digest: item.digest }])).results, [{ id: item.id, outcome: "not_revocable", code: "wrong_subject" }]);
  assert.deepEqual((await revoke({ kind: "person", id: "ct_ben" }, [{ id: item.id, digest: item.digest }])).results[0]?.outcome, "already_gone", "a grant about another person is not this subject's");
  const mixed = await revoke(subject, [
    { id: `agent_area:${ADA}`, digest: zero },
    { id: `person_area:${ADA}:${ANNA}`, digest: zero },
    { id: "other:thing", digest: zero },
    { id: item.id, digest: item.digest },
  ]);
  assert.deepEqual(
    mixed.results.map((r: { outcome: string; code?: string }) => [r.outcome, r.code]),
    [["not_revocable", "areas_never_touched"], ["not_revocable", "areas_never_touched"], ["not_revocable", "unknown_kind"], ["revoked", undefined]],
  );
});

test("revoke works without a directory copy (removing only narrows) and with the schema's limit of 10 items", async () => {
  const { list, revoke, grant, db, definition } = await setup();
  await grant("team_sales", "ct_anna");
  const item = (await list([{ kind: "person", id: "ct_anna", handles: [] }])).items[0];
  db.prepare("UPDATE kn_directory SET usable = 0 WHERE id = 1").run();
  assert.equal((await list([{ kind: "person", id: "ct_anna", handles: [] }])).items.length, 1, "the grant is listed with no directory");
  assert.deepEqual((await revoke({ kind: "person", id: "ct_anna" }, [{ id: item.id, digest: item.digest }])).results, [{ id: item.id, outcome: "revoked" }]);
  const op = definition.manifest.operations.find((o) => o.id === "access_revoke");
  const eleven = Array.from({ length: 11 }, (_, n) => ({ id: `team_grant:${n}`, digest: `sha256:${"0".repeat(64)}` }));
  const checked = validateInput({ ...op, standard: false } as never, { v: 1, plan: "pln_x", attempt: 1, subject: { kind: "person", id: "p" }, items: eleven } as never) as { ok: boolean };
  assert.equal(checked.ok, false);
});

test("conformance strip: the suite's manifest is the shipped one minus the guarded ops; the shipped manifest is untouched", async () => {
  const { definition } = await setup();
  assert.deepEqual([...STRIPPED], [...GUARDED_OPS], "the strip list is the guard list");
  const served = conformanceManifest(definition.manifest);
  assert.deepEqual(served.operations.map((o) => o.id), definition.manifest.operations.filter((o) => !GUARDED_OPS.includes(o.id)).map((o) => o.id));
  assert.ok(definition.manifest.operations.some((o) => o.id === "access_list"));
  assert.equal(served.operations.length, definition.manifest.operations.length - 2);
});
