// Foundry feed (C373): Knowledge's own documents → the deep service. No new ingest path (C322(6) "ingest = Observer
// only"): Observer delivers documents into Knowledge (document_create/update); this job hands the documents of the areas
// the owner selects (default: the company area) to foundry, one foundry workspace per area.
//
// - `kind:table` documents (CSV with a header line) become foundry datasets: one dataset per `table:<name>` tag (the pages
//   of one table merge), or one per document without that tag. Every row carries `_knowledge_document` (its source).
// - Every other document becomes one row of the area's `knowledge_documents` dataset (title, tags, version, body excerpt).
// - Idempotent on (document id, version): a dataset is re-sent only when its (id, version) list changed.
// - A table whose documents are all gone gets an empty tombstone snapshot (foundry has no dataset delete; older snapshot
//   files stay on the deep volume until a dataset delete exists upstream); a deleted text document leaves the next build.
import { createHash } from "node:crypto";
import type { Db } from "@opt2-tealbrick/spec/sdk";
import type { Areas } from "../../areas.ts";
import { SHARED_AREA_ID } from "../../ids.ts";
import { CsvError, parseCsvPages } from "./csv.ts";
import { type DeepClient, type DeepDataset, DeepError } from "./client.ts";

export const DEEP_AREAS_KEY = "deep_areas";
export const TABLE_TAG = "kind:table";
export const TABLE_NAME_PREFIX = "table:";
export const TEXT_DATASET = "knowledge_documents";
/** The column every table row carries: the Knowledge document it came from (citations). */
export const SOURCE_COLUMN = "_knowledge_document";
export const BODY_EXCERPT = 8000;
const TEXT_ROWS_MAX = 10_000;

type Row = Record<string, unknown>;

export interface DeepTableRow {
  area: string;
  key: string;
  datasetId: string | null;
  name: string;
  documentIds: string[];
  state: "synced" | "failed" | "deleted";
  rows: number;
  lastError: string | null;
  syncedAt: number | null;
}

export interface DeepAreaRow {
  area: string;
  workspaceId: string;
  textDatasetId: string | null;
  syncedAt: number | null;
  lastError: string | null;
}

export interface SyncReport {
  areas: { area: string; ok: boolean; tables: number; sent: number; error?: string }[];
}

interface DocRow {
  id: string;
  title: string;
  tags: string[];
  version: number;
}

