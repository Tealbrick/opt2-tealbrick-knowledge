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
      do {
        entry.again = false;
        rows += await this.pass();
      } while (entry.again);
      return rows;
    })().finally(() => drains.delete(this.db));
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
      .prepare("UPDATE kn_projection SET state = 'ready', content_hash = ?, attempts = 0, cycles = 0, last_error = NULL, updated_at = ? WHERE area_id = ? AND document_id = ? AND updated_at = ?")
      .run(hash, this.now(), areaId, documentId, queuedAt);
  }

  private fail(areaId: string, documentId: string, attempts: number, error: string, code: string) {
    const next = attempts + 1;
    const state = next >= MAX_ATTEMPTS ? "failed" : "pending";
    const retryMs = backoffMs(next);
    this.db
      .prepare("UPDATE kn_projection SET attempts = ?, state = ?, next_attempt_at = ?, last_error = ? WHERE area_id = ? AND document_id = ?")
      .run(next, state, this.now() + retryMs, `${code}: ${error}`.slice(0, 300), areaId, documentId);
    this.log?.(state === "failed" ? "projection gave up" : "projection failed", {
      area: areaId,
      document: documentId,
      attempt: next,
      maxAttempts: MAX_ATTEMPTS,
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
   * Re-queue failed rows at boot (e.g. after an engine outage) — keeps their content. INC-20261106-01: at most
   * MAX_BOOT_RETRIES times per row; a row past that stays failed (and counted) until its document changes again.
   */
  retryFailed(): { retried: number; stillFailed: number } {
    const retried = this.db
      .prepare("UPDATE kn_projection SET state = 'pending', attempts = 0, next_attempt_at = 0, cycles = cycles + 1 WHERE state = 'failed' AND cycles < ?")
      .run(MAX_BOOT_RETRIES).changes;
    const stillFailed = Number(this.db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'failed'").get()?.n ?? 0);
    return { retried, stillFailed };
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
