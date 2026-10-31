// Agents & scopes: the kit's AccessEditor (C382): the defaults once, then only what differs, and a bulk editor.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { type AccessCell, type AccessChange, AccessEditor } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errText, LoadError } from "./common.tsx";
import type { Agent } from "./standard.tsx";

/** What this page needs of the memory areas (main.tsx useAreas). */
export interface ConfigureAreas {
  areas: { id: string; label: string; kind: "agent" | "shared" | "person" | "team" }[] | null;
  error: string | null;
  reload: () => void;
}

/** The levels of `scopes[].access` in tealbrick.manifest.json (test/ui-configure.test.ts compares them). */
export const AREA_LEVELS = [
  { id: "read", label: "Read" },
  { id: "contribute", label: "Read, add and edit" },
  { id: "read_write", label: "Read and write" },
];
/** `agentAreaId` of src/ids.ts, which a browser module cannot import (node:crypto beside it). test/ui-configure.test.ts compares them. */
export const ownAreaId = (agentId: string) => `agent-${agentId.replace(/^agt_/u, "").toLowerCase()}`;
/** `scopes[].defaultGrants` in the manifest: own → read_write, shared → read. */
export const areaDefault = (agent: string, area: { id: string; kind: string } | undefined): string | null => (area?.id === ownAreaId(agent) ? "read_write" : area?.kind === "shared" ? "read" : null);

type AgentRows = Agent & { access?: { type: string; instanceId: string; access: string }[] };
const loadAgentRows = async () => (await callOp<{ agents: AgentRows[] }>("tb.agents_list", {})).agents;
const cellsOf = (agents: readonly AgentRows[]): AccessCell[] => agents.flatMap((agent) => (agent.access ?? []).filter((row) => row.type === "area").map((row) => ({ agent: agent.id, scope: row.instanceId, level: row.access })));
const writeLevel = (change: AccessChange) => callOp("tb.scopes_set", { agent: change.agent, type: "area", id: change.scope, access: change.level });

/** Who may read or write which memory area: the kit's AccessEditor (C382). Shown inside the standard Agents & scopes page. */
export function Configure({ areas }: { areas: ConfigureAreas }) {
  const [agents, setAgents] = useState<AgentRows[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    loadAgentRows()
      .then(setAgents)
      .catch((e: unknown) => setLoadError(errText(e)));
  }, []);
  useEffect(load, [load]);
  // C373: person and team areas follow the Governance directory and the grants on the Access page, not per-agent rows here
  const columns = useMemo(() => (areas.areas ?? []).filter((area) => area.kind === "agent" || area.kind === "shared"), [areas.areas]);
  const byId = useMemo(() => new Map(columns.map((area) => [area.id, area])), [columns]);
  const defaultOf = useCallback((agent: string, area: string) => areaDefault(agent, byId.get(area)), [byId]);
  const cells = useMemo(() => cellsOf(agents ?? []), [agents]);
  const people = useMemo(() => (agents ?? []).map((a) => ({ id: a.id, name: a.name, note: a.status === "paused" ? "paused" : "" })), [agents]);
  const scopes = useMemo(() => columns.map((area) => ({ id: area.id, name: area.label })), [columns]);
  const reload = useCallback(async () => {
    const rows = await loadAgentRows();
    setAgents(rows);
    return cellsOf(rows);
  }, []);
  if (areas.error) return <LoadError message={areas.error} onRetry={areas.reload} />;
  if (loadError) return <LoadError message={loadError} onRetry={load} />;
  if (!areas.areas || !agents) return <p className="tb-soft" role="status">Loading memory areas.</p>;
  return (
    <AccessEditor
      agents={people}
      scopes={scopes}
      levels={AREA_LEVELS}
      scopeWord={{ one: "memory area", many: "memory areas" }}
      defaults={[
        { what: "Company, for every agent", level: "read" },
        { what: "Its own memory, for every agent", level: "read_write" },
        { what: "Another agent's memory", level: null },
      ]}
      cells={cells}
      defaultOf={defaultOf}
      write={writeLevel}
      reload={reload}
      explain={errText}
      storageKey="knowledge-access"
    />
  );
}
