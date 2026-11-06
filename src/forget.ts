// Forget a person (C392 R2, Knowledge-local stores). The Relationships person record is the anchor: its label and identity
// values are the search terms. An OWNER (person caller) only, never an agent (src/relationship-ops.ts checks the caller).
// - scan: every Knowledge document of every area, live AND soft-deleted, its current title, body, summary, tags and source
//   fields, EVERY revision and every comment, for each term (case-insensitive substring; terms shorter than 4 characters
//   are skipped as noise). A match names the document, its area and where the term was found: never the text.
// - forget: in ONE transaction, scan, hard-delete the person with its identities, edge, proposals and history, write one
//   tombstone row to kn_rel_log (`person_forgotten`: counts only), and hard-delete the documents the owner picked from this
//   call's scan (document, revisions, comments, links, projection rows; FTS rows go with the document trigger). Each purged
//   document of an engine area is queued in kn_forget_queue; its GBrain page is purged through the engine helper
//   (upstream's trusted local CLI `gbrain delete <slug> --purge`; upstream refuses `purge` over MCP: purge-params.ts).
// Pure store functions over the SDK `Db`; the engine call is `drainForgetQueue` (async, outside the transaction).
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { backoffMs } from "./projection.ts";
import { log, RelationshipError, requireListedOperator } from "./relationships.ts";

/** Shorter terms match too much ordinary text to mean this person. */
export const MIN_TERM_CHARS = 4;
/** At most this many matches come back (the purge check uses the full scan). */
export const MATCH_LIMIT = 500;

export type MatchPlace = "title" | "body" | "revision" | "comment";
export interface DocumentMatch {
  documentId: string;
  area: string;
  /** the document is soft-deleted (deleted in the Library, still stored) */
  deleted: boolean;
  where: MatchPlace[];
}
export interface ScanResult {
  terms: number;
  skippedShort: number;
  /** each with the document's current title, for the owner only (S3: tells false positives apart); never stored */
  matched: (DocumentMatch & { title: string })[];
  truncated: boolean;
}
/** Titles in a scan answer and the confirmation text are cut to this many characters. */
export const TITLE_CHARS = 120;

const chars = (s: string) => [...s].length;
const personUnknown = () => new RelationshipError("person_unknown", "This person is not in the relationships of this operator.", 404);

/** Search terms of a person: the label and every identity value (a phone also without its `+`), lower-cased, deduplicated. */
export function forgetTerms(label: string, values: readonly string[]): { terms: string[]; skippedShort: number } {
  const raw = [label, ...values, ...values.filter((v) => /^\+[0-9]+$/u.test(v)).map((v) => v.slice(1))].map((t) => t.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(raw)];
  const terms = unique.filter((t) => chars(t) >= MIN_TERM_CHARS);
  return { terms, skippedShort: unique.length - terms.length };
}

/** The person (of this operator) with its label and identity values; another operator's person is `person_unknown`. */
export function personOf(db: Db, operator: string, person: string): { label: string; values: string[] } {
  const row = db.prepare("SELECT label FROM kn_rel_people WHERE id = ? AND operator = ?").get(person, operator);
  if (!row) throw personUnknown();
  const values = db
    .prepare("SELECT value FROM kn_rel_identities WHERE person_id = ? AND operator = ?")
    .all(person, operator)
    .map((r) => String(r.value));
  return { label: String(row.label), values };
}

/**
 * Person ops name the operator. A forget must work for an operator who has left the Governance directory (their contacts
 * stay stored until forgotten), so an operator with stored people is accepted; any other operator must be listed.
 */
export function requireKnownOperator(db: Db, operator: string): void {
  if (db.prepare("SELECT 1 FROM kn_rel_people WHERE operator = ? LIMIT 1").get(operator)) return;
  requireListedOperator(db, operator);
}

const BATCH = 500;

/** Every row of a query in rowid order, BATCH rows at a time (the scan never loads a whole table at once). */
function* batches(db: Db, sql: string): Generator<Record<string, unknown>> {
  let after = -1;
  for (;;) {
    const rows = db.prepare(sql).all(after, BATCH);
    for (const row of rows) yield row;
    if (rows.length < BATCH) return;
    after = Number(rows[rows.length - 1]?.r);
  }
}

