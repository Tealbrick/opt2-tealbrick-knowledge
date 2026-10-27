// Person and team memory (C373; Martin C312.4 "governance over how far agents reach into company and other users'
// memories", C322(5) "no cross-person memory reads by default; admin grants per team").
// Who owns an agent and who is in which team comes from the Governance directory copy (src/directory-feed.ts). On top of
// the bridge edge grant, the SDK scope rows (agent and company areas, unchanged) and Rules narrowing, an AGENT gets:
// - read and write on `person-…` of its owner P, and the owner's area is its default area for writes;
// - read on `team-…` of every team T where the agent or its owner P is a member (none for a blocked agent);
// - read on another person Q's area ONLY through an owner grant "team T may read Q" for one of its teams (optionally
//   limited to tags: then only memories with at least one of those tags);
// - nothing else of another person, another team or another agent.
// No directory copy (Governance missing, before 0.3.0, refusing, stale), or an agent with no owner in it → today's access:
// its own agent area + the company area (fail closed). A person caller (the workspace owner) reads every area as today.
import { createHash } from "node:crypto";
import type { Db } from "@opt2-tealbrick/spec/sdk";
import type { Areas } from "./areas.ts";
import { type DirectoryModel, directoryState } from "./directory-feed.ts";
import { normalizeTag } from "./narrowing.ts";
import { cleanTags } from "./store/documents.ts";

const hash = (kind: string, id: string) => createHash("sha256").update(`${kind}:${id}`).digest("hex").slice(0, 24);
/** Area id of a Governance person: `person-` + 24 hex (directory ids are free text; area ids follow AREA_ID). */
export const personAreaId = (personId: string) => `person-${hash("person", personId)}`;
export const teamAreaId = (teamId: string) => `team-${hash("team", teamId)}`;
/** Area ids Knowledge governs from the directory (never SDK scope instances). */
export const isGovernedArea = (area: string) => area.startsWith("person-") || area.startsWith("team-");

export const personLabel = (personId: string) => `Person ${personId.slice(0, 64)} (personal memory)`;
export const teamLabel = (name: string) => `${name.slice(0, 80)} (team memory)`;

export interface TeamGrant {
  team: string;
  person: string;
  /** null = the whole area; else only memories with at least one of these tags */
  tags: string[] | null;
  createdAt: number;
  createdBy: string;
}

export interface GovernedArea {
  area: string;
  kind: "person" | "team";
  subject: string;
  label: string;
  access: "read" | "read_write";
  /** null = every memory of the area; else a memory needs at least one of these tags */
  tags: string[] | null;
  /** why: "owner" (own person area), "team" (member), "grant" (owner grant to one of its teams) */
  via: "owner" | "team" | "grant";
}

export interface AgentView {
  /** the directory copy decides access now */
  directory: boolean;
  /** the agent's owner (an active person), null = none known */
  owner: string | null;
  teams: string[];
  areas: GovernedArea[];
}

const NONE: AgentView = { directory: false, owner: null, teams: [], areas: [] };

export function listGrants(db: Db): TeamGrant[] {
  return db
    .prepare("SELECT team_id, person_id, tags, created_at, created_by FROM kn_team_grants ORDER BY team_id, person_id")
    .all()
    .map((r) => ({ team: String(r.team_id), person: String(r.person_id), tags: r.tags == null ? null : (JSON.parse(String(r.tags)) as string[]), createdAt: Number(r.created_at), createdBy: String(r.created_by) }));
}

/** The governed areas one agent may use, from the directory model and the owner's grants (pure). */
export function agentView(model: DirectoryModel | null, grants: readonly TeamGrant[], agentId: string): AgentView {
  if (!model) return NONE;
  const agent = model.agents.find((a) => a.id === agentId);
  if (!agent) return { ...NONE, directory: true };
  const owner = agent.owner;
  const person = owner ? model.people.find((p) => p.id === owner) : undefined;
  const teamNames = new Map(model.teams.map((t) => [t.id, t.name]));
  const teams = agent.teamReads ? model.teams.filter((t) => t.agents.includes(agentId) || (owner !== null && person?.teamReads === true && t.people.includes(owner))).map((t) => t.id) : [];
  const areas: GovernedArea[] = [];
  if (owner) areas.push({ area: personAreaId(owner), kind: "person", subject: owner, label: personLabel(owner), access: "read_write", tags: null, via: "owner" });
  for (const t of teams) areas.push({ area: teamAreaId(t), kind: "team", subject: t, label: teamLabel(teamNames.get(t) ?? t), access: "read", tags: null, via: "team" });
  // grants of the agent's teams; several grants on one person: the union (a whole-area grant wins)
  const people = new Set(model.people.map((p) => p.id));
  const granted = new Map<string, string[] | null>();
  for (const g of grants) {
    if (!teams.includes(g.team) || g.person === owner || !people.has(g.person)) continue;
    const before = granted.get(g.person);
    if (before === null || g.tags === null) granted.set(g.person, null);
    else granted.set(g.person, [...new Set([...(before ?? []), ...g.tags])]);
  }
  for (const [p, tags] of granted) areas.push({ area: personAreaId(p), kind: "person", subject: p, label: personLabel(p), access: "read", tags, via: "grant" });
  return { directory: true, owner, teams, areas };
}

