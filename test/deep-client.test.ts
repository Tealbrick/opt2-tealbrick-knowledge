// C336 F4: Knowledge's client for the deep knowledge proxy, and the owner attention when deep knowledge is on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeDefinition } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import { DeepClient, DeepError } from "../src/engines/deep/client.ts";
import { DEEP_MISSING, DEEP_UNREACHABLE, Knowledge } from "../src/knowledge.ts";
import { memoryDb, TestError } from "./helpers.ts";

const TOKEN = "p".repeat(48);
const calls: { url: string; init?: RequestInit }[] = [];
const fakeFetch = (answer: (url: string) => Response) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    return answer(url);
  }) as typeof fetch;

test("DeepClient: bare origin and token checked; every call carries the proxy token, a workspace token in x-deep-token; only /api/ paths", async () => {
  assert.throws(() => new DeepClient({ baseUrl: "http://deep:3150/x", token: TOKEN }), /bare http/u);
  assert.throws(() => new DeepClient({ baseUrl: "http://deep:3150", token: "short" }), /KNOWLEDGE_DEEP_TOKEN/u);
  calls.length = 0;
  const client = new DeepClient({ baseUrl: "http://deep:3150", token: TOKEN, fetch: fakeFetch(() => Response.json({ workspaces: [] })) });
  assert.deepEqual(await client.request("GET", "/api/v1/workspaces", { workspaceToken: "ws-read-token-1" }), { workspaces: [] });
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["x-deep-token"], "ws-read-token-1");
  await assert.rejects(client.request("GET", "/admin"), (e: unknown) => e instanceof DeepError && e.code === "deep_path_invalid");
});

test("DeepClient: upstream failures map to closed codes and never carry the upstream body", async () => {
  const failing = new DeepClient({ baseUrl: "http://deep:3150", token: TOKEN, fetch: fakeFetch(() => new Response("row value SECRET-CANARY in error", { status: 500 })) });
  await assert.rejects(failing.request("POST", "/api/v1/workspaces/w/query", { body: { sql: "x" } }), (e: unknown) => e instanceof DeepError && e.code === "deep_failed" && e.status === 502 && !e.message.includes("SECRET-CANARY"));
  const denied = new DeepClient({ baseUrl: "http://deep:3150", token: TOKEN, fetch: fakeFetch(() => new Response("{}", { status: 403 })) });
  await assert.rejects(denied.request("GET", "/api/v1/workspaces/w"), (e: unknown) => e instanceof DeepError && e.code === "deep_forbidden");
  const down = new DeepClient({ baseUrl: "http://deep:3150", token: TOKEN, fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
  await assert.rejects(down.request("GET", "/api/v1/workspaces"), (e: unknown) => e instanceof DeepError && e.code === "deep_unavailable");
  assert.deepEqual(await down.health(), { ok: false, status: "unreachable", phase: "" });
});

test("deep attention: off = quiet; on without the service = deep_missing; unhealthy = deep_unreachable with the phase; healthy = quiet", async () => {
  const base = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: "http://gbrain:3131", KNOWLEDGE_GBRAIN_ADMIN_TOKEN: "a".repeat(40) };
  const off = new Knowledge(readConfig(base));
  assert.notEqual(off.attention()?.code, DEEP_MISSING);
  const unwired = new Knowledge(readConfig({ ...base, KNOWLEDGE_DEEP: "true" }));
  // the engine is fine in this check: deep attention shows once the engine has nothing to say
  (unwired as unknown as { engineHealth: unknown }).engineHealth = { state: "ok", detail: [], at: 1 };
  assert.equal(unwired.attention()?.code, DEEP_MISSING);
  let healthy = false;
  const wired = new Knowledge(readConfig({ ...base, KNOWLEDGE_DEEP: "true", KNOWLEDGE_DEEP_URL: "http://deep:3150", KNOWLEDGE_DEEP_TOKEN: TOKEN }), {
    engineProbeMs: 0,
    fetch: fakeFetch((url) => (url.endsWith("/health") ? (healthy ? Response.json({ status: "ok", phase: "serving" }) : Response.json({ status: "starting", phase: "executor" }, { status: 503 })) : Response.json({}))),
  });
  (wired as unknown as { engineHealth: unknown }).engineHealth = { state: "ok", detail: [], at: 1 };
  const services = wired.bind(memoryDb());
  assert.ok(services.deep, "the client exists when the setting is on and the service is wired");
  await wired.probeDeep(services);
  assert.equal(wired.attention()?.code, DEEP_UNREACHABLE);
  assert.match(wired.attention()?.reason ?? "", /starting: executor/u);
  healthy = true;
  await wired.probeDeep(services);
  assert.equal(wired.attention(), null);
  wired.stop();
  // the definition reads the deep env through the manifest (setting + service URL/token)
  const { definition } = knowledgeDefinition({ ...base, KNOWLEDGE_DEEP: "true" }, TestError, { drainIntervalMs: 0 });
  const service = definition.manifest.runtime?.services?.find((s) => s.id === "deep");
  assert.equal(service?.port, 3150);
  assert.deepEqual(service?.when, { deep: true });
});
