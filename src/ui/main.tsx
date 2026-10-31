// Knowledge person UI inside the ONE app shell (@opt2-tealbrick/ui AppShell): Memory (Library, Recall, Memory status),
// Research, then the standard pages (Holds, Receipts, Agents & scopes, Backups & export, from ./standard.tsx) and Keys.
import { callOp, TbProvider, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Table, Tabs, Tag } from "@opt2-tealbrick/ui";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Access } from "./access.tsx";
import { errText, LoadError, PageHead, useOverview } from "./common.tsx";
import { Configure } from "./configure.tsx";
import { Library, type LibraryNav } from "./library.tsx";
import { Recall } from "./recall.tsx";
import { Research } from "./research.tsx";
import { Settings } from "./settings.tsx";
import { AgentsPage, BackupsPage, errorMessage, HoldsPage, portalHref, ReceiptsPage, standardRoutes, useHoldList, useNav } from "./standard.tsx";

const NAME = "Knowledge";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Shell page id → path under the base `/a/knowledge/`. Memory is the launch page (manifest `ui.launchPath`), Agents & scopes is `ui.configurePath`. */
const ROUTES = { ...standardRoutes("memory"), research: "research", access: "access", settings: "settings", keys: "keys" };
/** Own pages first, then the standard ones (the kit list holds Holds, Receipts, Agents & scopes, Keys, Backups & export). */
const PAGES = [{ id: "memory", label: "Memory" }, { id: "research", label: "Research" }, { id: "access", label: "Access" }, { id: "settings", label: "Settings" }, ...STANDARD_PAGES.filter((p) => p.id in ROUTES)];

type MemoryTab = "library" | "recall" | "status";
const MEMORY_TABS: { value: MemoryTab; label: string }[] = [
  { value: "library", label: "Library" },
  { value: "recall", label: "Recall" },
  { value: "status", label: "Memory status" },
];

/** Old deep links (`/a/knowledge/recall`, `/status`) open the Memory page on that tab. */
function initialTab(): MemoryTab {
  const rest = globalThis.location.pathname.replace(/^.*\/a\/knowledge\/?/u, "").replace(/\/+$/u, "");
  return rest === "recall" ? "recall" : rest === "status" ? "status" : "library";
}

interface AreaStatus {
  id: string;
  label: string;
  kind: "agent" | "shared" | "person" | "team";
  engineReady: boolean;
  researchReady: boolean;
  pending: number;
  ready: number;
  failed: number;
}

function useAreas() {
  const [areas, setAreas] = useState<AreaStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    callOp<{ areas: AreaStatus[] }>("indexing_status", {})
      .then((r) => setAreas(r.areas))
      .catch((e: unknown) => setError(errText(e)));
  }, []);
  useEffect(reload, [reload]);
  return { areas, error, reload };
}

type Areas = ReturnType<typeof useAreas>;