/** The view of one agent now (reads only the local copy: never Governance). Creates its own person and team areas on demand. */
export function viewFor(db: Db, areas: Areas, agentId: string, now: number = Date.now()): AgentView {
  const state = directoryState(db, now);
  const view = agentView(state.available ? state.model : null, state.available ? listGrants(db) : [], agentId);
  for (const a of view.areas) if (a.via !== "grant") areas.ensureSubject(a.kind, a.area, a.subject, a.label);
  return view;
}

/**
 * C373: the areas of the directory, created when a new directory is read: every team, and every person who owns at least
 * one agent (other people get theirs on first use). Labels follow the directory. Returns how many areas are new.
 */
export function ensureDirectoryAreas(areas: Areas, model: DirectoryModel): number {
  let created = 0;
  const ensure = (kind: "person" | "team", id: string, subject: string, label: string) => {
    if (!areas.get(id)) created++;
    areas.ensureSubject(kind, id, subject, label);
  };
  for (const t of model.teams) ensure("team", teamAreaId(t.id), t.id, teamLabel(t.name));
  const owners = new Set(model.agents.flatMap((a) => (a.owner ? [a.owner] : [])));
  for (const p of model.people) if (owners.has(p.id)) ensure("person", personAreaId(p.id), p.id, personLabel(p.id));
  return created;
}

export class GrantError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Owner op: add (or change) "team T may read person P's area". The directory copy must be available and name both, so a
 * grant is never stored for a team or person the owner cannot see. Logged in kn_access_log (append-only).
 */
export function setGrant(db: Db, input: { team: string; person: string; tags?: string[] | null; actor: string }, now: number = Date.now()): { grant: TeamGrant; changed: boolean } {
  const state = directoryState(db, now);
  if (!state.available || !state.model) throw new GrantError("directory_unavailable", "Knowledge has no current copy of the Governance directory, so it cannot check this team and person. Open Governance, then try again.", 409);
  if (!state.model.teams.some((t) => t.id === input.team)) throw new GrantError("team_unknown", "Governance does not list this team.", 404);
  if (!state.model.people.some((p) => p.id === input.person)) throw new GrantError("person_unknown", "Governance does not list this person.", 404);
  const tags = cleanTags(input.tags ?? undefined);
  // QA-KN25-1: a limit the owner asked for must never become "the whole area": refuse tags that clean to nothing or lose some
  if (input.tags?.length) {
    const asked = new Set(input.tags.map(normalizeTag));
    if (asked.has("") || tags.length < asked.size) throw new GrantError("invalid_input", "Each tag must have text, and a grant may name at most 20 tags. Fix the tags, or leave them empty to share the whole area.", 400);
  }
  const tagsJson = tags.length ? JSON.stringify(tags) : null;
  return db.transaction(() => {
    const before = db.prepare("SELECT tags FROM kn_team_grants WHERE team_id = ? AND person_id = ?").get(input.team, input.person);
    const same = before !== undefined && (before.tags ?? null) === tagsJson;
    if (!same) {
      db.prepare("INSERT INTO kn_team_grants (team_id, person_id, tags, created_at, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (team_id, person_id) DO UPDATE SET tags = excluded.tags, created_at = excluded.created_at, created_by = excluded.created_by").run(input.team, input.person, tagsJson, now, input.actor);
      db.prepare("INSERT INTO kn_access_log (at, actor, action, team_id, person_id, tags) VALUES (?, ?, ?, ?, ?, ?)").run(now, input.actor, before ? "grant_changed" : "grant_added", input.team, input.person, tagsJson);
    }
    const grant = listGrants(db).find((g) => g.team === input.team && g.person === input.person) as TeamGrant;
    return { grant, changed: !same };
  });
}

/** Owner op: remove a grant (works without a directory copy: removing only narrows). */
export function removeGrant(db: Db, input: { team: string; person: string; actor: string }, now: number = Date.now()): boolean {
  return db.transaction(() => {
    const removed = Number(db.prepare("DELETE FROM kn_team_grants WHERE team_id = ? AND person_id = ?").run(input.team, input.person).changes ?? 0) > 0;
    if (removed) db.prepare("INSERT INTO kn_access_log (at, actor, action, team_id, person_id, tags) VALUES (?, ?, 'grant_removed', ?, ?, NULL)").run(now, input.actor, input.team, input.person);
    return removed;
  });
}

export function accessLog(db: Db, limit = 50): { at: number; actor: string; action: string; team: string; person: string; tags: string[] | null }[] {
  return db
    .prepare("SELECT at, actor, action, team_id, person_id, tags FROM kn_access_log ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({ at: Number(r.at), actor: String(r.actor), action: String(r.action), team: String(r.team_id), person: String(r.person_id), tags: r.tags == null ? null : (JSON.parse(String(r.tags)) as string[]) }));
}
