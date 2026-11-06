// Relationships store (C392 R1). Agents observe conversations and keep, per OPERATOR (a Governance directory person, the
// owner of agents), a record of each THIRD-PARTY person: identities, a relationship type, the owner's stance and trust, and
// cited history. Rules (SCOPE-V2 §2 R1):
// - An agent's operator is its owner in the Governance directory copy (src/people.ts `agentView`). No copy or no owner →
//   `relationships_unavailable` (fail closed). An agent reads and writes only its operator's people; another operator's
//   person answers like a missing one (`person_unknown`).
// - Agents PROPOSE type, identity and label (pending until the owner decides) and add cited history at once (an observation).
//   The type that reads back is the CONFIRMED type only; a pending type shows as `proposedType`.
// - Stance and trust are set by the owner only (`relationship_set`, a person op). Trust defaults to `hold`. Nothing an agent
//   sends can change them: the agent input schemas have no such field, and no code path here writes them for an agent.
// - Every write is logged in kn_rel_log (append-only) with ids, field names and enum values only (never identity values,
//   labels, stance text or history text).
// - R1 hardening (C392 F5): the stored `trust` is the owner's; what an agent may do with a message is `effectiveTrust`, which
//   never exceeds the stored trust and is at most `draft_only` unless the sender identity is VERIFIED (`verified_by`,
//   migration 0006: an owner-confirmed Slack, Buzz or Telegram platform id). Email is never verified until Connect attests
//   a sender per message (`senderVerification`, the hook for messages/1 `author.verified`).
// - R1 hardening (C392 F4): every text an agent or a third party supplied (an agent's label, identity values, the proposed
//   type, proposal values, history text, citations) reads back only under `observed: {untrusted: true, …}` (the platform
//   marker, MANIFEST.md "untrusted"); owner-set fields (type, trust, effectiveTrust, trustBasis, stance, the owner's label)
//   stay outside.
// Pure store functions over the SDK `Db` (like src/people.ts); the handlers are in src/relationship-ops.ts.
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { directoryState } from "./directory-feed.ts";
import { newId } from "./ids.ts";
import { agentView } from "./people.ts";

export const REL_TYPES = ["friend", "family", "colleague", "customer", "supplier", "unknown"] as const;
export const TRUST_LEVELS = ["reply", "draft_only", "hold"] as const;
export const IDENTITY_KINDS = ["email", "slack", "phone", "buzz", "telegram", "other"] as const;
export const HISTORY_KINDS = ["contact", "promise", "topic"] as const;
export const FORMALITY = ["formal", "neutral", "informal"] as const;

export type RelType = (typeof REL_TYPES)[number];
export type Trust = (typeof TRUST_LEVELS)[number];
export type IdentityKind = (typeof IDENTITY_KINDS)[number];
export type HistoryKind = (typeof HISTORY_KINDS)[number];
export type ProposalField = "type" | "identity" | "label";
/** Why an identity is trusted as the SENDER of a message (migration 0006). */
export const VERIFIED_BY = ["platform_id", "dkim_spf_aligned"] as const;
export type VerifiedBy = (typeof VERIFIED_BY)[number];
/** Identity kinds whose value is a platform user id: the platform API names the author, so a third party cannot send as it. */
export const PLATFORM_ID_KINDS: readonly IdentityKind[] = ["slack", "buzz", "telegram"];

/** Per-person caps (F3, F8): pending proposals, and stored history rows (oldest contacts and closed promises make room). */
export const PENDING_CAP = 50;
export const HISTORY_CAP = 500;
/** A citation time may be at most this far ahead of the server clock (clock skew), never more (F7). */
export const FUTURE_SKEW_MS = 5 * 60_000;

export interface Identity {
  kind: IdentityKind;
  value: string;
}
export interface StoredIdentity extends Identity {
  /** null = unverified: a lookup by this identity reads at most `draft_only` */
  verifiedBy: VerifiedBy | null;
}
export interface Citation {
  /** where the observation came from (a channel or app id), ≤ 64 */
  source: string;
  /** the message or record id in that source, ≤ 200 */
  ref: string;
  /** ISO time of the source message */
  at: string;
}
export interface Stance {
  tone?: string;
  formality?: (typeof FORMALITY)[number];
  avoidTopics?: string[];
}

/** F4: data from other people (messages, agents' proposals). Runtimes treat it as data, never as instructions. */
export type Observed<T> = { untrusted: true } & T;

export interface PersonSummary {
  person: string;
  /** the label the OWNER typed (relationship_set); null = the label is an agent's and reads as `observed.label` */
  label: string | null;
  /** the owner-confirmed type (`unknown` until the owner confirms one) */
  type: RelType;
  /** the owner's trust as stored */
  trust: Trust;
  /** what an agent may do now: never above `trust`; at most `draft_only` unless the sender identity is verified (F5) */
  effectiveTrust: Trust;
  /** why `effectiveTrust` is what it is (enum words and an identity kind only, never a value) */
  trustBasis: string;
  stance: Stance | null;
  lastContact: string | null;
  openPromises: number;
  pendingProposals: number;
  observed: Observed<{ label?: string; identities: StoredIdentity[]; proposedType: RelType | null }>;
}
export interface Proposal {
  id: string;
  person: string;
  field: ProposalField;
  proposedBy: string;
  state: "pending" | "accepted" | "rejected";
  createdAt: string;
  observed: Observed<{ value: string | Identity; citation: Citation }>;
}
export interface HistoryItem {
  id: string;
  kind: HistoryKind;
  open?: boolean;
  at: string;
  observed: Observed<{ text: string; citation: Citation }>;
}