/** Which Knowledge documents name one of the terms, and where. Reads only; returns ids, areas and places, never text. */
export function scanDocuments(db: Db, terms: readonly string[]): Map<string, DocumentMatch> {
  const found = new Map<string, DocumentMatch>();
  if (!terms.length) return found;
  const hit = (...texts: unknown[]) => {
    const text = texts.filter((t) => typeof t === "string" && t).join("\n").toLowerCase();
    return text.length > 0 && terms.some((term) => text.includes(term));
  };
  const note = (id: string, area: string, deleted: boolean, place: MatchPlace) => {
    const entry = found.get(id) ?? { documentId: id, area, deleted, where: [] };
    if (!entry.where.includes(place)) entry.where.push(place);
    found.set(id, entry);
  };
  for (const r of batches(db, "SELECT rowid AS r, id, area_id, deleted_at, title, summary, body, tags, source_ref, source_url FROM kn_documents WHERE rowid > ? ORDER BY rowid LIMIT ?")) {
    const id = String(r.id);
    const area = String(r.area_id);
    const deleted = r.deleted_at != null;
    if (hit(r.title)) note(id, area, deleted, "title");
    // "body" = the document's current content: body, summary, tags and its source reference and link
    if (hit(r.body, r.summary, r.tags, r.source_ref, r.source_url)) note(id, area, deleted, "body");
  }
  for (const r of batches(
    db,
    "SELECT v.rowid AS r, v.document_id, d.area_id, d.deleted_at, v.title, v.summary, v.body, v.tags FROM kn_revisions v JOIN kn_documents d ON d.id = v.document_id WHERE v.rowid > ? ORDER BY v.rowid LIMIT ?",
  )) {
    if (hit(r.title, r.summary, r.body, r.tags)) note(String(r.document_id), String(r.area_id), r.deleted_at != null, "revision");
  }
  for (const r of batches(db, "SELECT c.rowid AS r, c.document_id, d.area_id, d.deleted_at, c.body FROM kn_comments c JOIN kn_documents d ON d.id = c.document_id WHERE c.rowid > ? ORDER BY c.rowid LIMIT ?")) {
    if (hit(r.body)) note(String(r.document_id), String(r.area_id), r.deleted_at != null, "comment");
  }
  const order: MatchPlace[] = ["title", "body", "revision", "comment"];
  for (const entry of found.values()) entry.where.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return found;
}

const sorted = (found: Map<string, DocumentMatch>) => [...found.values()].sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));

/** A document's current title, cut to TITLE_CHARS code points ("" when the document is gone). */
export function documentTitle(db: Db, id: string): string {
  const title = String(db.prepare("SELECT title FROM kn_documents WHERE id = ?").get(id)?.title ?? "");
  return [...title].slice(0, TITLE_CHARS).join("");
}

/**
 * Owner read: what a forget of this person would find, without changing anything. Each match carries the document's title
 * so the owner can tell a false positive apart; this answer is a read (never stored, no receipt). The forget's own report
 * and everything it stores carry ids only.
 */
export function forgetScan(db: Db, operator: string, person: string): ScanResult & { found: Map<string, DocumentMatch> } {
  const p = personOf(db, operator, person);
  const { terms, skippedShort } = forgetTerms(p.label, p.values);
  const found = scanDocuments(db, terms);
  const all = sorted(found);
  return { terms: terms.length, skippedShort, matched: all.slice(0, MATCH_LIMIT).map((m) => ({ ...m, title: documentTitle(db, m.documentId) })), truncated: all.length > MATCH_LIMIT, found };
}

/**
 * Hard-delete one document with everything that holds its text: revisions, comments, links (both ways) and projection rows.
 * Its children (live or soft-deleted) move up to its parent, as a soft delete does. The FTS row goes with the delete trigger.
 */
export function purgeDocument(db: Db, id: string): { area: string; sourceId: string } | null {
  const row = db.prepare("SELECT d.area_id, d.parent_id, a.source_id FROM kn_documents d JOIN kn_areas a ON a.id = d.area_id WHERE d.id = ?").get(id);
  if (!row) return null;
  db.prepare("UPDATE kn_documents SET parent_id = ? WHERE parent_id = ?").run(row.parent_id ?? null, id);
  db.prepare("DELETE FROM kn_links WHERE source_id = ? OR target_id = ?").run(id, id);
  db.prepare("DELETE FROM kn_comments WHERE document_id = ?").run(id);
  db.prepare("DELETE FROM kn_revisions WHERE document_id = ?").run(id);
  db.prepare("DELETE FROM kn_projection WHERE document_id = ?").run(id);
  db.prepare("DELETE FROM kn_documents WHERE id = ?").run(id);
  return { area: String(row.area_id), sourceId: String(row.source_id) };
}

export interface ForgetCounts {
  people: number;
  identities: number;
  edges: number;
  proposals: number;
  history: number;
}
export interface ForgetCore {
  person: string;
  operator: string;
  deleted: { relationships: ForgetCounts };
  scan: Omit<ScanResult, "matched">;
  matched: DocumentMatch[];
  /** hard-deleted documents; `queued` = its engine page waits in kn_forget_queue */
  purged: { documentId: string; area: string; queued: boolean }[];
  refused: { documentId: string; reason: string }[];
}

/**
 * The forget, all or nothing (one transaction): scan, delete the person's rows, write the tombstone, purge the picked
 * documents (only ids in THIS call's scan; any other id is refused, nothing of it is deleted) and queue their engine pages
 * (`queueEngine`: an engine runs). Child rows are deleted explicitly, so the delete does not depend on the foreign-key pragma.
 */
