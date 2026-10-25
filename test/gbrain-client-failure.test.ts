// QA-KN027-1: engine-call failures are logged with stage, HTTP status and the error's own code; never a body or token.
import assert from "node:assert/strict";
import { test } from "node:test";
import { failureCause, GBrainClient, type GBrainFailure, GBrainServiceError } from "../src/engines/gbrain/client.ts";

const TOKEN = "t".repeat(40);
const memoryStore = () => {
  const m = new Map<string, unknown>();
  return { get: async (k: string) => (m.get(k) as never) ?? null, set: async (k: string, v: unknown) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
};

test("failureCause: error name plus the cause code, sanitized and short", () => {
  const e = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED fd12::1:3131"), { code: "ECONNREFUSED" }) });
  assert.equal(failureCause(e), "TypeError/ECONNREFUSED");
  assert.equal(failureCause(new DOMException("timed out", "TimeoutError")), "TimeoutError");
  assert.equal(failureCause("x"), "string");
});

test("admin login failures are reported once per distinct failure; the body and the token never reach the log", async () => {
  const seen: GBrainFailure[] = [];
  let mode: "refused" | "401" | "no_cookie" | "ok" = "refused";
  const fetcher = (async () => {
    if (mode === "refused") throw new TypeError("fetch failed", { cause: Object.assign(new Error("boom"), { code: "ECONNREFUSED" }) });
    if (mode === "401") return new Response(`{"error":"rejected ${TOKEN}"}`, { status: 401 });
    if (mode === "no_cookie") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ page_count: 3 }), { status: 200, headers: { "set-cookie": "gbrain_admin=abc; Path=/admin" } });
  }) as typeof fetch;
  const client = new GBrainClient({ baseUrl: "http://gbrain:3131", adminToken: TOKEN, store: memoryStore() as never, fetch: fetcher });
  client.onFailure = (f) => seen.push(f);
  for (let i = 0; i < 2; i++) await assert.rejects(client.fullStats(), (e: unknown) => e instanceof GBrainServiceError && e.code === "gbrain_admin_unavailable");
  mode = "401";
  await assert.rejects(client.fullStats());
  mode = "no_cookie";
  await assert.rejects(client.fullStats());
  mode = "ok";
  assert.equal((await client.fullStats()).page_count, 3);
  assert.deepEqual(seen, [
    { stage: "admin_login", cause: "TypeError/ECONNREFUSED" },
    { stage: "admin_login", status: 401, cause: "http_status" },
    { stage: "admin_login", status: 200, cause: "no_admin_cookie" },
  ]);
  assert.ok(!JSON.stringify(seen).includes(TOKEN));
});
