// Research page: per area, the sources and notes held by the research engine. Read, and remove sources.
import { Button, Card, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { AreaPicker } from "./area-filter.tsx";
import { ConfirmDelete, dayMonth, ErrorNotice, errText, Loading, run, useOverview, when } from "./common.tsx";

interface ResearchResponse {
  enabled: boolean;
  sources: { id: string; title: string; updated: string | number }[];
  notes: { id: string; title: string; noteType: string; updated: string | number }[];
}
type Item =
  | { id: string; title: string; updated: string | number; fullText: string }
  | { id: string; title: string; updated: string | number; content: string };

const itemText = (item: Item) => ("fullText" in item ? item.fullText : item.content);

export function Research() {
  const { areas, error: overviewError } = useOverview();
  const [area, setArea] = useState("");
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [item, setItem] = useState<{ kind: "source" | "note"; value: Item } | null>(null);
  const [toDelete, setToDelete] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!area && areas?.length) setArea((areas.find((a) => a.researchReady) ?? areas[0])?.id ?? "");
  }, [areas, area]);

  const load = useCallback(async () => {
    if (!area) return;
    try {
      setData(await run<ResearchResponse>("library_research", { area }));
      setError(null);
    } catch (e) {
      setData(null);
      setError(errText(e));
    }
  }, [area]);
  useEffect(() => {
    setItem(null);
    setData(null);
    void load();
  }, [load]);

  const open = async (kind: "source" | "note", id: string) => {
    setError(null);
    try {
      setItem({ kind, value: await run<Item>("library_research_item", { area, id }) });
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeSource = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await run("library_research_source_delete", { area, id: toDelete.id });
      if (item?.kind === "source" && item.value.id === toDelete.id) setItem(null);
      setToDelete(null);
      await load();
    } catch (e) {
      setError(errText(e));
      setToDelete(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tb-stack">
      <div className="toolbar">
        <AreaPicker page="research" label="Research area" areas={areas ?? []} value={area} onChange={setArea} />
      </div>
      <ErrorNotice error={overviewError ?? error} />
      {area && !overviewError && !data && !error ? <Loading what="research" /> : null}
      {data && !data.enabled ? <Notice tone="needs-you">Research isn’t set up for this area.</Notice> : null}
      {data?.enabled ? (
        <div className="kn-two">
          <nav className="kn-pane" aria-label="Sources and notes">
            <h3 className="kn-sub">Sources</h3>
            {data.sources.length ? (
              data.sources.map((s) => (
                <div key={s.id} className="kn-pick-row">
                  <button type="button" className="kn-pick" aria-current={item?.kind === "source" && item.value.id === s.id ? "true" : undefined} onClick={() => void open("source", s.id)}>
                    <span>{s.title || "Untitled"}</span>
                    <span className="tb-hint">{dayMonth(s.updated)}</span>
                  </button>
                  <Button size="sm" variant="quiet" aria-label={`Remove source ${s.title || "Untitled"}`} onClick={() => setToDelete({ id: s.id, title: s.title })}>
                    Remove
                  </Button>
                </div>
              ))
            ) : (
              <p className="tb-hint kn-pane-note">No sources yet.</p>
            )}
            <h3 className="kn-sub">Notes</h3>
            {data.notes.length ? (
              data.notes.map((n) => (
                <button key={n.id} type="button" className="kn-pick" aria-current={item?.kind === "note" && item.value.id === n.id ? "true" : undefined} onClick={() => void open("note", n.id)}>
                  <span>{n.title || "Untitled"}</span>
                  <Tag>{n.noteType}</Tag>
                </button>
              ))
            ) : (
              <p className="tb-hint kn-pane-note">No notes yet.</p>
            )}
          </nav>
          <section aria-label="Selected item">
            {item ? (
              <Card as="article" className="kn-detail">
                <div className="tb-row kn-between">
                  <h2 className="kn-sub-title">
                    {item.value.title || "Untitled"} <Tag>{item.kind}</Tag>
                  </h2>
                  <Button size="sm" variant="quiet" onClick={() => setItem(null)}>
                    Close
                  </Button>
                </div>
                <p className="tb-hint">Updated {when(item.value.updated)}</p>
                <p className="tb-soft kn-wrap">{itemText(item.value)}</p>
              </Card>
            ) : (
              <p className="tb-soft">Choose a source or a note to read it.</p>
            )}
          </section>
        </div>
      ) : null}
      <ConfirmDelete
        open={toDelete !== null}
        title="Remove source"
        what={
          <>
            the source <strong>{toDelete?.title || "Untitled"}</strong>
          </>
        }
        busy={busy}
        onConfirm={() => void removeSource()}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
