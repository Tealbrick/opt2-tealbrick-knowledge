// Projection worker: drains the outbox (kn_projection) into the memory engine.
// Re-reads canonical state at projection time (a queued stale write never resurrects an edited or
// deleted document), skips unchanged content by hash, backs off on failure, serialises per process.
import type { Db } from "@opt2-tealbrick/spec/sdk";
import type { Areas } from "./areas.ts";
import { contentHash, type DocumentStore, documentMarkdown } from "./store/documents.ts";

export interface ProjectionTarget {
  projectDocument(sourceId: string, documentId: string, markdown: string): Promise<void>;
  removeDocument(sourceId: string, documentId: string): Promise<void>;
}

const MAX_ATTEMPTS = 12;
/** INC-20261106-01: boot retries of a row that failed again (each one is up to MAX_ATTEMPTS more writes). */
export const MAX_BOOT_RETRIES = 3;
const BATCH = 20;

export interface ProjectionKey {
  area: string;
  document: string;
}

/** Logger for projection failures: fields are ids, counts and an error code, never document content. */
export type ProjectionLog = (msg: string, fields: Record<string, string | number>) => void;

/**
 * The error code of a projection failure, safe to log: the engine's code (a vocabulary identifier such as
 * `revision_required`), else the error's own code or name. Never the message (it may quote content).
 */
export function failureCode(error: unknown): string {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  for (const key of ["upstreamCode", "code"]) {
    const value = record[key];
    if (typeof value === "string" && /^[a-z0-9_]{1,64}$/u.test(value)) return value;
  }
  return error instanceof Error && /^[A-Za-z]{1,64}$/u.test(error.name) ? error.name : "unknown";
}

/**
 * One drain in flight per database, shared by every Projector on it: bind() may build a new one while a pass runs, and two
 * passes wrote the same rows twice. A drain asked for while a pass runs (a new write's kick) runs one more pass after it.
 */
const drains = new WeakMap<Db, { again: boolean; done: Promise<number> }>();

export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(attempts - 1, 0), 3_600_000);
}

export class Projector {
  private readonly db: Db;
  private readonly store: DocumentStore;
  private readonly areas: Areas;
  private readonly target: ProjectionTarget;
  private readonly now: () => number;
  /** INC-20261106-01: every failed attempt is logged (it was silent). */
  log: ProjectionLog | null = null;

  constructor(db: Db, store: DocumentStore, areas: Areas, target: ProjectionTarget, now: () => number = Date.now) {
    this.db = db;
    this.store = store;
    this.areas = areas;
    this.target = target;
    this.now = now;
  }

  /** Run one pass (concurrent callers share it, across Projector instances on the same db). Returns the rows processed. */
  drain(): Promise<number> {
    const current = drains.get(this.db);
    if (current) {
      current.again = true;
      return current.done;
    }
    const entry: { again: boolean; done: Promise<number> } = { again: false, done: Promise.resolve(0) };
    entry.done = (async () => {
      let rows = 0;
      try {
        do {
          entry.again = false;
          rows += await this.pass();
        } while (entry.again);
      } finally {
        // in the same tick as the last `again` check: a drain asked for after it starts a new entry (no lost kick)
        drains.delete(this.db);
      }
      return rows;
    })();
    drains.set(this.db, entry);
    return entry.done;
  }

