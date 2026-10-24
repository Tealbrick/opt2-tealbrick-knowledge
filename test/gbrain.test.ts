import assert from "node:assert/strict";
import { test } from "node:test";
import { documentIdFromSlug } from "../src/engines/gbrain/engine.ts";
import { gbrainExposure } from "../src/engines/gbrain/exposure.ts";
import { argumentRefusal } from "../src/engines/gbrain/guard.ts";
import { neutralizeFenceMarkers, sanitizeResult, stripPrivacyFences } from "../src/engines/gbrain/privacy.ts";
import { searchCatalog } from "../src/handlers.ts";

test("privacy fences are stripped, nested and unclosed fences drop their contents (A7)", () => {
  const open = "<!--- gbrain:facts:begin -->";
  const close = "<!--- gbrain:facts:end -->";
  assert.equal(stripPrivacyFences(`a${open}secret${close}b`), "ab");
  assert.equal(stripPrivacyFences(`a${open}x${open}y${close}z${close}b`), "ab");
  assert.equal(stripPrivacyFences(`a${open}never closed`), "a");
  assert.equal(stripPrivacyFences(`a${close}b`), "ab");
});

test("sanitizer drops foreign-source rows and withheld keys (A6, A9, A13)", () => {
  const out = sanitizeResult(
    { items: [{ id: 1, source_id: "ka-mine" }, { id: 2, source_id: "ka-other" }], pending_consolidation_count: 3, card: { open_loops: [1] } },
    "ka-mine",
  ) as Record<string, any>;
  assert.deepEqual(out.items, [{ id: 1, source_id: "ka-mine" }]);
  assert.equal("pending_consolidation_count" in out, false);
  assert.deepEqual(out.card, {});
  assert.equal(sanitizeResult({ id: 9, source_id: "ka-other" }, "ka-mine"), null);
});

test("fence markers in canonical text are escaped before projection", () => {
  assert.equal(neutralizeFenceMarkers("x <!--- gbrain:facts:begin --> y"), "x &lt;!--- gbrain:facts:begin --> y");
});

test("argument guard refuses source selection, host access, private facts and forced writes", () => {
  assert.ok(argumentRefusal("query", { source_id: "x" }));
  assert.ok(argumentRefusal("remember", { visibility: "private" }));
  assert.ok(argumentRefusal("capture", { local_file: "/etc/passwd" }));
  assert.ok(argumentRefusal("search_by_image", { image_url: "file:///etc/passwd" }));
  assert.ok(argumentRefusal("search_by_image", { image_url: "https://example.com/a.png" }));
  assert.equal(argumentRefusal("search_by_image", { image_data: "aGVsbG8=" }), null);
  assert.ok(argumentRefusal("takes_add", { local_dir: "/tmp" }));
  assert.ok(argumentRefusal("put_page", { slug: "knowledge-docs/kdoc_x", content: "x" }));
  assert.ok(argumentRefusal("put_page", { slug: "notes/a", content: "x", force: true }));
  assert.equal(argumentRefusal("remember", { fact: "ok" }), null);
});

test("exposure at the pin (0.60.424.0): 101 tools exposed, every write classified, destructive ops held", () => {
  const exposure = gbrainExposure();
  assert.equal(exposure.version, "0.60.424.0");
  assert.equal(exposure.exposed.size + exposure.excluded.size, 182);
  assert.equal(exposure.exposed.size, 101);
  assert.ok(exposure.exposed.size <= 256);
  for (const op of exposure.exposed.values()) {
    assert.equal(op.effect === "read", op.crud.length === 1 && op.crud[0] === "read", op.name);
    if (op.crud.includes("delete")) assert.equal(op.holdFamily, "destructive", op.name);
  }
  assert.ok(exposure.excluded.has("sources_list"));
  // C336 M2: new upstream ops that name other sources stay excluded until upstream's check is verified
  for (const name of ["sources_resolve_path", "rate_answer", "questions_list", "questions_pin", "purge_fact"]) assert.ok(exposure.excluded.has(name), name);
  for (const name of ["append_page", "put_pages", "commit_page_upload", "confirm_memory", "search_exact", "context_pack"]) assert.ok(exposure.exposed.has(name), name);
});

