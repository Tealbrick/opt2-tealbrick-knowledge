// Recall page: ask memory a question the way an agent would, optionally within one area. A result opens in Library.
import { Button, EmptyState, Field, Notice, Swatch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type FormEvent, useState } from "react";
import { AreaPicker } from "./area-filter.tsx";
import { ErrorNotice, errText, run, useOverview } from "./common.tsx";

interface RecallResponse {
  results: { documentId: string; title: string; text: string; areas: string[] }[];
  areas: { area: string; ok: boolean; via: "engine" | "keyword"; error?: string }[];
  degraded: boolean;
}

export function Recall({ onOpen }: { onOpen: (documentId: string) => void }) {
  const { areas, error: overviewError } = useOverview();
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("");
  const [answer, setAnswer] = useState<RecallResponse | null>(null);
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (id: string) => areas?.find((a) => a.id === id)?.label ?? id;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await run<RecallResponse>("library_recall", { query: text, area: area || undefined, limit: 20 }));
      setAsked(text);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const failed = answer?.areas.filter((a) => !a.ok) ?? [];
  return (
    <div className="tb-stack kn-recall">
      <p className="tb-soft">Search memory the way an agent does. Results come from the memory engine; when it’s not ready, a keyword search answers instead.</p>
      <ErrorNotice error={overviewError ?? error} />
      <form className="toolbar kn-form" onSubmit={(event) => void submit(event)}>
        <div className="kn-grow">
          <Field label="Question or keywords">
            <TextInput value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
        </div>
        <AreaPicker page="recall" label="Memory area" areas={areas ?? []} value={area} onChange={setArea} extra={[{ value: "", label: "All areas" }]} />
        <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search memory"}
        </Button>
      </form>
      {answer ? (
        <div className="tb-stack" aria-live="polite">
          {answer.degraded ? <Notice tone="needs-you">Degraded: keyword search only. The memory engine didn’t answer for every area.</Notice> : null}
          {failed.map((a) => (
            <Notice key={a.area} tone="needs-you">
              {label(a.area)}: {a.error ?? "no answer"}
            </Notice>
          ))}
          {answer.results.length ? (
            <div className="ruled">
              {answer.results.map((r) => (
                <div key={`${r.documentId}`} className="item">
                  <Swatch />
                  <h3>
                    <button type="button" className="tb-link" onClick={() => onOpen(r.documentId)}>
                      {r.title || "Untitled"}
                    </button>
                  </h3>
                  <p className="kn-clip">{r.text}</p>
                  <span className="meta">
                    {r.areas.map((id) => (
                      <Tag key={id}>{label(id)}</Tag>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title={`Nothing in memory matches “${asked}”.`} />
          )}
        </div>
      ) : null}
    </div>
  );
}
