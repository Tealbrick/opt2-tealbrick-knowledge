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

const SHA: Record<string, string> = {
  "access.list_in.1.schema.json": "83f1c2f7c2c399d8e11a93418e469d01c777af5f6c8bfe7cd2643539f3a04fe5",
  "access.list_out.1.schema.json": "571feb6b833d392f8eec3212b21d53aa7e529dfb65a34f8a54b89d07160c7f48",
  "access.revoke_in.1.schema.json": "edbe7c6b94ffb74e4dff0c3f986ccaa29e83d8d6fd1fa9f1e2986d2802e60c51",
  "access.revoke_out.1.schema.json": "b36b1c6474fc858daf93e2a4d9605067113937b984e8b26833fa13eae314d919",
  "access.caller_vector.1.json": "faf832b1a3fa7e122f252677e9a946be11668cacd23ce0f765fcaa57ebe5cd49",
  "access.digest.1.json": "e4db19dd894802348b9e87c2251d85383fb2e4f47e90b26dde76c42e17b42daa",
  "access.list_in.1.json": "dc1745d9a0bd6d83fdd672fbc14e119f9637b19537162e77455b246676535c85",
  "access.list_out.1.json": "efc7e1389eb7a7eac55e3149c2ac111959a5664ebaccf630a0155668c70b5c49",
  "access.revoke_in.1.json": "5cab7e5c4b15ddf172aac5a4dab0f55a1028eeaa4ac491a712c4b88f6221783d",
  "access.revoke_out.1.json": "76ed608d69f86c43d217ce18516ffe7b233d20f5971a962e862184a62b296281",
};

test("contract: the vendored files are byte copies (sha256 as in PROVENANCE.md)", () => {
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