  private async pass(): Promise<number> {
    const due = this.db
      .prepare("SELECT area_id, document_id, action, content_hash, attempts, updated_at FROM kn_projection WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
      .all(this.now(), BATCH);
    for (const row of due) {
      const areaId = String(row.area_id);
      const documentId = String(row.document_id);
      const area = this.areas.get(areaId);
      if (!area?.sourceReady) {
        this.fail(areaId, documentId, Number(row.attempts), "area_not_ready", "area_not_ready");
        continue;
      }
      try {
        const doc = this.store.getDocument(documentId);
        if (!doc || doc.area !== areaId || row.action === "delete") {
          await this.target.removeDocument(area.sourceId, documentId);
          this.done(areaId, documentId, null, Number(row.updated_at));
        } else {
          const markdown = documentMarkdown(doc);
          const hash = contentHash(markdown);
          // content_hash = the last successfully projected content (the outbox keeps it across re-queues).
          if (row.content_hash !== hash) await this.target.projectDocument(area.sourceId, documentId, markdown);
          this.done(areaId, documentId, hash, Number(row.updated_at));
        }
      } catch (error) {
        this.fail(areaId, documentId, Number(row.attempts), error instanceof Error ? error.message.slice(0, 200) : "projection_failed", failureCode(error));
      }
    }
    return due.length;
  }

  /** Marks ready only if the row was not re-queued meanwhile (a newer change keeps it pending). */
  private done(areaId: string, documentId: string, hash: string | null, queuedAt: number) {
    this.db
      .prepare("UPDATE kn_projection SET state = 'ready', content_hash = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE area_id = ? AND document_id = ? AND updated_at = ?")
      .run(hash, this.now(), areaId, documentId, queuedAt);
  }

  /**
   * `attempts` counts every failed attempt since the last success or change of the document, across boots (INC-20261106-01):
   * a run of MAX_ATTEMPTS ends in `failed`; the boot retry starts the next run without resetting the count, so the cap
   * needs no schema change (a rollback to 0.1.36 opens the same database).
   */
  private fail(areaId: string, documentId: string, attempts: number, error: string, code: string) {
    const next = attempts + 1;
    const inRun = ((next - 1) % MAX_ATTEMPTS) + 1;
    const state = inRun >= MAX_ATTEMPTS ? "failed" : "pending";
    const retryMs = backoffMs(inRun);
    this.db
      .prepare("UPDATE kn_projection SET attempts = ?, state = ?, next_attempt_at = ?, last_error = ? WHERE area_id = ? AND document_id = ?")
      .run(next, state, this.now() + retryMs, `${code}: ${error}`.slice(0, 300), areaId, documentId);
    this.log?.(state === "failed" ? "projection gave up" : "projection failed", {
      area: areaId,
      document: documentId,
      attempt: inRun,
      maxAttempts: MAX_ATTEMPTS,
      bootRetry: Math.floor((next - 1) / MAX_ATTEMPTS),
      state,
      code,
      ...(state === "pending" ? { retryInS: Math.round(retryMs / 1000) } : {}),
    });
  }

  /** After a restore the engine may hold an older or newer state: re-project every live document and re-delete tombstones. */
  requeueAll(): number {
    const live = this.db
      .prepare(
        `INSERT INTO kn_projection (area_id, document_id, action, content_hash, state, attempts, next_attempt_at, last_error, updated_at)
         SELECT area_id, id, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END, NULL, 'pending', 0, 0, NULL, ? FROM kn_documents WHERE true
         ON CONFLICT (area_id, document_id) DO UPDATE SET action = excluded.action, content_hash = NULL, state = 'pending', attempts = 0, next_attempt_at = 0, last_error = NULL, updated_at = max(excluded.updated_at, kn_projection.updated_at + 1)`,
      )
      .run(this.now());
    return live.changes;
  }

  /**
   * Re-queue failed rows at boot (e.g. after an engine outage) — keeps their content and their attempt count.
   * INC-20261106-01: at most MAX_BOOT_RETRIES times per row (it was every boot, 12 writes each); a row past that stays
   * failed (and counted in Settings) until its document changes again or a restore re-queues everything.
   */
  retryFailed(): { retried: number; stillFailed: number; rows: ProjectionKey[] } {
    const limit = MAX_ATTEMPTS * (MAX_BOOT_RETRIES + 1);
    const rows = this.db
      .prepare("SELECT area_id, document_id FROM kn_projection WHERE state = 'failed' AND attempts < ?")
      .all(limit)
      .map((row) => ({ area: String(row.area_id), document: String(row.document_id) }));
    const retried = this.db.prepare("UPDATE kn_projection SET state = 'pending', next_attempt_at = 0 WHERE state = 'failed' AND attempts < ?").run(limit).changes;
    const stillFailed = Number(this.db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'failed'").get()?.n ?? 0);
    return { retried, stillFailed, rows };
  }

  /**
   * INC-20261106-01 catch-up: before 0.1.37 a delete never reached the engine (the revision read missed the page and the
   * row was marked done), so pages of deleted documents may remain. Queue a delete for every deleted document whose row
   * is settled; a row still pending is left alone. Idempotent: a page that is already gone is "absent" (one read).
   */
  requeueDeletedPages(): ProjectionKey[] {
    const rows = this.db
      .prepare(
        `SELECT d.area_id, d.id FROM kn_documents d LEFT JOIN kn_projection p ON p.area_id = d.area_id AND p.document_id = d.id
         WHERE d.deleted_at IS NOT NULL AND (p.state IS NULL OR p.state <> 'pending')`,
      )
      .all()
      .map((row) => ({ area: String(row.area_id), document: String(row.id) }));
    const queue = this.db.prepare(
      `INSERT INTO kn_projection (area_id, document_id, action, content_hash, state, attempts, next_attempt_at, last_error, updated_at)
       VALUES (?, ?, 'delete', NULL, 'pending', 0, 0, NULL, ?)
       ON CONFLICT (area_id, document_id) DO UPDATE SET action = 'delete', state = 'pending', attempts = 0, next_attempt_at = 0, last_error = NULL, updated_at = max(excluded.updated_at, kn_projection.updated_at + 1)`,
    );
    this.db.transaction(() => {
      for (const row of rows) queue.run(row.area, row.document, this.now());
    });
    return rows;
  }

  /** States of the given rows (catch-up outcome counts). */
  outcome(rows: readonly ProjectionKey[]): { ok: number; failed: number; pending: number } {
    const read = this.db.prepare("SELECT state FROM kn_projection WHERE area_id = ? AND document_id = ?");
    const out = { ok: 0, failed: 0, pending: 0 };
    for (const row of rows) {
      const state = read.get(row.area, row.document)?.state;
      if (state === "ready") out.ok++;
      else if (state === "failed") out.failed++;
      else if (state === "pending") out.pending++;
    }
    return out;
  }

  status(): { area: string; pending: number; ready: number; failed: number }[] {
    return this.db
      .prepare(
        `SELECT area_id, SUM(state = 'pending') AS pending, SUM(state = 'ready') AS ready, SUM(state = 'failed') AS failed
         FROM kn_projection GROUP BY area_id ORDER BY area_id`,
      )
      .all()
      .map((row) => ({ area: String(row.area_id), pending: Number(row.pending), ready: Number(row.ready), failed: Number(row.failed) }));
  }
}
