// C380 `tb.access/1` (docs/ACCESS.md in specs): the two ops Governance (product id `fleet`) calls to see and, for one kind, to end
// what each agent or person holds in Knowledge. (`src/access.ts` is the owner's Access page; this file is the machine contract.)
//   agent_area   the agent's own memory area            held_by, write, kept (never revoked: areas are never touched)
//   person_area  a person's area an agent reaches        held_by, write (its owner) or read (an owner grant); follows the directory
//   team_grant   "team T may read person P's memory"     about,  read,  REVOCABLE: the logic of `access_grant_remove` + kn_access_log
// notShown: team memory read by membership, SDK scope rows (company and other areas), calls on hold. Nothing here deletes a
// document, an area or a scope row. Labels are fixed words (plus a clipped team name); no memory content ever leaves (C88).
import { createHash } from "node:crypto";
import { canonicalize } from "@opt2-tealbrick/manifest";
import type { Db, HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import type { Areas } from "./areas.ts";
import { type DirectoryModel, directoryState } from "./directory-feed.ts";
import { agentAreaId } from "./ids.ts";
import { agentView, listGrants, personAreaId, removeGrant, type TeamGrant } from "./people.ts";

export const TARGET = "knowledge";
/** The only app that may call these ops: the verified product of the caller, never its name. */
export const GOVERNANCE_PRODUCT = "fleet";
export const ACCESS_LIST = "access_list";
export const ACCESS_REVOKE = "access_revoke";
/** Guarded ops, appended last in the manifest. The conformance harness serves the manifest without them (conformance.strip.ts). */
export const GUARDED_OPS: readonly string[] = [ACCESS_LIST, ACCESS_REVOKE];
export const MAX_SUBJECTS = 32;
export const MAX_HANDLES = 16;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
export const MAX_REVOKE_ITEMS = 10;

export type ErrorFactory = (code: string, message: string, status: number) => Error;
type In = Record<string, any>;

export type Subject = { kind: "agent"; id: string } | { kind: "person"; id: string; handles: string[] } | { kind: "unlinked" } | { kind: "all" };
type ItemKind = "agent_area" | "person_area" | "team_grant";

export interface AccessItem {
  id: string;
  kind: ItemKind;
  subject: { kind: "agent" | "person"; id: string };
  resource: string;
  direction: "held_by" | "about";
  level: "read" | "write";
  label: string;
  state: "active";
  revocable: boolean;
  digest: string;
}

const STATIC_NOT_SHOWN: readonly { kind: string; reason: string }[] = [
  { kind: "team_area", reason: "Team memory that an agent reads because it, or its owner, is in the team follows the Governance directory. It is not listed here." },
  { kind: "scope_rows", reason: "Which areas an agent may read or change, including the company area, is set by Portal grants, not by Knowledge." },
  { kind: "held_calls", reason: "Calls waiting for an owner decision are kept by the Portal, not by Knowledge." },
];
const DIRECTORY_NOT_SHOWN = { kind: "person_area", reason: "Knowledge has no current copy of the Governance directory, so it cannot say which people's memory an agent reaches." } as const;

/**
 * Who may call the access ops. Fail closed. The same six caller cases are in the spec fixture (caller vector).
 *   person, agent               -> no_access          (only an app may ask)
 *   app, product is not `fleet` -> no_access          (a name is not an identity: only the VERIFIED product counts)
 *   app, no verified product    -> caller_unverified
 *   app, `listed` missing       -> caller_unverified  (older SDK or no signed slice: unknown fails closed)
 *   app, `listed` false         -> caller_unverified  (the companion edge was removed or the slice expired)
 *   app, fleet, listed true     -> allowed
 */
export function guardCaller(ctx: Pick<OpContext, "caller">, fail: ErrorFactory): void {
  const c = ctx.caller as { type?: unknown; product?: unknown; listed?: unknown };
  if (c.type !== "app") throw fail("no_access", "Only the Governance app may call this operation.", 403);
  if (typeof c.product !== "string" || c.product === "") throw fail("caller_unverified", "The calling app has no verified product.", 403);
  if (c.product !== GOVERNANCE_PRODUCT) throw fail("no_access", "Only the Governance app may call this operation.", 403);
  if (typeof c.listed !== "boolean") throw fail("caller_unverified", "The calling app is not confirmed by the signed workspace slice.", 403);
  if (!c.listed) throw fail("caller_unverified", "The calling app is no longer listed in this workspace.", 403);
}

/** Item digest: sha256 of the JCS of {v, target, id, kind, subject, resource, level}. NOT state, since, label, revocable, direction. */
export function digestOf(item: Pick<AccessItem, "id" | "kind" | "subject" | "resource" | "level">, target: string = TARGET): string {
  const body = { v: 1, target, id: item.id, kind: item.kind, subject: item.subject, resource: item.resource, level: item.level };
  return `sha256:${createHash("sha256").update(canonicalize(body as never)).digest("hex")}`;
}

const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/u;
const grantOpaque = (team: string, person: string) => createHash("sha256").update(`team_grant\0${team}\0${person}`).digest("hex").slice(0, 32);
const grantItemId = (g: Pick<TeamGrant, "team" | "person">) => `team_grant:${grantOpaque(g.team, g.person)}`;

/** Printable text only, clipped: a team name is Governance's text, never an instruction (C88). */
const plain = (s: string, max: number) => s.replace(/[^\p{L}\p{N} .,'()&_/-]/gu, "").trim().slice(0, max);

const encodeCursor = (id: string) => Buffer.from(id, "utf8").toString("base64url");
function decodeCursor(c: unknown, fail: ErrorFactory): string | null {
  if (c === undefined) return null;
  const id = typeof c === "string" && /^[A-Za-z0-9_-]{1,512}$/u.test(c) ? Buffer.from(c, "base64url").toString("utf8") : "";
  if (!/^(agent_area|person_area|team_grant):[A-Za-z0-9_:-]{1,110}$/u.test(id)) throw fail("bad_cursor", "The cursor is not one this app gave.", 400);
  return id;
}

interface Wanted {
  /** null = sweep: every agent and every grant */
  agents: Set<string> | null;
  persons: Set<string> | null;
}

/** Refuses a malformed subject list; splits it into the agent ids and person ids the call asks about. */
export function wanted(subjects: unknown, fail: ErrorFactory): Wanted {
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > MAX_SUBJECTS) throw fail("invalid_subjects", `subjects needs 1 to ${MAX_SUBJECTS} entries.`, 400);
  const list = subjects as Subject[];
  if (list.some((s) => s.kind === "all")) {
    if (list.length !== 1) throw fail("invalid_subjects", "The subject `all` must be the only subject.", 400);
    return { agents: null, persons: null };
  }
  const agents = new Set<string>();
  const persons = new Set<string>();
  for (const s of list) {
    if (s.kind === "agent") {
      if (typeof s.id !== "string" || !AGENT_ID.test(s.id)) throw fail("invalid_subjects", "An agent subject needs an agent id.", 400);
      agents.add(s.id);
    } else if (s.kind === "person") {
      if (typeof s.id !== "string" || s.id === "" || s.id.length > 64) throw fail("invalid_subjects", "A person subject needs an id.", 400);
      if (!Array.isArray(s.handles) || s.handles.length > MAX_HANDLES) throw fail("invalid_subjects", `A person subject has at most ${MAX_HANDLES} handles.`, 400);
      persons.add(s.id);
    } else if (s.kind !== "unlinked") throw fail("invalid_subjects", "Unknown subject kind.", 400);
    // `unlinked`: Knowledge keeps every grant by a Governance person id, so it has nothing it cannot tie to someone
  }
  return { agents, persons };
}

/** Every item for the wanted subjects, in id order. Reads only local data (areas, the directory copy, grants): never Governance. */
export function collect(db: Db, areas: Areas, want: Wanted, now: number): { items: AccessItem[]; directory: boolean } {
  const state = directoryState(db, now);
  const model: DirectoryModel | null = state.available ? state.model : null;
  const grants = listGrants(db);
  const items: AccessItem[] = [];
  const push = (i: Omit<AccessItem, "digest" | "state">) => items.push({ ...i, state: "active", digest: digestOf(i) });

  const agentIds = want.agents ?? new Set<string>([...areas.list().flatMap((a) => (a.kind === "agent" && a.agentId ? [a.agentId] : [])), ...(model?.agents.map((a) => a.id) ?? [])]);
  for (const agent of agentIds) {
    if (!AGENT_ID.test(agent)) continue;
    const subject = { kind: "agent" as const, id: agent };
    const own = agentAreaId(agent);
    if (areas.get(own)) push({ id: `agent_area:${agent}`, kind: "agent_area", subject, resource: own, direction: "held_by", level: "write", label: "Own memory area", revocable: false });
    for (const a of agentView(model, grants, agent).areas) {
      if (a.kind !== "person") continue;
      push({
        id: `person_area:${agent}:${a.area}`,
        kind: "person_area",
        subject,
        resource: a.area,
        direction: "held_by",
        level: a.access === "read_write" ? "write" : "read",
        label: a.via === "owner" ? "Owner's personal memory" : "Another person's memory, through a team grant",
        revocable: false,
      });
    }
  }
  const teamName = new Map((model?.teams ?? []).map((t) => [t.id, plain(t.name, 60)]));
  for (const g of grants) {
    if (want.persons !== null && !want.persons.has(g.person)) continue;
    const name = teamName.get(g.team);
    push({
      id: grantItemId(g),
      kind: "team_grant",
      subject: { kind: "person", id: g.person },
      resource: personAreaId(g.person),
      direction: "about",
      level: "read",
      label: `${name ? `Team ${name}` : "A team"} may read this person's memory${g.tags ? " (some tags only)" : ""}`.slice(0, 120),
      revocable: true,
    });
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, directory: model !== null };
}

export interface AccessDeps {
  services(ctx: OpContext): { areas: Areas };
  fail: ErrorFactory;
  now?: () => number;
}

export function createTbAccessHandlers(d: AccessDeps): Record<string, HandlerSpec<In, Json>> {
  const { services, fail } = d;
  const clock = d.now ?? Date.now;
  return {
    [ACCESS_LIST]: {
      redact: () => "the access list",
      run: async (input, ctx) => {
        guardCaller(ctx, fail);
        if (input.v !== 1) throw fail("invalid_version", "v must be 1.", 400);
        const limit = input.limit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw fail("invalid_limit", `limit is 1 to ${MAX_LIMIT}.`, 400);
        if (input.sweepId !== undefined && (typeof input.sweepId !== "string" || input.sweepId.length < 1 || input.sweepId.length > 64)) throw fail("invalid_sweep", "sweepId is 1 to 64 characters.", 400);
        const want = wanted(input.subjects, fail);
        const after = decodeCursor(input.cursor, fail);
        const now = clock();
        const { items, directory } = collect(ctx.db, services(ctx).areas, want, now);
        const rest = after === null ? items : items.filter((i) => i.id > after);
        const page = rest.slice(0, limit);
        const last = page.at(-1);
        const notShown = [...STATIC_NOT_SHOWN, ...(directory ? [] : [DIRECTORY_NOT_SHOWN])].map((n) => ({ ...n }));
        return {
          v: 1,
          asOf: new Date(now).toISOString(),
          ...(input.sweepId !== undefined ? { sweepId: input.sweepId } : {}),
          items: page,
          nextCursor: rest.length > limit && last ? encodeCursor(last.id) : null,
          notShown,
          // by contract: nextCursor === null && notShown is empty, nothing else
          complete: rest.length <= limit && notShown.length === 0,
        } as unknown as Json;
      },
    },
    [ACCESS_REVOKE]: {
      redact: (input) => `end ${Array.isArray(input.items) ? input.items.length : 0} access item(s) for plan ${String(input.plan).slice(0, 40)}`,
      run: async (input, ctx) => {
        guardCaller(ctx, fail);
        if (input.v !== 1) throw fail("invalid_version", "v must be 1.", 400);
        const subject = input.subject as { kind?: string; id?: string };
        const asked = input.items as { id: string; digest: string }[];
        if (!Array.isArray(asked) || asked.length < 1 || asked.length > MAX_REVOKE_ITEMS) throw fail("invalid_items", `items needs 1 to ${MAX_REVOKE_ITEMS} entries.`, 400);
        const now = clock();
        const actor = `fleet plan ${String(input.plan).slice(0, 40)} attempt ${Number(input.attempt)}`;
        // No await between reading a grant and removing it (one synchronous pass), so a check cannot go stale.
        const results = asked.map((item) => {
            const id = String(item.id);
            const kind = id.split(":", 1)[0];
            if (kind !== "team_grant") return { id, outcome: "not_revocable", code: kind === "agent_area" || kind === "person_area" ? "areas_never_touched" : "unknown_kind" };
            if (subject.kind !== "person" || typeof subject.id !== "string") return { id, outcome: "not_revocable", code: "wrong_subject" };
            const grant = listGrants(ctx.db).find((g) => g.person === subject.id && grantItemId(g) === id);
            if (!grant) return { id, outcome: "already_gone" };
            const current = digestOf({ id, kind: "team_grant", subject: { kind: "person", id: grant.person }, resource: personAreaId(grant.person), level: "read" });
            if (current !== item.digest) return { id, outcome: "changed", code: "digest_differs" };
            return removeGrant(ctx.db, { team: grant.team, person: grant.person, actor }, now) ? { id, outcome: "revoked" } : { id, outcome: "already_gone" };
        });
        return { v: 1, asOf: new Date(now).toISOString(), results } as unknown as Json;
      },
    },
  };
}