export function forgetPerson(db: Db, operator: string, actor: string, input: { person: string; purgeDocuments?: readonly string[] }, opts: { queueEngine: boolean; now?: number }): ForgetCore {
  const now = opts.now ?? Date.now();
  const picked = [...new Set(input.purgeDocuments ?? [])];
  return db.transaction(() => {
    const p = personOf(db, operator, input.person);
    const { terms, skippedShort } = forgetTerms(p.label, p.values);
    const found = scanDocuments(db, terms);
    const del = (table: string) => db.prepare(`DELETE FROM ${table} WHERE person_id = ? AND operator = ?`).run(input.person, operator).changes;
    const counts: ForgetCounts = { people: 0, identities: del("kn_rel_identities"), edges: del("kn_relationships"), proposals: del("kn_rel_proposals"), history: del("kn_rel_history") };
    counts.people = db.prepare("DELETE FROM kn_rel_people WHERE id = ? AND operator = ?").run(input.person, operator).changes;

    const purged: ForgetCore["purged"] = [];
    const refused: ForgetCore["refused"] = [];
    for (const id of picked) {
      if (!found.has(id)) {
        refused.push({ documentId: id, reason: "not_matched: this document does not name the person in this forget's scan (or does not exist); nothing of it was deleted" });
        continue;
      }
      const gone = purgeDocument(db, id);
      if (!gone) {
        refused.push({ documentId: id, reason: "not_found: the document is gone" });
        continue;
      }
      if (opts.queueEngine)
        db.prepare("INSERT INTO kn_forget_queue (source_id, document_id, attempts, next_attempt_at, last_error, created_at) VALUES (?, ?, 0, 0, NULL, ?) ON CONFLICT (source_id, document_id) DO UPDATE SET attempts = 0, next_attempt_at = 0, last_error = NULL").run(gone.sourceId, id, now);
      purged.push({ documentId: id, area: gone.area, queued: opts.queueEngine });
    }
    // Deleted FTS entries leave delete markers in the index segments until a merge: merge now, so the index keeps no term of them.
    if (purged.length) db.prepare("INSERT INTO kn_documents_fts(kn_documents_fts) VALUES ('optimize')").run();
    log(
      db,
      now,
      actor,
      "person_forgotten",
      operator,
      input.person,
      `identities ${counts.identities}, edges ${counts.edges}, proposals ${counts.proposals}, history ${counts.history}; documents matched ${found.size}, purged ${purged.length}, refused ${refused.length}`,
    );
    const all = sorted(found);
    return {
      person: input.person,
      operator,
      deleted: { relationships: counts },
      scan: { terms: terms.length, skippedShort, truncated: all.length > MATCH_LIMIT },
      matched: all.slice(0, MATCH_LIMIT),
      purged,
      refused,
    };
  });
}

/** The engine helper (`ctx.callServiceHelper("gbrain", path, body)`), as the queue needs it. */
export type PurgeHelper = (path: string, body: { source: string; document: string }) => Promise<unknown>;

/** A short label of a failed helper call for the queue row (code only, never a message: it can carry upstream text). */
function failureLabel(error: unknown): string {
  const e = error && typeof error === "object" ? (error as { code?: unknown; details?: { cause?: unknown } }) : {};
  const code = typeof e.code === "string" ? e.code.replace(/[^A-Za-z0-9_]/gu, "").slice(0, 48) : "purge_failed";
  const cause = typeof e.details?.cause === "string" && /^[A-Za-z][A-Za-z0-9_]{1,47}$/u.test(e.details.cause) ? `:${e.details.cause}` : "";
  return `${code || "purge_failed"}${cause}`;
}

/**
 * Purge queued engine pages through the helper: due rows (or only `documents`, due or not). A row is deleted when the helper
 * answers `purged` or `absent`; any other answer or error backs off (projection backoff, at most 1 h) and stays queued.
 */
export async function drainForgetQueue(db: Db, helper: PurgeHelper, now: number, documents?: readonly string[]): Promise<{ done: string[]; failed: string[] }> {
  const rows = documents
    ? documents.flatMap((id) => db.prepare("SELECT source_id, document_id, attempts FROM kn_forget_queue WHERE document_id = ?").all(id))
    : db.prepare("SELECT source_id, document_id, attempts FROM kn_forget_queue WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20").all(now);
  const done: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    const source = String(row.source_id);
    const document = String(row.document_id);
    try {
      const answer = (await helper("/purge-page", { source, document })) as { status?: unknown } | null;
      if (answer?.status !== "purged" && answer?.status !== "absent") throw Object.assign(new Error("unexpected helper answer"), { code: "purge_unconfirmed" });
      db.prepare("DELETE FROM kn_forget_queue WHERE source_id = ? AND document_id = ?").run(source, document);
      done.push(document);
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      db.prepare("UPDATE kn_forget_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE source_id = ? AND document_id = ?").run(attempts, now + backoffMs(attempts), failureLabel(error), source, document);
      failed.push(document);
    }
  }
  return { done, failed };
}