export class RelationshipError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const invalid = (message: string) => new RelationshipError("invalid_input", message, 400);
const personUnknown = () => new RelationshipError("person_unknown", "This person is not in your relationships.", 404);
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
/** Length in code points (as JSON Schema maxLength counts). */
const chars = (s: string) => [...s].length;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Clean text: trimmed, inner whitespace runs kept, 1..max code points, else invalid_input naming the field. */
function text(value: unknown, field: string, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s || chars(s) > max) throw invalid(`${field} must have text of at most ${max} characters.`);
  return s;
}

// ── identities ──

const HANDLE_KINDS: ReadonlySet<string> = new Set(["email", "slack", "buzz", "telegram"]);

/**
 * The one stored form of an identity. email, slack, buzz and telegram use the canonical handle rule of
 * `@opt2-tealbrick/manifest` (`normalizeHandle`, G-4: email lower-case addr-spec, Slack upper-case id, Buzz npub, Telegram
 * numeric id) and a value it refuses is refused (and a Slack conversation id: a person is a U/W user id). phone = `+` and 6 to 15 digits (spaces, dots, dashes and brackets are
 * dropped). other = trimmed text. Throws `invalid_identity` (400).
 */
export function normalizeIdentity(kind: unknown, value: unknown): Identity {
  const identity = canonicalIdentity(kind, value);
  // F1: an identity proposal stores the JSON {kind, value} (kn_rel_proposals.value ≤ 400): quotes, backslashes and control
  // characters grow in JSON, so check the stored form here instead of meeting a raw database CHECK error later
  if (chars(JSON.stringify(identity)) > PROPOSAL_VALUE_MAX) throw new RelationshipError("invalid_identity", "This identity is too long to store.", 400);
  return identity;
}
/** kn_rel_proposals.value CHECK (migration 0004). */
const PROPOSAL_VALUE_MAX = 400;

function canonicalIdentity(kind: unknown, value: unknown): Identity {
  if (typeof kind !== "string" || !(IDENTITY_KINDS as readonly string[]).includes(kind)) throw new RelationshipError("invalid_identity", `An identity kind must be one of: ${IDENTITY_KINDS.join(", ")}.`, 400);
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || chars(raw) > 254) throw new RelationshipError("invalid_identity", "An identity needs a value of at most 254 characters.", 400);
  if (HANDLE_KINDS.has(kind)) {
    const handle = normalizeHandle(`${kind}:${raw}`);
    const canonical = handle?.slice(kind.length + 1);
    // a Slack C/G/D id names a conversation (a recipient), never a person: only U/W user ids identify a person
    if (!canonical || (kind === "slack" && !/^[UW]/u.test(canonical))) throw new RelationshipError("invalid_identity", `This is not a valid ${kind} identity of a person.`, 400);
    return { kind: kind as IdentityKind, value: canonical };
  }
  if (kind === "phone") {
    if (!/^\+?[0-9 ().-]+$/u.test(raw)) throw new RelationshipError("invalid_identity", "A phone number has digits only, with an optional leading +.", 400);
    const digits = raw.replace(/[^0-9]/gu, "");
    if (digits.length < 6 || digits.length > 15) throw new RelationshipError("invalid_identity", "A phone number has 6 to 15 digits.", 400);
    return { kind: "phone", value: `+${digits}` };
  }
  return { kind: "other", value: raw };
}

// ── citation ──

/**
 * A citation {source, ref, at} is REQUIRED on every agent write; `at` is stored as an ISO time. F7: an `at` more than
 * FUTURE_SKEW_MS after `now` is refused (a message cannot come from the future; it would also pin lastContact ahead).
 */
export function normalizeCitation(input: unknown, now: number = Date.now(), field = "citation"): Citation {
  if (!isObj(input)) throw invalid(`A ${field} {source, ref, at} of the source message is required.`);
  const source = text(input.source, `${field}.source`, 64);
  const ref = text(input.ref, `${field}.ref`, 200);
  const at = typeof input.at === "string" ? Date.parse(input.at) : Number.NaN;
  if (!Number.isFinite(at)) throw invalid(`${field}.at must be an ISO date or time.`);
  if (at > now + FUTURE_SKEW_MS) throw invalid(`${field}.at is in the future. Cite the time the message was sent.`);
  return { source, ref, at: new Date(at).toISOString() };
}

// ── effective trust (F5) ──

const TRUST_RANK: Record<Trust, number> = { hold: 0, draft_only: 1, reply: 2 };
const atMost = (trust: Trust, cap: Trust): Trust => (TRUST_RANK[trust] <= TRUST_RANK[cap] ? trust : cap);

/**
 * F5 HOOK for a per-message sender attestation. Today it answers the stored verification, except that an EMAIL identity is
 * never verified: a From address is easy to fake. When the spec adds messages/1 `author.verified` (`platform_id` |
 * `dkim_spf_aligned`, produced by Connect, passed by R3/R4), the attestation of THAT message is checked here, and only then
 * may an email sender read above `draft_only`. No op takes an attestation yet, and no op writes `dkim_spf_aligned`.
 */
export function senderVerification(identity: Identity, stored: VerifiedBy | null, _attestation: null = null): VerifiedBy | null {
  if (identity.kind === "email") return null;
  return stored === "platform_id" && PLATFORM_ID_KINDS.includes(identity.kind) ? stored : null;
}

