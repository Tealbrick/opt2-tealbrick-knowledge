// Memory status (the third Memory tab): one row per memory area, with a filter on the rows (C382 batch 4).
import { Button, Table, Tag } from "@opt2-tealbrick/ui";
import { useRowFilter } from "./area-filter.tsx";
import { LoadError } from "./common.tsx";

export interface AreaStatus {
  id: string;
  label: string;
  kind: "agent" | "shared" | "person" | "team";
  engineReady: boolean;
  researchReady: boolean;
  pending: number;
  ready: number;
  failed: number;
}

export function Status({ areas }: { areas: { areas: AreaStatus[] | null; error: string | null; reload: () => void } }) {
  // The filter reads the name, the kind and the engine state in words ("ready", "preparing"). The areas load in full.
  const { shown, bar } = useRowFilter("status", areas.areas ?? [], (a) => [a.label, a.id, a.kind, a.engineReady ? "ready" : "preparing"], "Filter the memory areas");
  if (areas.error) return <LoadError message={areas.error} onRetry={areas.reload} />;
  if (!areas.areas) return <p className="tb-soft" role="status">Loading memory areas.</p>;
  return (
    <div className="tb-stack">
      <div className="toolbar">
        <Button onClick={areas.reload}>Refresh</Button>
      </div>
      {bar}
      <Table>
        <thead>
          <tr>
            <th>Area</th>
            <th>Memory engine</th>
            <th>Documents in memory</th>
            <th>Waiting</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((area) => (
            <tr key={area.id}>
              <td className="strong">{area.label}</td>
              <td>{area.engineReady ? <Tag status="live">ready</Tag> : <Tag status="busy">preparing</Tag>}</td>
              <td className="num">{area.ready}</td>
              <td className="num">{area.pending}</td>
              <td className="num">{area.failed ? <Tag status="needs-you">{area.failed}</Tag> : 0}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
