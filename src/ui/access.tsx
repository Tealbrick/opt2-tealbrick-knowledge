// Access page (C373): who reads whose memory. People (Governance directory entries) → their personal memory and their
// agents; teams → members and the owner's grants "this team may read this person's memory" (add, change, remove).
// The Governance feed carries no person names: a person shows as its directory id plus the names of its agents.
// Never handles or trust values (C88): the server does not send them.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Field, Notice, Section, Select, Table, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorNotice, errText, PageHead, when } from "./common.tsx";

interface AgentRef {
  id: string;
  name: string;
}
interface Grant {
  team: string;
  teamName: string;
  person: string;
  tags: string[] | null;
}
export interface AccessOverview {
  directory: { status: string; available: boolean; note: string; revision: number | null; syncedAt: number | null; checkedAt: number | null };
  people: { id: string; active: boolean; area: string; areaExists: boolean; documents: number; agents: AgentRef[]; readBy: { team: string; teamName: string; tags: string[] | null }[] }[];
  teams: { id: string; name: string; area: string; areaExists: boolean; documents: number; people: string[]; agents: AgentRef[]; grants: { person: string; tags: string[] | null }[] }[];
  agentsWithoutOwner: AgentRef[];
  grants: Grant[];
  log: { at: number; actor: string; action: string; team: string; person: string; tags: string[] | null }[];
}

const names = (agents: AgentRef[]) => (agents.length ? agents.map((a) => a.name).join(", ") : "no agent");
const tagText = (tags: string[] | null) => (tags?.length ? `only memories tagged ${tags.join(", ")}` : "all of it");
const ACTIONS: Record<string, string> = { grant_added: "Grant added", grant_changed: "Grant changed", grant_removed: "Grant removed" };

/** Person label in plain words: the directory id and the agents that act for the person. */
function personText(o: AccessOverview, id: string): string {
  const p = o.people.find((x) => x.id === id);
  return p?.agents.length ? `${id} (${names(p.agents)})` : id;
}

export function Access() {
  const [data, setData] = useState<AccessOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [team, setTeam] = useState("");
  const [person, setPerson] = useState("");
  const [tags, setTags] = useState("");
  const latest = useRef(0);
  const load = useCallback(() => {
    const call = ++latest.current;
    callOp<AccessOverview>("access_overview", {})
      .then((d) => {
        if (call !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => call === latest.current && setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const act = async (key: string, op: string, input: Record<string, string | string[]>) => {
    setBusy(key);
    setError(null);
    try {
      await callOp(op, input, { idempotencyKey: crypto.randomUUID() });
      load();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const add = async () => {
    const list = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (await act("add", "access_grant_set", { team, person, ...(list.length ? { tags: list } : {}) })) setTags("");
  };

  if (!data) {
    return (
      <section className="app-page" aria-label="Access">
        <PageHead title="Access" />
        {error ? <ErrorNotice error={error} /> : <p className="tb-soft" role="status">Loading access.</p>}
      </section>
    );
  }
  const d = data.directory;
  return (
    <section className="app-page" aria-label="Access">
      <PageHead
        title="Access"
        lede="Each person's agents share that person's memory. Team members' agents read their team's memory. No agent reads another person's memory unless you let one of its teams read it here. You see every memory in the Library."
      />
      <Notice tone={d.available ? "live" : "needs-you"} role="status">
        {d.note}
        {d.syncedAt ? ` Last read: ${when(d.syncedAt)}.` : ""}
      </Notice>
      <ErrorNotice error={error} />
      <div className="toolbar">
        <Button onClick={load}>Refresh</Button>
      </div>

      <Section title="People" first>
        {data.people.length === 0 ? (
          <p className="tb-soft">No people yet. Add people and give each agent an owner in Governance.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Agents acting for this person</th>
                <th>Personal memory</th>
                <th>Also read by</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.id}>
                  <td className="strong">
                    <span className="tb-row">
                      <span className="mono">{p.id}</span>
                      {p.active ? null : <Tag>departed</Tag>}
                    </span>
                  </td>
                  <td>{names(p.agents)}</td>
                  <td>{p.areaExists ? `${p.documents} documents` : "not used yet"}</td>
                  <td>{p.readBy.length ? p.readBy.map((g) => `${g.teamName} (${tagText(g.tags)})`).join("; ") : "nobody else"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Teams">
        {data.teams.length === 0 ? (
          <p className="tb-soft">No teams yet. Teams are made in Governance.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Team</th>
                <th>Members</th>
                <th>Team memory</th>
                <th>May read the memory of</th>
              </tr>
            </thead>
            <tbody>
              {data.teams.map((t) => (
                <tr key={t.id}>
                  <td className="strong">{t.name}</td>
                  <td>{[...t.people.map((id) => personText(data, id)), ...t.agents.map((a) => `${a.name} (agent)`)].join(", ") || "no members"}</td>
                  <td>{t.areaExists ? `${t.documents} documents (agents read, you write in the Library)` : "not used yet"}</td>
                  <td>
                    {t.grants.length === 0 ? (
                      "nobody's"
                    ) : (
                      <ul className="kn-grants">
                        {t.grants.map((g) => (
                          <li key={g.person} className="tb-row">
                            <span>
                              {personText(data, g.person)}: {tagText(g.tags)}
                            </span>
                            <Button size="sm" disabled={busy !== null} onClick={() => void act(`remove:${t.id}:${g.person}`, "access_grant_remove", { team: t.id, person: g.person })}>
                              {busy === `remove:${t.id}:${g.person}` ? "Removing…" : "Remove"}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      {d.available && data.teams.length > 0 && data.people.length > 0 ? (
        <Section title="Let a team read a person's memory">
          <div className="tb-row kn-form">
            <Field label="Team">
              <Select options={[{ value: "", label: "Choose a team" }, ...data.teams.map((t) => ({ value: t.id, label: t.name }))]} value={team} onValueChange={setTeam} />
            </Field>
            <Field label="Person">
              <Select options={[{ value: "", label: "Choose a person" }, ...data.people.filter((p) => p.active).map((p) => ({ value: p.id, label: personText(data, p.id) }))]} value={person} onValueChange={setPerson} />
            </Field>
            <Field label="Only these tags (optional)" hint="Separate tags with commas. Empty = all of the person's memory.">
              <TextInput value={tags} onChange={(event) => setTags(event.target.value)} placeholder="work, sales" />
            </Field>
            <Button variant="primary" disabled={!team || !person || busy !== null} onClick={() => void add()}>
              {busy === "add" ? "Saving…" : "Let this team read"}
            </Button>
          </div>
        </Section>
      ) : null}

      {data.agentsWithoutOwner.length ? (
        <Section title="Agents with no owner">
          <p className="tb-soft">These agents have only their own memory and the company memory. Give them an owner in Governance to share a person's memory.</p>
          <p>{names(data.agentsWithoutOwner)}</p>
        </Section>
      ) : null}

      <Section title="Changes">
        {data.log.length === 0 ? (
          <p className="tb-soft">No grant changes yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Change</th>
                <th>Team</th>
                <th>Person</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {data.log.map((l, i) => (
                <tr key={`${l.at}-${i}`}>
                  <td>{when(l.at)}</td>
                  <td>{ACTIONS[l.action] ?? l.action}</td>
                  <td>{data.teams.find((t) => t.id === l.team)?.name ?? l.team}</td>
                  <td className="mono">{l.person}</td>
                  <td>{l.tags?.join(", ") ?? "all"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </section>
  );
}
