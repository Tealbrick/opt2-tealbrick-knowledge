// Settings page (C296, Martin): the memory engine and its health, the model provider and whether its keys are set (never
// a value), embedding status, the engine capabilities and the memory areas. Read-only: the engine is fixed at install and
// changed in Portal; keys are entered only on the bridge key page.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Choices, Notice, Table, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { errText, PageHead } from "./common.tsx";

interface Choice {
  value: string;
  label: string;
  note?: string;
  disabled?: boolean;
}

interface SettingsOverview {
  engine: { configured: string; running: boolean; choices: Choice[]; state: string; detail: string[]; attention: { code: string; reason: string } | null; version: string | null };
  research: boolean;
  models: { provider: string; chatModel: string; embeddingProvider: string; embeddingModel: string; keys: string[] };
  documents: { total: number; inEngine: number; waiting: number; failed: number };
  embeddings: { chunks: number | null; embedded: number | null; pages: number | null; readiness: { state: string; reason: string | null } | null; error: string | null };
  tools: { offered: number | null; error: string | null; surface: string | null };
  capabilities: { id: string; label: string; state: "on" | "off" | "unknown"; reason: string }[];
  areas: { id: string; label: string; kind: string; engineReady: boolean; documents: number; ready: number; pending: number; failed: number }[];
}

interface KeyRow {
  name: string;
  present: boolean;
}

const PROVIDERS: Record<string, string> = { openai: "OpenAI", google: "Google Gemini", anthropic: "Anthropic (with OpenAI embeddings)" };

function engineTag(o: SettingsOverview["engine"]) {
  if (!o.running || o.attention?.code === "engine_missing") return <Tag status="needs-you">not running</Tag>;
  if (o.attention) return <Tag status="needs-you">needs attention</Tag>;
  if (o.state === "ok") return <Tag status="live">working</Tag>;
  return <Tag status="busy">starting</Tag>;
}

const onOff = (state: "on" | "off" | "unknown") => (state === "on" ? <Tag status="live">on</Tag> : state === "off" ? <Tag>off</Tag> : <Tag status="busy">unknown</Tag>);

export function Settings() {
  const [data, setData] = useState<SettingsOverview | null>(null);
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    callOp<SettingsOverview>("settings_overview", {})
      .then(setData)
      .catch((e: unknown) => setError(errText(e)));
    callOp<KeyRow[] | { keys: KeyRow[] }>("tb.keys_status", {})
      .then((r) => setKeys(Array.isArray(r) ? r : (r.keys ?? [])))
      .catch(() => setKeys(null));
  }, []);
  useEffect(load, [load]);
  const keyState = (name: string) => {
    const row = keys?.find((k) => k.name === name);
    if (!row) return <Tag status="busy">unknown</Tag>;
    return row.present ? <Tag status="live">set</Tag> : <Tag status="needs-you">missing</Tag>;
  };
  return (
    <section className="app-page" aria-label="Settings">
      <PageHead title="Settings" />
      <div className="toolbar">
        <Button onClick={load}>Refresh</Button>
      </div>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {!data ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading settings.
          </p>
        )
      ) : (
        <div className="tb-stack">
          <section className="tb-stack" aria-label="Memory engine">
            <h2>Memory engine</h2>
            <Choices label="Memory engine" value={data.engine.configured} onChange={() => undefined} options={data.engine.choices.map((c) => ({ value: c.value, title: c.label, ...(c.disabled && c.note ? { note: c.note } : {}), disabled: true }))} />
            <p>
              Status: {engineTag(data.engine)}
              {data.engine.version ? <span className="tb-soft"> GBrain {data.engine.version}</span> : null}
            </p>
            {data.engine.attention ? <Notice tone="needs-you">{data.engine.attention.reason}</Notice> : null}
            <p className="tb-soft kn-measure">The engine is chosen when the app is installed. You change it in Portal, in the app settings.</p>
          </section>

          <section className="tb-stack" aria-label="Model provider">
            <h2>Model provider</h2>
            <Table>
              <tbody>
                <tr>
                  <td>Provider</td>
                  <td className="strong">{PROVIDERS[data.models.provider] ?? data.models.provider}</td>
                </tr>
                <tr>
                  <td>Embeddings</td>
                  <td className="mono">
                    {data.models.embeddingProvider}:{data.models.embeddingModel}
                  </td>
                </tr>
                {data.models.keys.map((name) => (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td>{keyState(name)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="tb-soft kn-measure">Keys are entered only on the bridge key page (open it from Portal). Knowledge never shows a key value.</p>
          </section>

          <section className="tb-stack" aria-label="Embeddings">
            <h2>Embeddings</h2>
            <Table>
              <tbody>
                <tr>
                  <td>Documents in the memory engine</td>
                  <td className="num">
                    {data.documents.inEngine} of {data.documents.total}
                    {data.documents.waiting ? <span className="tb-soft"> ({data.documents.waiting} waiting)</span> : null}
                    {data.documents.failed ? <Tag status="needs-you">{data.documents.failed} failed</Tag> : null}
                  </td>
                </tr>
                <tr>
                  <td>Text pieces with embeddings</td>
                  <td className="num">{data.embeddings.chunks === null ? <span className="tb-soft">not reported</span> : `${data.embeddings.embedded ?? 0} of ${data.embeddings.chunks}`}</td>
                </tr>
                <tr>
                  <td>Search by meaning</td>
                  <td>{data.embeddings.readiness ? onOff(data.embeddings.readiness.state === "ok" ? "on" : "off") : onOff("unknown")}</td>
                </tr>
              </tbody>
            </Table>
          </section>

          <section className="tb-stack" aria-label="Engine capabilities">
            <h2>Engine capabilities</h2>
            <p className="tb-soft kn-measure">
              {data.tools.offered === null ? "The engine tools could not be read." : `${data.tools.offered} engine tools are offered to agents (within each agent's access).`}
            </p>
            <Table>
              <tbody>
                {data.capabilities.map((c) => (
                  <tr key={c.id}>
                    <td className="strong">{c.label}</td>
                    <td>{onOff(c.state)}</td>
                    <td className="tb-soft">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="tb-soft">Research notebooks: {data.research ? "on" : "off"}</p>
          </section>

          <section className="tb-stack" aria-label="Memory areas">
            <h2>Memory areas</h2>
            <Table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Engine source</th>
                  <th>Documents</th>
                  <th>In memory</th>
                  <th>Waiting</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {data.areas.map((a) => (
                  <tr key={a.id}>
                    <td className="strong">{a.label}</td>
                    <td>{a.engineReady ? <Tag status="live">ready</Tag> : <Tag status="busy">preparing</Tag>}</td>
                    <td className="num">{a.documents}</td>
                    <td className="num">{a.ready}</td>
                    <td className="num">{a.pending}</td>
                    <td className="num">{a.failed ? <Tag status="needs-you">{a.failed}</Tag> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
        </div>
      )}
    </section>
  );
}
