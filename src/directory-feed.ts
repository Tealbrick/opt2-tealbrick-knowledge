// Governance directory copy (C373, C312.4, C322(5)). Knowledge reads Governance's `directory_feed` (product id `fleet`,
// contract fleet.directory_feed/1) through its companion grant OUTSIDE calls: at start, every 60 s from a timer, after an
// agent is added and when the owner opens the Access page with a copy older than 60 s. It NEVER reads it inside an agent
// call or a hook: agent calls read only the local copy (kn_directory). Pattern and refusal rules as in Rules' src/fleet.ts.
// Every answer is validated against the vendored schema (src/contracts, a byte copy, test/contracts/PROVENANCE.md) and
// every handle must be canonical (normalizeHandle(h) === h); a mismatch is a REFUSAL: nothing of the answer is read.
// Knowledge keeps no handle and no trust value (C88): only what decides memory access (see DirectoryModel).
// Fail closed: no Governance, a refusal (Governance before 0.3.0 answers `no_access`), or no good read for 10 minutes →
// the copy is unavailable and every agent has today's access only (own agent area + company area).
import { normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/spec/sdk";
import feedSchema from "./contracts/fleet.directory_feed.1.schema.json" with { type: "json" };

export const FLEET_PRODUCT = "fleet";
export const FEED_OP = "directory_feed";
export const REFRESH_MS = 60_000;
/** A copy with no good read for this long decides nothing (as Rules' FLEET_MAX_STALE_MS). */
export const MAX_STALE_MS = 10 * 60_000;
export const FEED_INVALID = "feed_invalid";

/** What Knowledge keeps of one answer: ids, flags and team names only. */
export interface DirectoryModel {
  /** contacts of kind `person` (outside agents are not people with a memory) */
  people: { id: string; active: boolean; teamReads: boolean }[];
  /** `owner` = an ACTIVE person (else null); `teamReads` false for a blocked or removed agent (no team reads) */
  agents: { id: string; owner: string | null; teamReads: boolean }[];
  teams: { id: string; name: string; agents: string[]; people: string[] }[];
}

export type DirectoryStatus = "ready" | "never" | "needs_update" | "not_connected" | "refused" | "unreachable";

export interface DirectoryState {
  /** true = the copy decides access now (a good read within MAX_STALE_MS and no refusal since) */
  available: boolean;
  status: DirectoryStatus;
  revision: number | null;
  syncedAt: number | null;
  checkedAt: number | null;
  errorCode: string | null;
  error: string | null;
  model: DirectoryModel | null;
}

/**
 * Refusals clear the copy at once: Governance is not there for Knowledge (no grant, not installed, Governance before 0.3.0
 * answers `no_access`) or its answer breaks the contract. Any other 4xx except 408/429 is a refusal too; everything else
 * (5xx, timeout, network, rate limit) is transient: the copy is kept while its last good read is ≤ MAX_STALE_MS old.
 */
const REFUSALS = new Set([FEED_INVALID, "no_access", "no_grant", "not_granted", "grant_missing", "grant_invalid", "grant_stale", "not_found", "unknown_product", "unknown_tool", "app_not_found", "unlicensed", "not_licensed", "forbidden", "scope_denied", "paused", "held"]);
const NOT_CONNECTED = new Set(["no_grant", "not_granted", "grant_missing", "grant_invalid", "grant_stale", "not_found", "unknown_product", "unknown_tool", "app_not_found", "companion_not_declared"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const codeOf = (e: unknown) => (isObj(e) && typeof e.code === "string" ? e.code : "error");

export function isRefusal(e: unknown): boolean {
  if (REFUSALS.has(codeOf(e))) return true;
  const status = isObj(e) && typeof e.httpStatus === "number" ? e.httpStatus : null;
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const feedInvalid = (why: string): Error => Object.assign(new Error(why.slice(0, 240)), { code: FEED_INVALID });

type Contact = { id: string; kind: string; status: string; trust: string; handles: string[] };
type Agent = { id: string; status: string; trust: string; owner: string | null };
type Team = { id: string; name?: string; members: { kind: string; id: string }[] };

export interface ParsedFeed {
  revision: number;
  unchanged: boolean;
  model: DirectoryModel | null;
}

/**
 * The model from one answer. Throws `feed_invalid` unless the answer passes the vendored schema, every handle is canonical
 * and no id is listed twice. Owner rule (Governance lead, C373): `agents[].owner` counts only when it names a contact of
 * kind `person` whose status is not `departed`. A blocked agent keeps its owner but reads no team; a blocked or departed
 * person's memberships give no team reads; a removed agent has no owner and no team.
 */
export function parseFeed(out: unknown): ParsedFeed {
  if (!isObj(out)) throw feedInvalid("directory_feed answered no object");
  const check = validateAgainstSchema(feedSchema as never, out as Json) as { ok: boolean; errors?: { path?: string; message?: string }[] };
  if (!check.ok) throw feedInvalid(`the answer does not fit fleet.directory_feed/1: ${(check.errors ?? []).slice(0, 3).map((e) => `${e.path || "/"} ${e.message ?? ""}`).join("; ")}`);
  const revision = out.revision as number;
  if (out.unchanged === true) return { revision, unchanged: true, model: null };
  const contacts = out.contacts as Contact[];
  const agents = out.agents as Agent[];
  const teams = out.teams as Team[];
  for (const c of contacts) for (const h of c.handles) if (normalizeHandle(h) !== h) throw feedInvalid("a handle is not canonical (normalizeHandle)");
  for (const [what, ids] of [["team", teams.map((t) => t.id)], ["contact", contacts.map((c) => c.id)], ["agent", agents.map((a) => a.id)]] as const) {
    if (new Set(ids).size !== ids.length) throw feedInvalid(`a ${what} id is listed twice`);
  }
  const people = contacts.filter((c) => c.kind === "person").map((c) => ({ id: c.id, active: c.status !== "departed", teamReads: c.status !== "departed" && c.trust !== "blocked" }));
  const activePeople = new Set(people.filter((p) => p.active).map((p) => p.id));
  return {
    revision,
    unchanged: false,
    model: {
      people,
      agents: agents.map((a) => ({ id: a.id, owner: a.status !== "removed" && a.owner !== null && activePeople.has(a.owner) ? a.owner : null, teamReads: a.status !== "removed" && a.trust !== "blocked" })),
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name ?? t.id,
        agents: [...new Set(t.members.filter((m) => m.kind === "agent").map((m) => m.id))],
        people: [...new Set(t.members.filter((m) => m.kind === "contact").map((m) => m.id))],
      })),
    },
  };
}

const parsed = new WeakMap<Db, { key: string; model: DirectoryModel | null }>();

function statusOf(code: string | null, available: boolean, everRead: boolean): DirectoryStatus {
  if (available) return "ready";
  if (code === "no_access") return "needs_update";
  if (code === FEED_INVALID) return "refused";
  if (code && NOT_CONNECTED.has(code)) return "not_connected";
  if (code) return isRefusal({ code }) ? "not_connected" : "unreachable";
  return everRead ? "unreachable" : "never";
}

/** The copy as it decides access now (a stale or refused copy is `available: false` with no model). */
export function directoryState(db: Db, now: number = Date.now()): DirectoryState {
  const row = db.prepare("SELECT revision, synced_at, checked_at, usable, model, error_code, error FROM kn_directory WHERE id = 1").get() ?? {};
  const syncedAt = row.synced_at == null ? null : Number(row.synced_at);
  const available = Number(row.usable) === 1 && syncedAt !== null && now - syncedAt <= MAX_STALE_MS && typeof row.model === "string";
  let model: DirectoryModel | null = null;
  if (available) {
    const key = `${row.revision}|${syncedAt}`;
    const cached = parsed.get(db);
    if (cached?.key === key) model = cached.model;
    else {
      try {
        model = JSON.parse(String(row.model)) as DirectoryModel;
      } catch {
        model = null;
      }
      parsed.set(db, { key, model });
    }
  }
  const errorCode = row.error_code == null ? null : String(row.error_code);
  return {
    available: available && model !== null,
    status: statusOf(errorCode, available && model !== null, syncedAt !== null),
    revision: row.revision == null ? null : Number(row.revision),
    syncedAt,
    checkedAt: row.checked_at == null ? null : Number(row.checked_at),
    errorCode,
    error: row.error == null ? null : String(row.error),
    model,
  };
}

export type CallApp = (product: string, op: string, input: Json) => Promise<{ status: "ok"; output: unknown } | { status: "held"; holdId: string }>;

const inflight = new WeakMap<Db, Promise<void>>();

/** One read of the feed (shared by concurrent callers). Never throws: errors are recorded, a refusal clears the copy. */
export function syncDirectory(db: Db, callApp: CallApp, now: () => number = Date.now): Promise<void> {
  const running = inflight.get(db);
  if (running) return running;
  const p = syncOnce(db, callApp, now)
    .catch(() => {
      // the net under syncOnce: never reject; fail closed
      try {
        db.prepare("UPDATE kn_directory SET usable = 0, model = NULL, error_code = 'error', error = 'directory sync failed' WHERE id = 1").run();
      } catch {
        // the database refuses the write: the copy ages out after MAX_STALE_MS
      }
    })
    .finally(() => inflight.delete(db));
  inflight.set(db, p);
  return p;
}

async function syncOnce(db: Db, callApp: CallApp, now: () => number): Promise<void> {
  const before = directoryState(db, now());
  try {
    const since = before.available && before.revision !== null ? before.revision : null;
    const res = await callApp(FLEET_PRODUCT, FEED_OP, since !== null ? { sinceRevision: since } : {});
    if (res.status !== "ok") throw Object.assign(new Error("Governance held the directory read"), { code: "held" });
    const d = parseFeed(res.output);
    // "unchanged" is valid only for the revision asked about; anything else is a broken answer, not a no-op
    if (d.unchanged && d.revision !== since) throw feedInvalid(`unchanged answered for revision ${d.revision}, asked ${since ?? "none"}`);
    const t = now();
    if (d.unchanged) db.prepare("UPDATE kn_directory SET synced_at = ?, checked_at = ?, error_code = NULL, error = NULL WHERE id = 1").run(t, t);
    else db.prepare("UPDATE kn_directory SET revision = ?, synced_at = ?, checked_at = ?, usable = 1, model = ?, error_code = NULL, error = NULL WHERE id = 1").run(d.revision, t, t, JSON.stringify(d.model));
  } catch (e) {
    const code = codeOf(e).slice(0, 64);
    const reason = (e instanceof Error ? e.message : "directory read failed").slice(0, 240);
    const t = now();
    const expired = before.syncedAt === null || t - before.syncedAt > MAX_STALE_MS;
    if (isRefusal(e) || expired) db.prepare("UPDATE kn_directory SET usable = 0, model = NULL, checked_at = ?, error_code = ?, error = ? WHERE id = 1").run(t, code, reason);
    else db.prepare("UPDATE kn_directory SET checked_at = ?, error_code = ?, error = ? WHERE id = 1").run(t, code, reason);
  }
}

/** Person ops (the Access page): read again when the copy is older than REFRESH_MS; bounded wait so the page stays quick. */
export async function refreshIfStale(db: Db, callApp: CallApp, waitMs = 3000, now: () => number = Date.now): Promise<void> {
  const st = directoryState(db, now());
  if (st.checkedAt !== null && now() - st.checkedAt < REFRESH_MS) return;
  await Promise.race([syncDirectory(db, callApp, now), new Promise((r) => setTimeout(r, waitMs).unref())]);
}

/** The 60 s timer (SDK C85 `callApp` outside op handlers). Returns a stop function. */
export function startDirectoryTimer(db: Db, callApp: CallApp, intervalMs = REFRESH_MS): () => void {
  void syncDirectory(db, callApp);
  const t = setInterval(() => void syncDirectory(db, callApp), intervalMs);
  t.unref();
  return () => clearInterval(t);
}