const digest = (docs: readonly DocRow[]) =>
  createHash("sha256")
    .update(
      docs
        .map((d) => `${d.id}:${d.version}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");

const tagsOf = (raw: unknown): string[] => {
  try {
    const value = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
};

/** The table a `kind:table` document belongs to: its `table:<name>` tag, else the document alone. */
export function tableKey(doc: { id: string; tags: readonly string[] }): string {
  const named = doc.tags.find((t) => t.startsWith(TABLE_NAME_PREFIX) && t.length > TABLE_NAME_PREFIX.length);
  return named ?? `doc:${doc.id}`;
}

export class DeepSync {
  private running: Promise<SyncReport> | null = null;
  private again = false;

  private readonly db: Db;
  private readonly areas: Areas;
  private readonly deep: DeepClient;
  private readonly now: () => number;

  constructor(db: Db, areas: Areas, deep: DeepClient, now: () => number = Date.now) {
    this.db = db;
    this.areas = areas;
    this.deep = deep;
    this.now = now;
  }

  /** The areas the owner selected (default: the company area); unknown ids are dropped. */
  selectedAreas(): string[] {
    const row = this.db.prepare("SELECT value FROM kn_state WHERE key = ?").get(DEEP_AREAS_KEY);
    let ids: string[] = [SHARED_AREA_ID];
    if (row) {
      try {
        const value = JSON.parse(String(row.value));
        if (Array.isArray(value)) ids = value.map(String);
      } catch {
        // a broken value falls back to the default
      }
    }
    return ids.filter((id) => this.areas.get(id) !== null);
  }

  setSelectedAreas(ids: readonly string[]): string[] {
    const known = [...new Set(ids)].filter((id) => this.areas.get(id) !== null);
    this.db.prepare("INSERT INTO kn_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(DEEP_AREAS_KEY, JSON.stringify(known));
    return known;
  }

  area(id: string): DeepAreaRow | null {
    const row = this.db.prepare("SELECT * FROM kn_deep_areas WHERE area_id = ?").get(id);
    return row ? { area: String(row.area_id), workspaceId: String(row.workspace_id), textDatasetId: (row.text_dataset_id as string | null) ?? null, syncedAt: (row.synced_at as number | null) ?? null, lastError: (row.last_error as string | null) ?? null } : null;
  }

  tables(area: string): DeepTableRow[] {
    return this.db
      .prepare("SELECT * FROM kn_deep_tables WHERE area_id = ? ORDER BY name")
      .all(area)
      .map((row) => ({
        area: String(row.area_id),
        key: String(row.table_key),
        datasetId: (row.dataset_id as string | null) ?? null,
        name: String(row.name),
        documentIds: tagsOf(row.document_ids),
        state: row.state as DeepTableRow["state"],
        rows: Number(row.rows ?? 0),
        lastError: (row.last_error as string | null) ?? null,
        syncedAt: (row.synced_at as number | null) ?? null,
      }));
  }

  /** One sync pass over every selected area (single flight: a call during a pass runs one more pass after it). */
  run(): Promise<SyncReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let report: SyncReport;
      do {
        this.again = false;
        report = { areas: [] };
        for (const id of this.selectedAreas()) report.areas.push(await this.syncArea(id));
      } while (this.again);
      return report;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private docs(area: string): DocRow[] {
    return this.db
      .prepare("SELECT id, title, tags, version FROM kn_documents WHERE area_id = ? AND deleted_at IS NULL ORDER BY title, id")
      .all(area)
      .map((row) => ({ id: String(row.id), title: String(row.title), tags: tagsOf(row.tags), version: Number(row.version) }));
  }

  private bodies(ids: readonly string[]): Map<string, Row> {
    const out = new Map<string, Row>();
    const statement = this.db.prepare("SELECT id, title, body, tags, version, updated_at, source_ref FROM kn_documents WHERE id = ? AND deleted_at IS NULL");
    for (const id of ids) {
      const row = statement.get(id);
      if (row) out.set(id, row);
    }
    return out;
  }

  private async workspace(area: string): Promise<DeepAreaRow> {
    const known = this.area(area);
    if (known) return known;
    const label = this.areas.get(area)?.label ?? area;
    const workspaceId = await this.deep.createWorkspace(`Knowledge: ${label}`);
    this.db.prepare("INSERT INTO kn_deep_areas (area_id, workspace_id, updated_at) VALUES (?, ?, ?)").run(area, workspaceId, this.now());
    return this.area(area) as DeepAreaRow;
  }

  /** A snapshot whose columns changed waits for review in foundry; Knowledge's documents are the source, so accept it. */
  private async settle(workspace: string, dataset: DeepDataset): Promise<DeepDataset> {
    return dataset.data?.pendingVersion ? this.deep.acceptVersion(workspace, dataset.id) : dataset;
  }

  private async syncArea(area: string): Promise<SyncReport["areas"][number]> {
    let sent = 0;
    let tables = 0;
    try {
      const ws = await this.workspace(area);
      const docs = this.docs(area);
      const groups = new Map<string, DocRow[]>();
      const text: DocRow[] = [];
      for (const doc of docs) {
        if (!doc.tags.includes(TABLE_TAG)) {
          text.push(doc);
          continue;
        }
        const key = tableKey(doc);
        groups.set(key, [...(groups.get(key) ?? []), doc]);
      }
      const known = new Map(this.tables(area).map((t) => [t.key, t]));
      for (const [key, pages] of groups) {
        tables++;
        const hash = digest(pages);
        const before = known.get(key);
        if (before && before.state !== "deleted" && this.sourceDigest(area, key) === hash) continue;
        const name = key.startsWith(TABLE_NAME_PREFIX) ? key.slice(TABLE_NAME_PREFIX.length).slice(0, 100) : (pages[0]?.title ?? "table").slice(0, 100);
        const bodies = this.bodies(pages.map((p) => p.id));
        let rows: Row[];
        try {
          const live = pages.filter((p) => bodies.has(p.id));
          const parsed = parseCsvPages(live.map((p) => String(bodies.get(p.id)?.body ?? "")));
          rows = parsed.rows.map((row, i) => ({ ...row, [SOURCE_COLUMN]: live[parsed.pages[i] as number]?.id ?? null }));
          if (!rows.length) throw new CsvError("the table has no rows");
        } catch (error) {
          if (!(error instanceof CsvError)) throw error;
          this.saveTable(area, key, { datasetId: before?.datasetId ?? null, name, documentIds: pages.map((p) => p.id), digest: hash, state: "failed", rows: 0, error: error.message });
          continue;
        }
        const dataset = await this.settle(ws.workspaceId, await this.deep.ingest(ws.workspaceId, name, rows, before?.datasetId ?? undefined));
        if (before?.state === "deleted") await this.deep.describeDataset(ws.workspaceId, dataset.id, "").catch(() => undefined);
        this.saveTable(area, key, { datasetId: dataset.id, name, documentIds: pages.map((p) => p.id), digest: hash, state: "synced", rows: rows.length, error: null });
        sent++;
      }
      // tables whose documents are all gone (deleted, moved, or no longer tagged as a table)
      for (const [key, before] of known) {
        if (groups.has(key) || before.state === "deleted") continue;
        if (before.datasetId) {
          await this.settle(ws.workspaceId, await this.deep.ingest(ws.workspaceId, before.name, [{ removed: true }], before.datasetId));
          await this.deep.describeDataset(ws.workspaceId, before.datasetId, "Removed: its documents were deleted in Knowledge.").catch(() => undefined);
          sent++;
        }
        this.saveTable(area, key, { datasetId: before.datasetId, name: before.name, documentIds: [], digest: null, state: "deleted", rows: 0, error: null });
      }
      // text documents: one dataset per area, rebuilt when the (id, version) list changed
      const textHash = digest(text);
      const current = this.db.prepare("SELECT text_digest FROM kn_deep_areas WHERE area_id = ?").get(area);
      if (current?.text_digest !== textHash && (text.length || ws.textDatasetId)) {
        const bodies = this.bodies(text.slice(0, TEXT_ROWS_MAX).map((d) => d.id));
        const rows: Row[] = [...bodies.values()].map((row) => ({
          document_id: String(row.id),
          title: String(row.title),
          tags: tagsOf(row.tags).join(", "),
          version: Number(row.version),
          updated_at: new Date(Number(row.updated_at)).toISOString(),
          source: (row.source_ref as string | null) ?? `knowledge:document/${String(row.id)}`,
          body: String(row.body ?? "").slice(0, BODY_EXCERPT),
        }));
        // foundry needs one row: an emptied area keeps its dataset with one blank row (document_id "")
        if (!rows.length) rows.push({ document_id: "", title: "", tags: "", version: 0, updated_at: "", source: "", body: "" });
        const dataset = await this.settle(ws.workspaceId, await this.deep.ingest(ws.workspaceId, TEXT_DATASET, rows, ws.textDatasetId ?? undefined));
        this.db.prepare("UPDATE kn_deep_areas SET text_dataset_id = ?, text_digest = ?, updated_at = ? WHERE area_id = ?").run(dataset.id, textHash, this.now(), area);
        sent++;
      }
      this.db.prepare("UPDATE kn_deep_areas SET synced_at = ?, last_error = NULL, updated_at = ? WHERE area_id = ?").run(this.now(), this.now(), area);
      return { area, ok: true, tables, sent };
    } catch (error) {
      const code = error instanceof DeepError ? error.code : "deep_sync_failed";
      this.db.prepare("UPDATE kn_deep_areas SET last_error = ?, updated_at = ? WHERE area_id = ?").run(code, this.now(), area);
      return { area, ok: false, tables, sent, error: code };
    }
  }

  private sourceDigest(area: string, key: string): string | null {
    const row = this.db.prepare("SELECT source_digest FROM kn_deep_tables WHERE area_id = ? AND table_key = ?").get(area, key);
    return (row?.source_digest as string | null) ?? null;
  }

  private saveTable(area: string, key: string, t: { datasetId: string | null; name: string; documentIds: string[]; digest: string | null; state: DeepTableRow["state"]; rows: number; error: string | null }) {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO kn_deep_tables (area_id, table_key, dataset_id, name, document_ids, source_digest, state, rows, last_error, synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (area_id, table_key) DO UPDATE SET dataset_id = excluded.dataset_id, name = excluded.name, document_ids = excluded.document_ids,
           source_digest = excluded.source_digest, state = excluded.state, rows = excluded.rows, last_error = excluded.last_error,
           synced_at = excluded.synced_at, updated_at = excluded.updated_at`,
      )
      .run(area, key, t.datasetId, t.name, JSON.stringify(t.documentIds), t.digest, t.state, t.rows, t.error, t.state === "failed" ? null : at, at);
  }
}
