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
const BATCH = 20;

export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(attempts - 1, 0), 3_600_000);
}

export class Projector {
  private running: Promise<number> | null = null;
  private readonly db: Db;
  private readonly store: DocumentStore;
  private readonly areas: Areas;
  private readonly target: ProjectionTarget;
  private readonly now: () => number;

  constructor(db: Db, store: DocumentStore, areas: Areas, target: ProjectionTarget, now: () => number = Date.now) {
    this.db = db;
    this.store = store;
    this.areas = areas;
    this.target = target;
    this.now = now;
  }

  /** Run one pass (concurrent callers share it). Returns the number of rows processed. */
  drain(): Promise<number> {
    if (!this.running) this.running = this.pass().finally(() => (this.running = null));
    return this.running;
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
        this.fail(areaId, documentId, Number(row.attempts), "area_not_ready");
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
        this.fail(areaId, documentId, Number(row.attempts), error instanceof Error ? error.message.slice(0, 200) : "projection_failed");
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

  private fail(areaId: string, documentId: string, attempts: number, error: string) {
    const next = attempts + 1;
    this.db
      .prepare("UPDATE kn_projection SET attempts = ?, state = ?, next_attempt_at = ?, last_error = ? WHERE area_id = ? AND document_id = ?")
      .run(next, next >= MAX_ATTEMPTS ? "failed" : "pending", this.now() + backoffMs(next), error, areaId, documentId);
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

  /** Re-queue failed rows (operator action after an engine outage) — keeps their content. */
  retryFailed(): number {
    return this.db.prepare("UPDATE kn_projection SET state = 'pending', attempts = 0, next_attempt_at = 0 WHERE state = 'failed'").run().changes;
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
