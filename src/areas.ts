// Memory areas: one per agent ("memory garden") plus the shared company area (DECISION-LOG C1).
// Scope instances of type "area" are created in the SDK scope store (the SDK applies the manifest
// defaultGrants: own → read_write, shared → read); this module maps each area to its engine resources
// and provisions them (GBrain source through the C6 helper, Open Notebook notebook when research is on).
import type { Db, ScopeStore } from "@opt2-tealbrick/spec/sdk";
import { agentAreaId, areaSourceId, SHARED_AREA_ID } from "./ids.ts";

export const AREA_SCOPE = "area";

export interface Area {
  id: string;
  kind: "agent" | "shared";
  label: string;
  agentId: string | null;
  sourceId: string;
  sourceReady: boolean;
  notebookId: string | null;
}

type Row = Record<string, unknown>;
const toArea = (row: Row): Area => ({
  id: String(row.id),
  kind: row.kind === "shared" ? "shared" : "agent",
  label: String(row.label),
  agentId: row.agent_id === null ? null : String(row.agent_id),
  sourceId: String(row.source_id),
  sourceReady: Number(row.source_ready) === 1,
  notebookId: row.notebook_id === null ? null : String(row.notebook_id),
});

/** Engine-side provisioning, injected so tests can run without the services. */
export interface AreaProvisioner {
  /** Create the GBrain source for an area (idempotent). */
  createSource?(sourceId: string, label: string): Promise<void>;
  /** Find or create the research notebook for an area; returns its id. */
  ensureNotebook?(areaId: string, label: string): Promise<string>;
}

export class Areas {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  get(id: string): Area | null {
    const row = this.db.prepare("SELECT * FROM kn_areas WHERE id = ?").get(id);
    return row ? toArea(row) : null;
  }

  list(): Area[] {
    return this.db.prepare("SELECT * FROM kn_areas ORDER BY kind DESC, label").all().map(toArea);
  }

  private insert(id: string, kind: "agent" | "shared", label: string, agentId: string | null): Area {
    this.db
      .prepare("INSERT INTO kn_areas (id, kind, label, agent_id, source_id, source_ready, notebook_id, created_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?) ON CONFLICT (id) DO NOTHING")
      .run(id, kind, label, agentId, areaSourceId(id), this.now());
    return this.get(id) as Area;
  }

  /** The company area exists from the first boot; every agent gets READ on it by default (C1). */
  async ensureShared(scopes: ScopeStore): Promise<Area> {
    const area = this.insert(SHARED_AREA_ID, "shared", "Company", null);
    await scopes.instances.create(AREA_SCOPE, area.id, area.label, { shared: true });
    return area;
  }

  /** Called from the SDK `agentAdded` event, before default grants are applied. */
  async ensureAgentArea(agent: { id: string; name: string }, scopes: ScopeStore): Promise<Area> {
    const id = agentAreaId(agent.id);
    const label = `${agent.name.slice(0, 40)} (own memory)`;
    const area = this.insert(id, "agent", label, agent.id);
    await scopes.instances.create(AREA_SCOPE, area.id, area.label, { ownerAgent: agent.id as `agt_${string}` });
    return area;
  }

  /** Provision engine resources for every area that lacks them; failures are retried on the next pass. */
  async provisionPending(provisioner: AreaProvisioner, log?: (msg: string, fields: Record<string, string>) => void): Promise<void> {
    for (const area of this.list()) {
      try {
        if (!area.sourceReady && provisioner.createSource) {
          await provisioner.createSource(area.sourceId, area.id);
          this.db.transaction(() => {
            this.db.prepare("UPDATE kn_areas SET source_ready = 1 WHERE id = ?").run(area.id);
            // Documents written before the engine source existed are projected right away; rows that gave up on
            // area_not_ready while the source was missing (C296) are re-armed too.
            this.db.prepare("UPDATE kn_projection SET state = 'pending', next_attempt_at = 0, attempts = 0 WHERE area_id = ? AND state IN ('pending', 'failed')").run(area.id);
          });
        }
        if (!area.notebookId && provisioner.ensureNotebook) {
          const notebookId = await provisioner.ensureNotebook(area.id, area.label);
          this.db.prepare("UPDATE kn_areas SET notebook_id = ? WHERE id = ?").run(notebookId, area.id);
        }
      } catch (error) {
        log?.("area provisioning failed; retrying later", { area: area.id, error: error instanceof Error ? error.message : "unknown" });
      }
    }
  }
}