function Status({ areas }: { areas: Areas }) {
  if (areas.error) return <LoadError message={areas.error} onRetry={areas.reload} />;
  if (!areas.areas) return <p className="tb-soft" role="status">Loading memory areas.</p>;
  return (
    <div className="tb-stack">
      <div className="toolbar">
        <Button onClick={areas.reload}>Refresh</Button>
      </div>
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
          {areas.areas.map((area) => (
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

function Memory({ tab, setTab, areas, library, setLibrary, onOpen }: { tab: MemoryTab; setTab: (tab: MemoryTab) => void; areas: Areas; library: LibraryNav; setLibrary: (patch: Partial<LibraryNav>) => void; onOpen: (documentId: string) => void }) {
  return (
    <section className="app-page" aria-label="Memory">
      <PageHead title="Memory" />
      <Tabs label="Memory sections" tabs={MEMORY_TABS} value={tab} onChange={setTab} panelId="memory" />
      <div role="tabpanel" id={`memory-${tab}`} aria-label={MEMORY_TABS.find((t) => t.value === tab)?.label} className="app-page">
        {tab === "library" ? <Library nav={library} setNav={setLibrary} /> : null}
        {tab === "recall" ? <Recall onOpen={onOpen} /> : null}
        {tab === "status" ? <Status areas={areas} /> : null}
      </div>
    </section>
  );
}

interface KeyRow {
  name: string;
  required: boolean;
  present: boolean;
  source: string | null;
}

/** QA R-2: the server attention code for a set key the provider refuses (src/knowledge.ts KEY_REJECTED). */
const KEY_REJECTED_CODE = "memory_engine_key_rejected";

/** Model keys: whether each is set, never its value (entered on the bridge key page). */
function Keys() {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    callOp<KeyRow[] | { keys: KeyRow[] }>("tb.keys_status", {})
      .then((r) => setKeys(Array.isArray(r) ? r : (r.keys ?? [])))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  // QA R-2: the same engine health as the Library notice and the app status; a set key the provider refuses is not "present".
  const { engine } = useOverview();
  const rejected = engine?.attention?.code === KEY_REJECTED_CODE ? engine.attention : null;
  return (
    <section className="app-page" aria-label="Keys">
      <PageHead title="Keys" />
      <p className="tb-soft kn-measure">Model keys are entered on the bridge key page (open it from Portal). Knowledge never shows key values.</p>
      {rejected ? <Notice tone="needs-you">{rejected.reason}</Notice> : null}
      {error ? <LoadError message={error} onRetry={load} /> : null}
      {keys === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading keys.
          </p>
        )
      ) : (
        <Table>
          <tbody>
            {keys.map((key) => (
              <tr key={key.name}>
                <td className="mono">{key.name}</td>
                <td>
                  {key.present && rejected ? (
                    <Tag status="needs-you">rejected by provider</Tag>
                  ) : key.present ? (
                    <Tag status="live">present</Tag>
                  ) : key.required ? (
                    <Tag status="needs-you">needed</Tag>
                  ) : (
                    <Tag>not needed</Tag>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function App() {
  const { principal, status, signOut } = useSession();
  const nav = useNav(ROUTES, "memory");
  const holds = useHoldList();
  const areas = useAreas();
  const [tab, setTab] = useState<MemoryTab>(initialTab);
  const [library, setLibrary] = useState<LibraryNav>({ area: "", collectionId: "", documentId: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  const patchLibrary = useCallback((patch: Partial<LibraryNav>) => setLibrary((prev) => ({ ...prev, ...patch })), []);
  const { go } = nav;
  const openDocument = useCallback(
    (documentId: string) => {
      setLibrary((prev) => ({ ...prev, documentId }));
      setTab("library");
      go("memory");
    },
    [go],
  );
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p));
  const signedIn = status === "signed_in" && principal;
  return (
    <AppShell
      title={NAME}
      colour={appColour("knowledge")}
      art={appArt("knowledge", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {!signedIn ? null : nav.page === "research" ? (
        <section className="app-page" aria-label="Research">
          <PageHead title="Research" />
          <Research />
        </section>
      ) : nav.page === "agents" ? (
        <AgentsPage
          empty="No agent is connected to Knowledge yet. Draw a line from an agent to Knowledge on the canvas."
          lede="Each agent has its own memory area. Everyone can read the company area; turn on “Read and write” to let an agent add company knowledge. Personal and team memory is set on the Access page."
          render={() => <Configure areas={areas} />}
        />
      ) : nav.page === "holds" ? (
        <HoldsPage list={holds} only={nav.hold} empty="Nothing waits for your approval." />
      ) : nav.page === "receipts" ? (
        <ReceiptsPage empty="No agent actions recorded yet." />
      ) : nav.page === "access" ? (
        <Access />
      ) : nav.page === "settings" ? (
        <Settings />
      ) : nav.page === "keys" ? (
        <Keys />
      ) : nav.page === "backups" ? (
        <BackupsPage text="Backups run every night inside your deployment (documents, memory engine and research databases). The export is a readable copy of your documents and agent receipts." />
      ) : (
        <Memory tab={tab} setTab={setTab} areas={areas} library={library} setLibrary={patchLibrary} onOpen={openDocument} />
      )}
    </AppShell>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <TbProvider product="knowledge">
        <App />
      </TbProvider>
    </StrictMode>,
  );
}
