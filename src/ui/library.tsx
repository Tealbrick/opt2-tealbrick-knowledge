// Library page: area -> collection -> document. Navigation state lives in App so Recall and Research can open a document here.

import { useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, Dialog, Field, Notice, SearchIcon, Section, Segmented, Select, Table, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { ConfirmDelete, ErrorNotice, errText, isConflict, Loading, run, type Status, statusTag, TextBlock, useDebounced, useOverview, when, whenShort } from "./common.tsx";

/** Empty string means "not chosen". */
export interface LibraryNav {
  area: string;
  collectionId: string;
  documentId: string;
}
export type SetNav = (patch: Partial<LibraryNav>) => void;

interface Collection {
  id: string;
  area: string;
  name: string;
  description: string;
  isDefault: boolean;
  documentCount: number;
}
interface Hit {
  id: string;
  area: string;
  collectionId: string;
  title: string;
  summary: string | null;
  excerpt: string;
  status: Status;
  tags: string[];
  updatedAt: number;
}
interface TreeNode {
  id: string;
  title: string;
  status: Status;
  updatedAt: number;
  children: TreeNode[];
}
interface DocLink {
  id: string;
  type: string;
  documentId: string;
  title: string;
  updatedAt: number;
}
interface Comment {
  id: string;
  parentId: string | null;
  body: string;
  createdBy: string;
  createdAt: number;
}
interface DocResponse {
  document: {
    id: string;
    area: string;
    collectionId: string;
    parentId: string | null;
    title: string;
    slug: string;
    summary: string | null;
    body: string;
    status: Status;
    tags: string[];
    version: number;
    createdBy: string;
    updatedBy: string;
    createdAt: number;
    updatedAt: number;
  };
  revisions: { version: number; title: string; summary: string | null; createdBy: string; createdAt: number }[];
  comments: Comment[];
  links: { outbound: DocLink[]; backlinks: DocLink[] };
}
interface Revision {
  version: number;
  title: string;
  summary: string | null;
  body: string;
  status: Status;
  tags: string[];
  createdBy: string;
  createdAt: number;
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "archived", label: "Archived" },
];

export function Library({ nav, setNav }: { nav: LibraryNav; setNav: SetNav }) {
  const { areas, engine, error } = useOverview();
  useEffect(() => {
    if (areas?.length && !areas.some((a) => a.id === nav.area) && !nav.documentId) setNav({ area: areas[0]?.id ?? "", collectionId: "" });
  }, [areas, nav.area, nav.documentId, setNav]);
  if (error) return <ErrorNotice error={error} />;
  if (!areas) return <Loading what="the library" />;
  if (!areas.length) return <Notice tone="needs-you">No memory area is available yet.</Notice>;
  // F89: the memory engine's reason stays visible while the owner has to act.
  const engineNotice = engine?.attention ? <Notice tone="needs-you">{engine.attention.reason}</Notice> : null;
  if (nav.documentId) return <DocumentView id={nav.documentId} nav={nav} setNav={setNav} />;
  return (
    <div className="tb-stack">
      {engineNotice}
      <Browse areas={areas} nav={nav} setNav={setNav} />
    </div>
  );
}