/** How a person was looked up: by the identity a message came from, or by person id (no sender named). */
export type TrustLookup = { by: "identity"; identity: Identity; verifiedBy: VerifiedBy | null } | { by: "person" };

/**
 * The trust an agent may act on (F5), never above the owner's stored trust:
 * - stored `hold` → `hold`.
 * - by identity: a verified sender identity (`senderVerification`) → the stored trust; an unverified one → at most
 *   `draft_only`.
 * - by person id (relationships_list, relationship_get by `person`, the owner's overview): no sender is named, so the stored
 *   trust is capped at `draft_only` when the person has NO verified identity; with one, the stored trust reads back but holds
 *   only for a message from a verified identity. An agent answering a message looks the person up by the sender identity.
 */
export function effectiveTrust(stored: Trust, lookup: TrustLookup, hasVerifiedIdentity: boolean): { effectiveTrust: Trust; trustBasis: string } {
  if (stored === "hold") return { effectiveTrust: "hold", trustBasis: "owner trust: hold" };
  if (lookup.by === "identity") {
    const verified = senderVerification(lookup.identity, lookup.verifiedBy);
    if (verified) return { effectiveTrust: stored, trustBasis: `owner trust: ${stored}; verified ${lookup.identity.kind} platform id` };
    if (stored === "draft_only") return { effectiveTrust: "draft_only", trustBasis: `owner trust: draft_only; unverified ${lookup.identity.kind}` };
    return { effectiveTrust: atMost(stored, "draft_only"), trustBasis: `unverified ${lookup.identity.kind}: draft only` };
  }
  if (!hasVerifiedIdentity) return { effectiveTrust: atMost(stored, "draft_only"), trustBasis: stored === "draft_only" ? "owner trust: draft_only" : "by person id, no verified identity: draft only" };
  return { effectiveTrust: stored, trustBasis: `owner trust: ${stored}; by person id: holds only for a message from a verified identity of this person` };
}

// ── stance ──

export function normalizeStance(input: unknown): Stance | null {
  if (input === null) return null;
  if (!isObj(input)) throw invalid("stance must be an object {tone, formality, avoidTopics} or null.");
  const out: Stance = {};
  if (input.tone !== undefined) out.tone = text(input.tone, "stance.tone", 60);
  if (input.formality !== undefined) {
    if (!(FORMALITY as readonly unknown[]).includes(input.formality)) throw invalid(`stance.formality must be one of: ${FORMALITY.join(", ")}.`);
    out.formality = input.formality as Stance["formality"];
  }
  if (input.avoidTopics !== undefined) {
    if (!Array.isArray(input.avoidTopics) || input.avoidTopics.length > 20) throw invalid("stance.avoidTopics must be a list of at most 20 topics.");
    out.avoidTopics = [...new Set(input.avoidTopics.map((t) => text(t, "stance.avoidTopics[]", 60)))];
  }
  return out;
}

// ── who is the operator ──

/**
 * The operator of an agent = its owner in the current Governance directory copy (the local copy only; never Governance in
 * a call). No usable copy, or no owner → `relationships_unavailable` (409, fail closed).
 */
export function operatorForAgent(db: Db, agentId: string, now: number = Date.now()): string {
  const state = directoryState(db, now);
  if (!state.available || !state.model)
    throw new RelationshipError("relationships_unavailable", "Knowledge has no current copy of the Governance directory, so it does not know whose relationships these are. Try again later, or ask the owner to check Governance.", 409);
  const owner = agentView(state.model, [], agentId).owner;
  if (!owner) throw new RelationshipError("relationships_unavailable", "Governance names no owner for this agent, so it has no relationships to read or keep. Ask the owner to set your owner in Governance.", 409);
  return owner;
}

/** Person ops name an operator; it must be a person in the current directory copy (as setGrant). */
export function requireListedOperator(db: Db, operator: string, now: number = Date.now()): void {
  const state = directoryState(db, now);
  if (!state.available || !state.model) throw new RelationshipError("directory_unavailable", "Knowledge has no current copy of the Governance directory, so it cannot check this person. Open Governance, then try again.", 409);
  if (!state.model.people.some((p) => p.id === operator)) throw new RelationshipError("person_unknown", "Governance does not list this person.", 404);
}

// ── log ──

/** `person_forgotten` (C392 R2) is the one tombstone a forget leaves: person id, operator, actor, time and counts only. */
type LogAction = "person_created" | "proposed" | "history_added" | "history_pruned" | "proposal_accepted" | "proposal_rejected" | "relationship_set" | "person_forgotten";

export function log(db: Db, now: number, actor: string, action: LogAction, operator: string, person: string | null, detail: string | null): void {
  db.prepare("INSERT INTO kn_rel_log (at, actor, action, operator, person_id, detail) VALUES (?, ?, ?, ?, ?, ?)").run(now, actor, action, operator, person, detail);
}

