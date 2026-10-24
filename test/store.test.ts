import assert from "node:assert/strict";
import { test } from "node:test";
import { Areas } from "../src/areas.ts";
import { DocumentStore, ftsQuery, StoreError } from "../src/store/documents.ts";
import { FakeScopes, memoryDb } from "./helpers.ts";

async function setup() {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const areas = new Areas(db);
  await areas.ensureShared(scopes.asStore());
  await areas.ensureAgentArea({ id: "agt_01AAAAAAAAAAAAAAAAAAAAAAAA", name: "Ada" }, scopes.asStore());
  await areas.ensureAgentArea({ id: "agt_01BBBBBBBBBBBBBBBBBBBBBBBB", name: "Bo" }, scopes.asStore());
  return { db, store: new DocumentStore(db), a: "agent-01aaaaaaaaaaaaaaaaaaaaaaaa", b: "agent-01bbbbbbbbbbbbbbbbbbbbbbbb" };
}

test("create writes revision 1, a default collection and an outbox row", async () => {
  const { db, store, a } = await setup();
  const doc = store.createDocument({ area: a, title: "  Pricing call ", body: "Acme wants annual billing", tags: ["Sales", "sales"], actor: "agt_x" });
  assert.equal(doc.title, "Pricing call");
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.tags, ["sales"]);
  assert.equal(store.listCollections(a)[0]?.isDefault, true);
  assert.equal(store.revisions(doc.id).length, 1);
  const outbox = db.prepare("SELECT * FROM kn_projection WHERE document_id = ?").get(doc.id);
  assert.equal(outbox?.action, "upsert");
  assert.equal(outbox?.state, "pending");
});

test("update: optimistic concurrency, no-op skips a revision", async () => {
  const { store, a } = await setup();
  const doc = store.createDocument({ area: a, title: "T", body: "one", actor: "x" });
  const v2 = store.updateDocument(doc.id, { body: "two" }, 1, "x");
  assert.equal(v2.version, 2);
  assert.throws(() => store.updateDocument(doc.id, { body: "three" }, 1, "x"), (e: unknown) => e instanceof StoreError && e.code === "version_conflict");
  const same = store.updateDocument(doc.id, { body: "two" }, undefined, "x");
  assert.equal(same.version, 2);
  assert.equal(store.revisions(doc.id).length, 2);
});

test("collections and parents must belong to the same area / collection", async () => {
  const { store, a, b } = await setup();
  const other = store.createCollection(b, "B notes", undefined, "x");
  assert.throws(() => store.createDocument({ area: a, collectionId: other.id, title: "T", actor: "x" }), (e: unknown) => e instanceof StoreError && e.code === "collection_not_found");
  const parentInB = store.createDocument({ area: b, title: "P", actor: "x" });
  assert.throws(() => store.createDocument({ area: a, parentId: parentInB.id, title: "T", actor: "x" }), (e: unknown) => e instanceof StoreError && e.code === "parent_invalid");
});

test("links stay inside one area; comments reply only within the document", async () => {
  const { store, a, b } = await setup();
  const d1 = store.createDocument({ area: a, title: "One", actor: "x" });
  const d2 = store.createDocument({ area: a, title: "Two", actor: "x" });
  const foreign = store.createDocument({ area: b, title: "Foreign", actor: "x" });
  const link = store.addLink(d1.id, d2.id, "references", "x");
  assert.equal(store.addLink(d1.id, d2.id, "references", "x").id, link.id);
  assert.throws(() => store.addLink(d1.id, foreign.id, "references", "x"), (e: unknown) => e instanceof StoreError && e.httpStatus === 404);
  assert.equal(store.listLinks(d2.id).backlinks.length, 1);
  const c1 = store.addComment(d1.id, "first", undefined, "x");
  const other = store.addComment(d2.id, "other", undefined, "x");
  store.addComment(d1.id, "reply", c1.id, "x");
  assert.throws(() => store.addComment(d1.id, "bad", other.id, "x"), (e: unknown) => e instanceof StoreError && e.code === "parent_invalid");
});

test("soft delete hides the document, drops its links and queues a projection delete", async () => {
  const { db, store, a } = await setup();
  const d1 = store.createDocument({ area: a, title: "One", body: "zebra", actor: "x" });
  const d2 = store.createDocument({ area: a, title: "Two", actor: "x" });
  store.addLink(d2.id, d1.id, "references", "x");
  store.deleteDocument(d1.id, "x");
  assert.equal(store.getDocument(d1.id), null);
  assert.equal(store.listLinks(d2.id).outbound.length, 0);
  assert.equal(store.search({ areas: [a], query: "zebra" }).length, 0);
  assert.equal(db.prepare("SELECT action FROM kn_projection WHERE document_id = ?").get(d1.id)?.action, "delete");
});

test("FTS search ranks per area and never crosses into unlisted areas", async () => {
  const { store, a, b } = await setup();
  store.createDocument({ area: a, title: "Acme renewal", body: "Annual billing with Acme", actor: "x" });
  store.createDocument({ area: b, title: "Acme secret", body: "Acme private plan", actor: "x" });
  const hits = store.search({ areas: [a], query: "acme" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.area, a);
  assert.equal(store.search({ areas: [a, b], query: "acme" }).length, 2);
  assert.equal(store.search({ areas: [], query: "acme" }).length, 0);
});

test("ftsQuery quotes tokens (no FTS operator injection)", () => {
  assert.equal(ftsQuery('acme" OR body:*'), '"acme" OR "OR" OR "body"*');
  assert.equal(ftsQuery("  "), null);
});

test("C336 M1: a document cites its imported source, else itself; the dedupe key finds the live document only", async () => {
  const { store, a } = await setup();
  const imported = store.createDocument({ area: a, title: "Imported", body: "kettle from slack", status: "published", actor: "agt_x", sourceRef: "slack:C01/1700000000.000100", sourceUrl: "https://example.invalid/archives/C01/p1700000000000100", contentDigest: "d1" });
  const own = store.createDocument({ area: a, title: "Own", body: "kettle written here", status: "published", actor: "agt_y" });
  const cites = store.citationsOf([imported.id, own.id, "kdoc_missing"]);
  assert.deepEqual(cites.get(imported.id)?.citation, { ref: "slack:C01/1700000000.000100", url: "https://example.invalid/archives/C01/p1700000000000100", author: "agt_x", at: imported.updatedAt });
  assert.deepEqual(cites.get(own.id)?.citation, { ref: `knowledge:document/${own.id}`, author: "agt_y", at: own.updatedAt });
  assert.equal(cites.has("kdoc_missing"), false);
  const hit = store.search({ areas: [a], query: "kettle" }).find((h) => h.id === imported.id);
  assert.equal(hit?.citation.ref, "slack:C01/1700000000.000100");
  assert.equal(store.findByDigest(a, "d1")?.id, imported.id);
  assert.throws(() => store.createDocument({ area: a, title: "Dup", body: "x", actor: "agt_x", contentDigest: "d1" }));
  store.deleteDocument(imported.id, "agt_x");
  assert.equal(store.findByDigest(a, "d1"), null);
});