test("C336 M2 guard: batch and multipart page writes cannot touch knowledge-docs/; source-naming arguments are refused", () => {
  assert.ok(argumentRefusal("put_pages", { pages: [{ slug: "notes/a", content: "x" }, { slug: "Knowledge-Docs/kdoc_x", content: "y" }] }));
  assert.equal(argumentRefusal("put_pages", { pages: [{ slug: "notes/a", content: "x" }] }), null);
  assert.ok(argumentRefusal("append_page", { slug: "knowledge-docs/kdoc_x", text: "y" }));
  assert.ok(argumentRefusal("begin_page_upload", { slug: "knowledge-docs/kdoc_x", total_bytes: 1 }));
  assert.ok(argumentRefusal("context_pack", { entities: "Acme", prefer_source_id: "ka-other" }));
  assert.ok(argumentRefusal("context_pack", { entities: "Acme", entity_refs: [{ source_id: "ka-other", slug: "acme" }] }));
  assert.equal(argumentRefusal("context_pack", { entities: "Acme", budget_tokens: 400 }), null);
});

test("SEC-10: guard refuses all_sources, include_private, purge and forced delete/restore", () => {
  for (const op of ["get_links", "get_backlinks", "traverse_graph", "code_callers", "code_callees"]) {
    assert.ok(argumentRefusal(op, { slug: "a", all_sources: true }), op);
    assert.equal(argumentRefusal(op, { slug: "a", all_sources: false }), null, op);
  }
  for (const op of ["context_pack", "delta"]) {
    assert.ok(argumentRefusal(op, { include_private: true }), op);
    assert.equal(argumentRefusal(op, { include_private: false }), null, op);
  }
  assert.ok(argumentRefusal("delete_page", { slug: "notes/a", purge: true }));
  assert.ok(argumentRefusal("delete_page", { slug: "notes/a", force: true }));
  assert.ok(argumentRefusal("restore_page", { slug: "notes/a", force: true }));
  assert.equal(argumentRefusal("delete_page", { slug: "notes/a" }), null);
});

test("QA R4 S3: engine slugs come back lower case (upstream validateSlug); the canonical document id is restored", () => {
  assert.equal(documentIdFromSlug("knowledge-docs/kdoc_01m4s13txsdybf72tx2yrb8e40"), "kdoc_01M4S13TXSDYBF72TX2YRB8E40");
  assert.equal(documentIdFromSlug("knowledge-docs/kdoc_01M4S13TXSDYBF72TX2YRB8E40"), "kdoc_01M4S13TXSDYBF72TX2YRB8E40");
  assert.equal(documentIdFromSlug("Knowledge-Docs/kdoc_01m4s13txsdybf72tx2yrb8e40"), "kdoc_01M4S13TXSDYBF72TX2YRB8E40");
  assert.equal(documentIdFromSlug("notes/kdoc_01m4s13txsdybf72tx2yrb8e40"), null, "not a canonical page");
  assert.equal(documentIdFromSlug("knowledge-docs/kdoc_01m4s13txsdybf72tx2yrb8e4"), null, "25 chars is not a ULID");
  assert.equal(documentIdFromSlug("knowledge-docs/kdoc_01m4s13txsdybf72tx2yrb8eil"), null, "I and L are not Crockford base32");
});

test("C336 M4: engine tool search ranks the name first, then title and description; no match lists nothing; empty query lists the first tools", () => {
  const entry = (name: string, title: string, description: string) => ({ name, title, description, inputSchema: { type: "object" }, crud: ["read"], effect: "read" }) as never;
  const catalog = [
    entry("gb_get_links", "get links", "Outbound links of a page"),
    entry("gb_chronicle_day", "chronicle day", "What happened on a day, read from the timeline"),
    entry("gb_get_timeline", "get timeline", "Dated entries of a page"),
  ];
  // a name match outranks a description-only match
  assert.deepEqual(searchCatalog(catalog, "timeline", 10).map((e: { name: string }) => e.name), ["gb_get_timeline", "gb_chronicle_day"]);
  assert.deepEqual(searchCatalog(catalog, "links of a page", 1).map((e: { name: string }) => e.name), ["gb_get_links"]);
  assert.deepEqual(searchCatalog(catalog, "zzz", 10), []);
  assert.equal(searchCatalog(catalog, "", 2).length, 2);
});