export function relationshipLog(db: Db, operator: string | null, limit = 50): { at: string; actor: string; action: string; operator: string; person: string | null; detail: string | null }[] {
  const rows = operator
    ? db.prepare("SELECT at, actor, action, operator, person_id, detail FROM kn_rel_log WHERE operator = ? ORDER BY id DESC LIMIT ?").all(operator, limit)
    : db.prepare("SELECT at, actor, action, operator, person_id, detail FROM kn_rel_log ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ at: iso(Number(r.at)) as string, actor: String(r.actor), action: String(r.action), operator: String(r.operator), person: r.person_id == null ? null : String(r.person_id), detail: r.detail == null ? null : String(r.detail) }));
}

// ── reads ──

function ownedPerson(db: Db, operator: string, person: string): { id: string; label: string } {
  const row = db.prepare("SELECT id, label FROM kn_rel_people WHERE id = ? AND operator = ?").get(person, operator);
  if (!row) throw personUnknown();
  return { id: String(row.id), label: String(row.label) };
}

const verifiedOf = (v: unknown): VerifiedBy | null => ((VERIFIED_BY as readonly unknown[]).includes(v) ? (v as VerifiedBy) : null);

function identitiesOf(db: Db, person: string): StoredIdentity[] {
  return db
    .prepare("SELECT kind, value, verified_by FROM kn_rel_identities WHERE person_id = ? ORDER BY kind, value")
    .all(person)
    .map((r) => ({ kind: String(r.kind) as IdentityKind, value: String(r.value), verifiedBy: verifiedOf(r.verified_by) }));
}

function summaryOf(db: Db, operator: string, person: string, lookup: TrustLookup = { by: "person" }): PersonSummary {
  const row = db
    .prepare("SELECT p.id, p.label, p.label_set_by, r.type, r.trust, r.stance, r.last_contact_at FROM kn_rel_people p JOIN kn_relationships r ON r.person_id = p.id AND r.operator = p.operator WHERE p.id = ? AND p.operator = ?")
    .get(person, operator);
  if (!row) throw personUnknown();
  const proposed = db.prepare("SELECT value FROM kn_rel_proposals WHERE operator = ? AND person_id = ? AND field = 'type' AND state = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1").get(operator, person);
  const pending = db.prepare("SELECT count(*) AS n FROM kn_rel_proposals WHERE operator = ? AND person_id = ? AND state = 'pending'").get(operator, person);
  const promises = db.prepare("SELECT count(*) AS n FROM kn_rel_history WHERE operator = ? AND person_id = ? AND kind = 'promise' AND open = 1").get(operator, person);
  const identities = identitiesOf(db, person);
  const trust = String(row.trust) as Trust;
  const ownerLabel = row.label_set_by != null;
  return {
    person: String(row.id),
    label: ownerLabel ? String(row.label) : null,
    type: String(row.type) as RelType,
    trust,
    ...effectiveTrust(trust, lookup, identities.some((i) => senderVerification(i, i.verifiedBy) !== null)),
    stance: row.stance == null ? null : (JSON.parse(String(row.stance)) as Stance),
    lastContact: iso(row.last_contact_at == null ? null : Number(row.last_contact_at)),
    openPromises: Number(promises?.n ?? 0),
    pendingProposals: Number(pending?.n ?? 0),
    observed: { untrusted: true, ...(ownerLabel ? {} : { label: String(row.label) }), identities, proposedType: proposed ? (String(proposed.value) as RelType) : null },
  };
}

interface ProposalRow {
  id: string;
  person: string;
  field: ProposalField;
  value: string | Identity;
  state: Proposal["state"];
}
const proposalRow = (r: Record<string, unknown>): ProposalRow => ({
  id: String(r.id),
  person: String(r.person_id),
  field: String(r.field) as ProposalField,
  value: r.field === "identity" ? (JSON.parse(String(r.value)) as Identity) : String(r.value),
  state: String(r.state) as Proposal["state"],
});
const proposalOf = (r: Record<string, unknown>): Proposal => {
  const p = proposalRow(r);
  return {
    id: p.id,
    person: p.person,
    field: p.field,
    proposedBy: String(r.proposed_by),
    state: p.state,
    createdAt: iso(Number(r.created_at)) as string,
    observed: { untrusted: true, value: p.value, citation: JSON.parse(String(r.citation)) as Citation },
  };
};

function pendingProposals(db: Db, operator: string, person: string): Proposal[] {
  return db.prepare("SELECT * FROM kn_rel_proposals WHERE operator = ? AND person_id = ? AND state = 'pending' ORDER BY created_at, id").all(operator, person).map(proposalOf);
}

function historyOf(db: Db, operator: string, person: string, limit: number): HistoryItem[] {
  return db
    .prepare("SELECT id, kind, text, open, citation, created_at FROM kn_rel_history WHERE operator = ? AND person_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(operator, person, limit)
    .map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as HistoryKind,
      ...(r.open == null ? {} : { open: Number(r.open) === 1 }),
      at: iso(Number(r.created_at)) as string,
      observed: { untrusted: true, text: String(r.text), citation: JSON.parse(String(r.citation)) as Citation },
    }));
}

