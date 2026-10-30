// C380 B6 contract proof (tb.access/1 as frozen in spec 0.1.89, docs/ACCESS.md): the vendored schemas and fixtures are byte copies
// (test/contracts/PROVENANCE.md), the manifest embeds the schemas, the fixtures read as the schemas say, and the guard passes the
// shared caller vector.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalize, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { manifest } from "../src/app.ts";
import { digestOf, guardCaller } from "../src/tb-access.ts";
import { TestError } from "./helpers.ts";

const read = (f: string) => readFileSync(new URL(`./contracts/${f}`, import.meta.url));
const json = (f: string) => JSON.parse(read(f).toString("utf8"));
const sha = (f: string) => createHash("sha256").update(read(f)).digest("hex");
const fail = (code: string, message: string, status: number) => new TestError(code, message, status);

/** The sha256 of each vendored file as PROVENANCE.md states it (the table rows after the tb.access/1 heading). */
function provenance(): Record<string, string> {
  const text = readFileSync(new URL("./contracts/PROVENANCE.md", import.meta.url), "utf8");
  const rows = [...text.matchAll(/^\| `(access\.[^`]+)` \| `[^`]+` \| `([0-9a-f]{64})` \|$/gmu)];
  return Object.fromEntries(rows.map((m) => [m[1] as string, m[2] as string]));
}
const SHA = provenance();
const EXPECTED = 10;

test("contract: the vendored files are byte copies (sha256 as in PROVENANCE.md)", () => {
  assert.equal(Object.keys(SHA).length, EXPECTED, "PROVENANCE.md lists every vendored access file");
  for (const [file, want] of Object.entries(SHA)) assert.equal(sha(file), want, file);
});

test("contract: the manifest embeds the spec schemas as the op input and output, byte for byte after JCS", () => {
  for (const [op, input, output] of [["access_list", "access.list_in.1.schema.json", "access.list_out.1.schema.json"], ["access_revoke", "access.revoke_in.1.schema.json", "access.revoke_out.1.schema.json"]] as const) {
    const declared = manifest.operations.find((o) => o.id === op);
    assert.equal(canonicalize(declared?.input as never), canonicalize(json(input)), `${op} input`);
    assert.equal(canonicalize(declared?.output as never), canonicalize(json(output)), `${op} output`);
  }
});

test("contract: every valid fixture passes its schema and every invalid one is refused", () => {
  for (const kind of ["list_in", "list_out", "revoke_in", "revoke_out"]) {
    const fixtures = json(`access.${kind}.1.json`) as { valid: unknown[]; invalid: { why: string; doc: unknown }[] };
    const schema = json(`access.${kind}.1.schema.json`);
    assert.ok(fixtures.valid.length > 0 && fixtures.invalid.length > 0, kind);
    for (const doc of fixtures.valid) assert.equal(validateAgainstSchema(schema, doc as never).ok, true, `${kind} valid: ${JSON.stringify(doc).slice(0, 80)}`);
    for (const { why, doc } of fixtures.invalid) assert.equal(validateAgainstSchema(schema, doc as never).ok, false, `${kind} invalid: ${why}`);
  }
});

test("contract: the digest fixture (JCS of v, target, id, kind, subject, resource, level; state, label, since, revocable, direction are out)", () => {
  const fx = json("access.digest.1.json") as { target: string; jcs: string; digest: string; equal: { item: Parameters<typeof digestOf>[0] & { digest: string } }[]; different: { item: Parameters<typeof digestOf>[0] & { digest: string } }[] };
  assert.equal(`sha256:${createHash("sha256").update(fx.jcs).digest("hex")}`, fx.digest);
  for (const { item } of fx.equal) assert.equal(digestOf(item, fx.target), fx.digest);
  for (const { item } of fx.different) {
    assert.equal(digestOf(item, fx.target), item.digest);
    assert.notEqual(item.digest, fx.digest);
  }
});

test("contract: the guard passes the shared 6-case caller vector with the exact code and status", () => {
  const vector = json("access.caller_vector.1.json") as { cases: { name: string; caller: Record<string, unknown>; allow: boolean; code?: string; status?: number }[] };
  assert.equal(vector.cases.length, 6);
  for (const c of vector.cases) {
    const run = () => guardCaller({ caller: c.caller as never }, fail);
    if (c.allow) assert.doesNotThrow(run, c.name);
    else assert.throws(run, (e: { code?: string; httpStatus?: number }) => e.code === c.code && e.httpStatus === c.status, c.name);
  }
});