function Browse({ areas, nav, setNav }: { areas: { id: string; label: string; documents?: number }[]; nav: LibraryNav; setNav: SetNav }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [view, setView] = useState<"list" | "outline">("list");
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docBody, setDocBody] = useState("");

  const loadCollections = useCallback(() => {
    if (!nav.area) return;
    run<{ collections: Collection[] }>("library_collections", { area: nav.area })
      .then((r) => setCollections(r.collections))
      .catch((e: unknown) => setError(errText(e)));
  }, [nav.area]);
  useEffect(loadCollections, [loadCollections]);

  const loadHits = useCallback(() => {
    if (!nav.area) return () => {};
    let live = true;
    setLoading(true);
    run<{ hits: Hit[] }>("library_documents", { area: nav.area, collectionId: nav.collectionId || undefined, query: debounced.trim() || undefined, limit: 50 })
      .then((r) => {
        if (live) {
          setHits(r.hits);
          setError(null);
        }
      })
      .catch((e: unknown) => live && setError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [nav.area, nav.collectionId, debounced]);
  useEffect(loadHits, [loadHits]);

  useEffect(() => {
    if (view !== "outline" || !nav.collectionId) return;
    let live = true;
    run<{ nodes: TreeNode[] }>("library_tree", { collectionId: nav.collectionId })
      .then((r) => live && setTree(r.nodes))
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [view, nav.collectionId]);

  const selected = collections.find((c) => c.id === nav.collectionId);
  const total = areas.find((a) => a.id === nav.area)?.documents;

  const createDocument = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await run<{ id: string }>(
        "library_document_create",
        { area: nav.area, collectionId: nav.collectionId || undefined, title: docTitle.trim(), body: docBody, status: "published" },
        true,
      );
      setWriting(false);
      setDocTitle("");
      setDocBody("");
      setNav({ documentId: r.id });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await run<{ id: string }>("library_collection_create", { area: nav.area, name: name.trim(), description: description.trim() || undefined }, true);
      setCreating(false);
      setName("");
      setDescription("");
      setNav({ collectionId: r.id });
      loadCollections();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const removeCollection = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await run<{ documents: number }>("library_collection_delete", { id: selected.id });
      setDeleting(false);
      setNotice(`Collection “${selected.name}” removed with ${r.documents} document${r.documents === 1 ? "" : "s"}.`);
      setNav({ collectionId: "" });
      loadCollections();
    } catch (e) {
      setError(errText(e));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tb-stack">
      <div className="toolbar">
        <div className="kn-area">
          <Field label="Memory area">
            <Select
              options={areas.map((a) => ({ value: a.id, label: a.label }))}
              value={nav.area}
              onValueChange={(value) => {
                setNav({ area: value, collectionId: "" });
                setQuery("");
                setNotice(null);
              }}
            />
          </Field>
        </div>
      </div>
      <ErrorNotice error={error} />
      {notice ? <Notice tone="live">{notice}</Notice> : null}
      <div className="kn-two">
        <nav className="kn-pane" aria-label="Collections">
          <div className="kn-pane-head">
            <strong>Collections</strong>
            <Button size="sm" onClick={() => setCreating(true)}>
              New collection
            </Button>
          </div>
          <button type="button" className="kn-pick" aria-current={!nav.collectionId ? "true" : undefined} onClick={() => setNav({ collectionId: "" })}>
            <span>All documents</span>
            {total === undefined ? null : <span className="tb-hint">{total}</span>}
          </button>
          {collections.map((c) => (
            <button key={c.id} type="button" className="kn-pick" aria-current={nav.collectionId === c.id ? "true" : undefined} onClick={() => setNav({ collectionId: c.id })}>
              <span>{c.name}</span>
              <span className="tb-hint">{c.documentCount}</span>
            </button>
          ))}
          {selected ? (
            <div className="tb-stack kn-pane-foot">
              {selected.description ? <p className="tb-hint">{selected.description}</p> : null}
              {selected.isDefault ? null : (
                <div>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
                    Remove collection
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </nav>
        <section className="tb-stack" aria-label="Documents">
          <div className="toolbar">
            <div className="tb-search">
              <SearchIcon />
              <TextInput type="search" aria-label="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Words from a title or body" />
            </div>
            {nav.collectionId ? (
              <Segmented
                label="Document view"
                options={[
                  { value: "list", label: "List" },
                  { value: "outline", label: "Outline" },
                ]}
                value={view}
                onChange={setView}
              />
            ) : null}
            <Button variant="primary" onClick={() => setWriting(true)}>
              New document
            </Button>
          </div>
          {view === "outline" && nav.collectionId ? (
            <Outline nodes={tree} onOpen={(id) => setNav({ documentId: id })} />
          ) : (
            <DocList hits={hits} loading={loading} searching={debounced.trim() !== ""} onOpen={(id) => setNav({ documentId: id })} />
          )}
        </section>
      </div>
      <Dialog
        open={writing}
        title="New document"
        kicker="Library"
        onClose={() => setWriting(false)}
        busy={busy}
        footer={
          <>
            <Button onClick={() => setWriting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void createDocument()} disabled={busy || !docTitle.trim()}>
              {busy ? "Saving…" : "Create"}
            </Button>
          </>
        }
      >
        <div className="tb-stack">
          <Field label="Title">
            <TextInput value={docTitle} onChange={(event) => setDocTitle(event.target.value)} maxLength={200} />
          </Field>
          <Field label="Text">
            <Textarea rows={8} value={docBody} onChange={(event) => setDocBody(event.target.value)} />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={creating}
        title="New collection"
        kicker="Library"
        onClose={() => setCreating(false)}
        busy={busy}
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Create"}
            </Button>
          </>
        }
      >
        <div className="tb-stack">
          <Field label="Name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </Field>
          <Field label="Description (optional)">
            <Textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </div>
      </Dialog>
      <ConfirmDelete
        open={deleting}
        title="Remove collection"
        what={
          <>
            the collection <strong>{selected?.name}</strong> and its {selected?.documentCount ?? 0} documents
          </>
        }
        busy={busy}
        onConfirm={() => void removeCollection()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}

function DocList({ hits, loading, searching, onOpen }: { hits: Hit[]; loading: boolean; searching: boolean; onOpen: (id: string) => void }) {
  if (!hits.length) return <p className="tb-soft">{loading ? "Loading documents." : searching ? "No document matches this search." : "No documents here yet."}</p>;
  return (
    <Table className="kn-docs" aria-busy={loading}>
      <thead>
        <tr>
          <th>Title</th>
          <th>Status</th>
          <th>Tags</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit) => (
          <tr key={hit.id}>
            <td className="strong">
              <button type="button" className="tb-link" onClick={() => onOpen(hit.id)}>
                {hit.title || "Untitled"}
              </button>
              {hit.excerpt || hit.summary ? <div className="tb-hint kn-clip">{hit.excerpt || hit.summary}</div> : null}
            </td>
            <td>
              <Tag status={statusTag(hit.status)}>{hit.status}</Tag>
            </td>
            <td>
              <span className="tb-row">
                {hit.tags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </span>
            </td>
            <td className="num">{whenShort(hit.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Outline({ nodes, onOpen }: { nodes: TreeNode[]; onOpen: (id: string) => void }) {
  if (!nodes.length) return <p className="tb-soft">No documents in this collection yet.</p>;
  return (
    <ul className="kn-tree">
      {nodes.map((node) => (
        <li key={node.id}>
          <span className="tb-row">
            <button type="button" className="tb-link" onClick={() => onOpen(node.id)}>
              {node.title || "Untitled"}
            </button>
            <Tag status={statusTag(node.status)}>{node.status}</Tag>
          </span>
          {node.children.length ? <Outline nodes={node.children} onOpen={onOpen} /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * C331 (demo gap 10): documents, revisions and comments store the writer's caller id (an agent id, or the person's id). The page
 * names agents as `tb.agents_list` does, the signed-in person as "you"; any other id (an app, a removed agent) stays as stored.
 */
function useAuthorName(): (id: string) => string {
  const { principal } = useSession();
  const [agents, setAgents] = useState<Record<string, string>>({});
  useEffect(() => {
    run<{ agents: { id: string; name: string }[] }>("tb.agents_list")
      .then((r) => setAgents(Object.fromEntries(r.agents.filter((a) => a.name).map((a) => [a.id, a.name]))))
      .catch(() => setAgents({}));
  }, []);
  return useCallback((id: string) => agents[id] ?? (principal && id === principal.id ? "you" : id), [agents, principal]);
}

function DocumentView({ id, nav, setNav }: { id: string; nav: LibraryNav; setNav: SetNav }) {
  const authorName = useAuthorName();
  const [data, setData] = useState<DocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [linkToDelete, setLinkToDelete] = useState<DocLink | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return run<DocResponse>("library_document", { id })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => setError(errText(e)));
  }, [id]);
  useEffect(() => {
    setData(null);
    setRevision(null);
    setNotice(null);
    void load();
  }, [load]);

  const doc = data?.document;
  useEffect(() => {
    if (doc && (doc.area !== nav.area || doc.collectionId !== nav.collectionId)) setNav({ area: doc.area, collectionId: doc.collectionId });
  }, [doc, nav.area, nav.collectionId, setNav]);

  const back = <Button onClick={() => setNav({ documentId: "" })}>Back to documents</Button>;
  if (!data || !doc) {
    return (
      <div className="tb-stack">
        <div className="toolbar">{back}</div>
        <ErrorNotice error={error} />
        {error ? null : <Loading what="the document" />}
      </div>
    );
  }

  const openRevision = async (version: number) => {
    setError(null);
    try {
      setRevision(await run<Revision>("library_revision", { id, version }));
    } catch (e) {
      setError(errText(e));
    }
  };

  const save = async (patch: { title: string; summary: string; body: string; status: Status; tags: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      await run("library_document_update", { id, expectedVersion: doc.version, ...patch });
      setEditing(false);
      setNotice("Saved.");
      await load();
    } catch (e) {
      setEditing(false);
      if (isConflict(e)) {
        setNotice(null);
        await load(); // a successful load clears the error, so the message is set after it
        setError("Someone else changed this document while you edited. Your change wasn’t saved. The latest version is shown now.");
      } else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await run("library_document_delete", { id });
      setNav({ documentId: "" });
    } catch (e) {
      setError(errText(e));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  };

  const removeLink = async () => {
    if (!linkToDelete) return;
    setBusy(true);
    try {
      await run("library_link_delete", { id: linkToDelete.id });
      setLinkToDelete(null);
      await load();
    } catch (e) {
      setError(errText(e));
      setLinkToDelete(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="tb-stack">
      <div className="toolbar">
        {back}
        <Button variant="primary" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          Remove
        </Button>
      </div>
      <ErrorNotice error={error} />
      {notice ? <Notice tone="live">{notice}</Notice> : null}
      <h2 className="kn-title">{doc.title || "Untitled"}</h2>
      <div className="tb-row">
        <Tag status={statusTag(doc.status)}>{doc.status}</Tag>
        {doc.tags.map((tag) => (
          <Tag key={tag}>{tag}</Tag>
        ))}
        <span className="tb-hint">
          Version {doc.version}, updated {when(doc.updatedAt)} by {authorName(doc.updatedBy)}
        </span>
      </div>
      {doc.summary ? <p className="tb-soft">{doc.summary}</p> : null}
      <TextBlock text={doc.body} label="Document text" />

      <Section title="History" first>
        {data.revisions.length ? (
          <Table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Title</th>
                <th>By</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.revisions.map((rev) => (
                <tr key={rev.version}>
                  <td className="strong">
                    <button type="button" className="tb-link" onClick={() => void openRevision(rev.version)}>
                      Version {rev.version}
                    </button>
                  </td>
                  <td>{rev.title || "Untitled"}</td>
                  <td>{authorName(rev.createdBy)}</td>
                  <td className="num">{when(rev.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="tb-soft">No earlier versions.</p>
        )}
        {revision ? (
          <Card as="section" className="kn-revision" aria-label={`Version ${revision.version}`}>
            <div className="tb-row kn-between">
              <strong>
                Version {revision.version} (read only): {revision.title || "Untitled"}
              </strong>
              <span className="tb-row">
                <Tag status={statusTag(revision.status)}>{revision.status}</Tag>
                <Button size="sm" variant="quiet" onClick={() => setRevision(null)}>
                  Close version
                </Button>
              </span>
            </div>
            {revision.summary ? <p className="tb-soft">{revision.summary}</p> : null}
            <TextBlock text={revision.body} label={`Text of version ${revision.version}`} />
          </Card>
        ) : null}
      </Section>

      <Section title="Links">
        <div className="kn-links">
          <LinkList heading="Links to" links={data.links.outbound} onOpen={(docId) => setNav({ documentId: docId })} onDelete={setLinkToDelete} />
          <LinkList heading="Linked from" links={data.links.backlinks} onOpen={(docId) => setNav({ documentId: docId })} onDelete={setLinkToDelete} />
        </div>
      </Section>

      <Comments documentId={id} comments={data.comments} authorName={authorName} onChanged={load} onError={setError} />

      <EditDialog open={editing} doc={doc} busy={busy} onClose={() => setEditing(false)} onSave={save} />
      <ConfirmDelete
        open={deleting}
        title="Remove document"
        what={
          <>
            the document <strong>{doc.title || "Untitled"}</strong>
          </>
        }
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
      <ConfirmDelete
        open={linkToDelete !== null}
        title="Remove link"
        what={
          <>
            the link to <strong>{linkToDelete?.title || "this document"}</strong>
          </>
        }
        busy={busy}
        onConfirm={() => void removeLink()}
        onClose={() => setLinkToDelete(null)}
      />
    </article>
  );
}

function LinkList({ heading, links, onOpen, onDelete }: { heading: string; links: DocLink[]; onOpen: (id: string) => void; onDelete: (link: DocLink) => void }) {
  return (
    <div className="tb-stack">
      <h3 className="kn-sub">{heading}</h3>
      {links.length ? (
        <ul className="kn-rows">
          {links.map((link) => (
            <li key={link.id} className="kn-row-item">
              <button type="button" className="tb-link" onClick={() => onOpen(link.documentId)}>
                {link.title || "Untitled"}
              </button>
              <Tag>{link.type}</Tag>
              <Button size="sm" variant="quiet" aria-label={`Remove link to ${link.title || "Untitled"}`} onClick={() => onDelete(link)}>
                Remove link
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tb-hint">None.</p>
      )}
    </div>
  );
}

function Comments({
  documentId,
  comments,
  authorName,
  onChanged,
  onError,
}: { documentId: string; comments: Comment[]; authorName: (id: string) => string; onChanged: () => Promise<void>; onError: (message: string | null) => void }) {
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = new Set(comments.map((c) => c.id));
  const childrenOf = (parent: string | null) => comments.filter((c) => (c.parentId && ids.has(c.parentId) ? c.parentId : null) === parent);

  const add = async () => {
    setBusy(true);
    onError(null);
    try {
      await run("library_comment_add", { documentId, body: body.trim(), parentId: replyTo?.id }, true);
      setBody("");
      setReplyTo(null);
      await onChanged();
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const render = (parent: string | null, depth: number) =>
    childrenOf(parent).map((c) => (
      <li key={c.id} className="kn-comment" style={{ "--depth": Math.min(depth, 4) } as CSSProperties}>
        <div className="tb-hint">
          {authorName(c.createdBy)}, {when(c.createdAt)}
        </div>
        <p className="kn-wrap">{c.body}</p>
        <div>
          <Button size="sm" variant="quiet" onClick={() => setReplyTo(c)}>
            Reply
          </Button>
        </div>
        {render(c.id, depth + 1)}
      </li>
    ));

  return (
    <Section title="Comments">
      <section className="tb-stack" aria-label="Comments">
        {comments.length ? <ul className="kn-rows">{render(null, 0)}</ul> : <p className="tb-soft">No comments yet.</p>}
        <Field label={replyTo ? `Reply to ${authorName(replyTo.createdBy)}` : "Add a comment"}>
          <Textarea rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <div className="tb-ctas">
          <Button onClick={() => void add()} disabled={busy || !body.trim()}>
            {busy ? "Saving…" : replyTo ? "Post reply" : "Post comment"}
          </Button>
          {replyTo ? (
            <Button variant="quiet" onClick={() => setReplyTo(null)}>
              Cancel reply
            </Button>
          ) : null}
        </div>
      </section>
    </Section>
  );
}

function EditDialog({
  open,
  doc,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  doc: DocResponse["document"];
  busy: boolean;
  onClose: () => void;
  onSave: (patch: { title: string; summary: string; body: string; status: Status; tags: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState(doc.title);
  const [summary, setSummary] = useState(doc.summary ?? "");
  const [body, setBody] = useState(doc.body);
  const [status, setStatus] = useState<Status>(doc.status);
  const [tags, setTags] = useState(doc.tags.join(", "));
  useEffect(() => {
    if (!open) return;
    setTitle(doc.title);
    setSummary(doc.summary ?? "");
    setBody(doc.body);
    setStatus(doc.status);
    setTags(doc.tags.join(", "));
  }, [open, doc]);
  return (
    <Dialog
      open={open}
      title="Edit document"
      kicker="Library"
      size="lg"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !title.trim()}
            onClick={() => void onSave({ title: title.trim(), summary, body, status, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) })}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="tb-stack">
        <Field label="Title">
          <TextInput value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Summary">
          <Textarea rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} />
        </Field>
        <Field label="Text">
          <Textarea className="kn-mono" rows={12} value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <Field label="Status">
          <Select options={STATUS_OPTIONS} value={status} onValueChange={(value) => setStatus(value as Status)} />
        </Field>
        <Field label="Tags" hint="Separate tags with commas.">
          <TextInput value={tags} onChange={(event) => setTags(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