const likeArg = (q: string) => `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

/** The operator's people (newest change first), optionally only one confirmed type and/or a text match on label or identity. */
export function listRelationships(db: Db, operator: string, filter: { type?: RelType; query?: string; limit?: number } = {}): PersonSummary[] {
  const limit = Math.min(Math.max(Number(filter.limit ?? 100), 1), 200);
  const query = typeof filter.query === "string" && filter.query.trim() ? likeArg(filter.query.trim()) : null;
  const rows = db
    .prepare(
      `SELECT p.id FROM kn_rel_people p JOIN kn_relationships r ON r.person_id = p.id AND r.operator = p.operator
       WHERE p.operator = ? AND (? IS NULL OR r.type = ?)
         AND (? IS NULL OR p.label LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM kn_rel_identities i WHERE i.person_id = p.id AND i.value LIKE ? ESCAPE '\\'))
       ORDER BY p.updated_at DESC, p.id LIMIT ?`,
    )
    .all(operator, filter.type ?? null, filter.type ?? null, query, query, query, limit);
  return rows.map((r) => summaryOf(db, operator, String(r.id)));
}

/** The person an identity names for this operator, or null. */
export function personByIdentity(db: Db, operator: string, identity: Identity): string | null {
  return identityRow(db, operator, identity)?.person ?? null;
}

function identityRow(db: Db, operator: string, identity: Identity): { person: string; verifiedBy: VerifiedBy | null } | null {
  const row = db.prepare("SELECT person_id, verified_by FROM kn_rel_identities WHERE operator = ? AND kind = ? AND value = ?").get(operator, identity.kind, identity.value);
  return row ? { person: String(row.person_id), verifiedBy: verifiedOf(row.verified_by) } : null;
}

/**
 * One of the operator's people with recent history and pending proposals; another operator's person is `person_unknown`.
 * By `identity` (the sender of a message), `effectiveTrust` follows that identity's verification (F5).
 */
export function getRelationship(db: Db, operator: string, by: { person?: string; identity?: { kind: unknown; value: unknown } }): PersonSummary & { history: HistoryItem[]; proposals: Proposal[] } {
  if ((by.person === undefined) === (by.identity === undefined)) throw invalid("Name either person or identity.");
  let person: string;
  let lookup: TrustLookup = { by: "person" };
  if (by.person !== undefined) person = ownedPerson(db, operator, String(by.person)).id;
  else {
    const identity = normalizeIdentity(by.identity?.kind, by.identity?.value);
    const row = identityRow(db, operator, identity);
    if (!row) throw personUnknown();
    person = row.person;
    lookup = { by: "identity", identity, verifiedBy: row.verifiedBy };
  }
  return { ...summaryOf(db, operator, person, lookup), history: historyOf(db, operator, person, 50), proposals: pendingProposals(db, operator, person) };
}

// ── agent write: propose ──

export interface ProposeInput {
  person?: string;
  new?: unknown;
  type?: unknown;
  identities?: unknown;
  label?: unknown;
  history?: unknown;
  citation: unknown;
}
export interface ProposeResult {
  person: string;
  created: boolean;
  proposals: { id: string; field: ProposalField; existing: boolean }[];
  history: string[];
  /** fields that already had the proposed value (nothing to propose) */
  unchanged: ProposalField[];
  /** F8: older history rows (contacts, closed promises) dropped to keep the person within HISTORY_CAP */
  pruned: number;
}

const identityList = (input: unknown, field: string): Identity[] => {
  if (!Array.isArray(input) || input.length > 10) throw invalid(`${field} must be a list of at most 10 identities.`);
  const seen = new Map<string, Identity>();
  for (const item of input) {
    if (!isObj(item)) throw invalid(`${field}[] must be {kind, value}.`);
    const id = normalizeIdentity(item.kind, item.value);
    seen.set(`${id.kind}:${id.value}`, id);
  }
  return [...seen.values()];
};

const identityTaken = (identity: Identity, owner: string, prefix = "") =>
  new RelationshipError("identity_taken", `${prefix}This ${identity.kind} identity already belongs to person ${owner}. Propose on that person instead.`, 409);

/**
 * An agent's proposal, all or nothing. A new third party gets a person row (its label and identities as observed, all
 * UNVERIFIED) with type `unknown` and trust `hold`. An identity another of the operator's people already has is
 * `identity_taken` (for a new person and, F3, for an identity proposal on an existing one): propose on that person instead.
 * On an existing person, type, identities and label become PENDING proposals (the same pending value is not proposed
 * twice; the current value is reported `unchanged`); at most PENDING_CAP pending per person (`too_many_pending`). History
 * items are written at once, each with its own citation or the call's (F7); the person keeps at most HISTORY_CAP rows (F8).
 * Never stance, trust or a verification.
 */
export function propose(db: Db, operator: string, agentId: string, input: ProposeInput, now: number = Date.now()): ProposeResult {
  if ((input.person === undefined) === (input.new === undefined)) throw invalid("Name either an existing person or a new one.");
  if (input.new !== undefined && !isObj(input.new)) throw invalid("`new` must be {label, identities}.");
  if (input.new !== undefined && (input.identities !== undefined || input.label !== undefined)) throw invalid("For a new person, put the label and identities inside `new`.");
  const citation = normalizeCitation(input.citation, now);
  const type = input.type === undefined ? null : input.type;
  if (type !== null && (typeof type !== "string" || !REL_TYPES.includes(type as RelType) || type === "unknown")) throw invalid(`type must be one of: ${REL_TYPES.filter((t) => t !== "unknown").join(", ")}.`);
  const history = input.history === undefined ? [] : input.history;
  if (!Array.isArray(history) || history.length > 20) throw invalid("history must be a list of at most 20 items.");
  const items = history.map((item, i) => {
    if (!isObj(item)) throw invalid("Each history item is {kind, text, open, citation}.");
    if (typeof item.kind !== "string" || !(HISTORY_KINDS as readonly string[]).includes(item.kind)) throw invalid(`A history kind must be one of: ${HISTORY_KINDS.join(", ")}.`);
    if (item.open !== undefined && (item.kind !== "promise" || typeof item.open !== "boolean")) throw invalid("Only a promise has `open` (true or false).");
    // F7: an item may cite its own message; otherwise the call's citation
    const cited = item.citation === undefined ? citation : normalizeCitation(item.citation, now, `history[${i}].citation`);
    return { kind: item.kind as HistoryKind, text: text(item.text, "history text", 500), open: item.kind === "promise" ? (item.open === false ? 0 : 1) : null, citation: cited };
  });
  const fresh = isObj(input.new) ? input.new : null;
  const newPerson = fresh ? { label: text(fresh.label, "new.label", 120), identities: identityList(fresh.identities, "new.identities") } : null;
  if (newPerson && !newPerson.identities.length) throw invalid("A new person needs at least one identity.");
  const identities = input.identities === undefined ? [] : identityList(input.identities, "identities");
  const label = input.label === undefined ? null : text(input.label, "label", 120);
  if (!newPerson && type === null && !identities.length && label === null && !items.length) throw invalid("Nothing to propose: send a type, identities, a label or history.");
  const citationJson = JSON.stringify(citation);

  return db.transaction(() => {
    let person: string;
    let created = false;
    if (newPerson) {
      for (const id of newPerson.identities) {
        const owner = personByIdentity(db, operator, id);
        if (owner) throw identityTaken(id, owner);
      }
      person = newId("rp");
      created = true;
      db.prepare("INSERT INTO kn_rel_people (id, operator, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(person, operator, newPerson.label, now, now);
      db.prepare("INSERT INTO kn_relationships (operator, person_id) VALUES (?, ?)").run(operator, person);
      // an agent's identity is never verified (verified_by NULL): only the owner confirms a platform id (F5)
      for (const id of newPerson.identities) db.prepare("INSERT INTO kn_rel_identities (person_id, operator, kind, value, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(person, operator, id.kind, id.value, now, agentId);
      log(db, now, agentId, "person_created", operator, person, `identities: ${newPerson.identities.map((i) => i.kind).join(", ")}`);
    } else person = ownedPerson(db, operator, String(input.person)).id;

    const current = summaryOf(db, operator, person);
    const proposals: ProposeResult["proposals"] = [];
    const unchanged = new Set<ProposalField>();
    const add = (field: ProposalField, value: string) => {
      const same = db.prepare("SELECT id FROM kn_rel_proposals WHERE operator = ? AND person_id = ? AND field = ? AND value = ? AND state = 'pending'").get(operator, person, field, value);
      if (same) {
        proposals.push({ id: String(same.id), field, existing: true });
        return;
      }
      const id = newId("rpp");
      db.prepare("INSERT INTO kn_rel_proposals (id, operator, person_id, field, value, citation, proposed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, operator, person, field, value, citationJson, agentId, now);
      proposals.push({ id, field, existing: false });
    };
    if (type !== null) {
      if (type === current.type) unchanged.add("type");
      else add("type", type as string);
    }
    for (const id of identities) {
      const owner = personByIdentity(db, operator, id);
      if (owner === person) unchanged.add("identity");
      else if (owner) throw identityTaken(id, owner);
      else add("identity", JSON.stringify(id));
    }
    if (label !== null) {
      if (label === (current.label ?? current.observed.label)) unchanged.add("label");
      else add("label", label);
    }
    const added = proposals.filter((p) => !p.existing);
    if (added.length) {
      const pending = Number(db.prepare("SELECT count(*) AS n FROM kn_rel_proposals WHERE operator = ? AND person_id = ? AND state = 'pending'").get(operator, person)?.n ?? 0);
      if (pending > PENDING_CAP) throw new RelationshipError("too_many_pending", `This person already has ${PENDING_CAP} proposals waiting for the owner. Wait until the owner decides them.`, 409);
      log(db, now, agentId, "proposed", operator, person, added.map((p) => `${p.field} ${p.id}`).join("; "));
    }

    const historyIds: string[] = [];
    let lastContact: number | null = null;
    for (const item of items) {
      const id = newId("rph");
      db.prepare("INSERT INTO kn_rel_history (id, operator, person_id, kind, text, open, citation, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, operator, person, item.kind, item.text, item.open, JSON.stringify(item.citation), agentId, now);
      historyIds.push(id);
      if (item.kind === "contact") lastContact = Math.max(lastContact ?? 0, Math.min(Date.parse(item.citation.at), now));
    }
    if (lastContact !== null) db.prepare("UPDATE kn_relationships SET last_contact_at = max(coalesce(last_contact_at, 0), ?) WHERE operator = ? AND person_id = ?").run(lastContact, operator, person);
    let pruned = 0;
    if (items.length) {
      const counts = HISTORY_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length] as const).filter(([, n]) => n > 0);
      log(db, now, agentId, "history_added", operator, person, counts.map(([k, n]) => `${k} x${n}`).join(", "));
      pruned = pruneHistory(db, operator, person, agentId, historyIds, now);
    }
    if (added.length || items.length) db.prepare("UPDATE kn_rel_people SET updated_at = ? WHERE id = ?").run(now, person);
    return { person, created, proposals, history: historyIds, unchanged: [...unchanged], pruned };
  });
}

/**
 * F8: a person keeps at most HISTORY_CAP history rows. Over the cap, the OLDEST contacts and closed promises (kept counts in
 * `lastContact`; nothing is owed) are dropped first, never this call's own rows. Topics and open promises are never dropped
 * silently: if they alone fill the cap, the write is refused (`history_full`, nothing written) so no commitment is lost.
 */
function pruneHistory(db: Db, operator: string, person: string, actor: string, keep: readonly string[], now: number): number {
  const total = Number(db.prepare("SELECT count(*) AS n FROM kn_rel_history WHERE operator = ? AND person_id = ?").get(operator, person)?.n ?? 0);
  const excess = total - HISTORY_CAP;
  if (excess <= 0) return 0;
  const victims = db
    .prepare(
      `SELECT id, kind FROM kn_rel_history WHERE operator = ? AND person_id = ? AND (kind = 'contact' OR (kind = 'promise' AND open = 0))
         AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at, id LIMIT ?`,
    )
    .all(operator, person, JSON.stringify(keep), excess);
  if (victims.length < excess)
    throw new RelationshipError("history_full", `This person already has ${HISTORY_CAP} history items that are topics or open promises. Record no more for this person and tell the owner.`, 409);
  for (const v of victims) db.prepare("DELETE FROM kn_rel_history WHERE id = ?").run(String(v.id));
  const counts = (["contact", "promise"] as const).map((k) => [k, victims.filter((v) => v.kind === k).length] as const).filter(([, n]) => n > 0);
  log(db, now, actor, "history_pruned", operator, person, counts.map(([k, n]) => `${k} x${n}`).join(", "));
  return victims.length;
}

// ── owner reads and writes ──

export interface OperatorOverview {
  operator: string;
  /** the operator is a person in the current Governance directory copy */
  listed: boolean;
  people: (PersonSummary & { proposals: Proposal[] })[];
}

/** Every operator with people (and every directory person when the copy is available), their people and pending proposals. */
export function relationshipsOverview(db: Db, only: string | null, now: number = Date.now()): { directory: { available: boolean; status: string }; operators: OperatorOverview[]; log: ReturnType<typeof relationshipLog> } {
  const state = directoryState(db, now);
  const listed = new Set(state.available && state.model ? state.model.people.map((p) => p.id) : []);
  const stored = db.prepare("SELECT DISTINCT operator FROM kn_rel_people ORDER BY operator").all().map((r) => String(r.operator));
  const operators = [...new Set([...listed, ...stored])].filter((o) => only === null || o === only).sort();
  return {
    directory: { available: state.available, status: state.status },
    operators: operators.map((operator) => ({
      operator,
      listed: listed.has(operator),
      people: listRelationships(db, operator, { limit: 200 }).map((p) => ({ ...p, proposals: pendingProposals(db, operator, p.person) })),
    })),
    log: relationshipLog(db, only),
  };
}

export interface Decided {
  id: string;
  person: string;
  field: ProposalField;
  state: "accepted" | "rejected";
}
/** F3: an accepted proposal that could not apply; it stays pending (the owner may reject it). */
export interface Conflict {
  id: string;
  person: string;
  field: ProposalField;
  code: "identity_taken";
  /** the person that already has the identity */
  takenBy: string;
}

/**
 * Owner op: accept or reject pending proposals of one operator. An unknown or already decided id refuses the whole call
 * (nothing changes). F3: an accepted identity that another person of the operator already has is reported in `conflicts`
 * and stays pending; the other decisions of the call apply. Accepting a Slack, Buzz or Telegram identity verifies it
 * (`platform_id`): the owner confirmed that this platform id is this person (F5). An accepted label is still an agent's
 * words: it reads back under `observed`.
 */
export function decideProposals(db: Db, operator: string, actor: string, input: { accept?: unknown; reject?: unknown }, now: number = Date.now()): { decided: Decided[]; conflicts: Conflict[] } {
  const ids = (v: unknown): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw invalid("accept and reject are lists of proposal ids.");
    return v.map(String);
  };
  const accept = ids(input.accept);
  const reject = ids(input.reject);
  if (!accept.length && !reject.length) throw invalid("Name at least one proposal to accept or reject.");
  const all = [...accept, ...reject];
  if (new Set(all).size !== all.length) throw invalid("Name each proposal once.");
  return db.transaction(() => {
    const rows = all.map((id) => {
      const row = db.prepare("SELECT * FROM kn_rel_proposals WHERE id = ? AND operator = ?").get(id, operator);
      if (!row) throw new RelationshipError("proposal_unknown", `There is no proposal ${id.slice(0, 40)} for this person.`, 404);
      if (row.state !== "pending") throw new RelationshipError("proposal_decided", `Proposal ${id.slice(0, 40)} is already ${String(row.state)}.`, 409);
      return proposalRow(row);
    });
    const decided: Decided[] = [];
    const conflicts: Conflict[] = [];
    for (const p of rows) {
      const state = accept.includes(p.id) ? "accepted" : "rejected";
      if (state === "accepted") {
        if (p.field === "type") db.prepare("UPDATE kn_relationships SET type = ?, set_by = ?, set_at = ? WHERE operator = ? AND person_id = ?").run(p.value as string, actor, now, operator, p.person);
        else if (p.field === "label") db.prepare("UPDATE kn_rel_people SET label = ?, label_set_by = NULL WHERE id = ?").run(p.value as string, p.person);
        else {
          const identity = p.value as Identity;
          const owner = personByIdentity(db, operator, identity);
          if (owner && owner !== p.person) {
            conflicts.push({ id: p.id, person: p.person, field: p.field, code: "identity_taken", takenBy: owner });
            continue;
          }
          const verified = PLATFORM_ID_KINDS.includes(identity.kind) ? "platform_id" : null;
          if (!owner) db.prepare("INSERT INTO kn_rel_identities (person_id, operator, kind, value, created_at, created_by, verified_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.person, operator, identity.kind, identity.value, now, actor, verified);
          else if (verified) db.prepare("UPDATE kn_rel_identities SET verified_by = ? WHERE operator = ? AND kind = ? AND value = ?").run(verified, operator, identity.kind, identity.value);
        }
      }
      db.prepare("UPDATE kn_rel_proposals SET state = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(state, now, actor, p.id);
      db.prepare("UPDATE kn_rel_people SET updated_at = ? WHERE id = ?").run(now, p.person);
      log(db, now, actor, state === "accepted" ? "proposal_accepted" : "proposal_rejected", operator, p.person, `${p.field} ${p.id}${state === "accepted" && p.field === "type" ? ` type=${String(p.value)}` : ""}`);
      decided.push({ id: p.id, person: p.person, field: p.field, state });
    }
    return { decided, conflicts };
  });
}

/**
 * Owner op: set type, stance, trust and/or label of one of the operator's people, and verify identities. A label set here
 * is the owner's (`label_set_by`, it reads outside `observed`), also when it equals the agent's label. `verifyIdentities`
 * (F5) marks Slack, Buzz or Telegram ids of THIS person as `platform_id`: the owner confirms the platform id is this person.
 * Email, phone and other cannot be verified (`identity_unverifiable`): email waits for a per-message attestation from Connect.
 */
export function setRelationship(
  db: Db,
  operator: string,
  actor: string,
  input: { person: string; type?: unknown; stance?: unknown; trust?: unknown; label?: unknown; verifyIdentities?: unknown },
  now: number = Date.now(),
): { relationship: PersonSummary; changed: boolean } {
  const fields: Record<string, unknown> = {};
  if (input.type !== undefined) {
    if (!(REL_TYPES as readonly unknown[]).includes(input.type)) throw invalid(`type must be one of: ${REL_TYPES.join(", ")}.`);
    fields.type = input.type;
  }
  if (input.trust !== undefined) {
    if (!(TRUST_LEVELS as readonly unknown[]).includes(input.trust)) throw invalid(`trust must be one of: ${TRUST_LEVELS.join(", ")}.`);
    fields.trust = input.trust;
  }
  if (input.stance !== undefined) {
    const stance = normalizeStance(input.stance);
    fields.stance = stance === null ? null : JSON.stringify(stance);
  }
  const label = input.label === undefined ? null : text(input.label, "label", 120);
  const verify = input.verifyIdentities === undefined ? [] : identityList(input.verifyIdentities, "verifyIdentities");
  for (const id of verify)
    if (!PLATFORM_ID_KINDS.includes(id.kind))
      throw new RelationshipError("identity_unverifiable", `A ${id.kind} identity cannot be verified: only Slack, Buzz and Telegram ids. Email needs a per-message check by Connect, which is not available yet.`, 400);
  if (!Object.keys(fields).length && label === null && !verify.length) throw invalid("Set at least one of type, stance, trust, label or verifyIdentities.");
  return db.transaction(() => {
    ownedPerson(db, operator, input.person);
    const before = db.prepare("SELECT r.type, r.trust, r.stance, p.label, p.label_set_by FROM kn_relationships r JOIN kn_rel_people p ON p.id = r.person_id WHERE r.operator = ? AND r.person_id = ?").get(operator, input.person) as Record<string, unknown>;
    const toVerify = verify.filter((id) => {
      const row = identityRow(db, operator, id);
      if (row?.person !== input.person) throw new RelationshipError("identity_unknown", `This person has no such ${id.kind} identity.`, 404);
      return row.verifiedBy !== "platform_id";
    });
    const labelChanged = label !== null && (label !== before.label || before.label_set_by == null);
    const changedFields = [...Object.entries(fields).filter(([k, v]) => (before[k] ?? null) !== v).map(([k]) => k), ...(labelChanged ? ["label"] : [])];
    if (changedFields.length || toVerify.length) {
      if (changedFields.length) {
        const sets = Object.keys(fields).map((k) => `${k} = ?`);
        db.prepare(`UPDATE kn_relationships SET ${[...sets, "set_by = ?", "set_at = ?"].join(", ")} WHERE operator = ? AND person_id = ?`).run(...Object.values(fields), actor, now, operator, input.person);
      }
      if (labelChanged) db.prepare("UPDATE kn_rel_people SET label = ?, label_set_by = ? WHERE id = ?").run(label, actor, input.person);
      for (const id of toVerify) db.prepare("UPDATE kn_rel_identities SET verified_by = 'platform_id' WHERE operator = ? AND kind = ? AND value = ?").run(operator, id.kind, id.value);
      db.prepare("UPDATE kn_rel_people SET updated_at = ? WHERE id = ?").run(now, input.person);
      const detail = [
        ...changedFields.map((k) => (k === "type" || k === "trust" ? `${k}=${String(fields[k])}` : k)),
        ...(toVerify.length ? [`verified ${[...new Set(toVerify.map((i) => i.kind))].join(",")} x${toVerify.length}`] : []),
      ].join(" ");
      log(db, now, actor, "relationship_set", operator, input.person, detail);
    }
    return { relationship: summaryOf(db, operator, input.person), changed: changedFields.length > 0 || toVerify.length > 0 };
  });
}
