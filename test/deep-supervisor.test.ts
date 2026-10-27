// Deep knowledge companion (C336 F4): the token proxy is the only private-network listener in front of an upstream that
// has no sign-in; every child binds loopback; no model endpoint is reachable until a provider is configured.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { authorized, childSpecs, createProxy, foundryProvider, type HealthState, type ModelState, ModelSync, REASONING_ENV, readEnv, upstreamHeaders } from "../services/deep/supervisor.ts";

const TOKEN = "t".repeat(48);
const env = { DEEP_ACCESS_TOKEN: TOKEN, ENCRYPTION_KEY: "e".repeat(64), INTERNAL_KEY: "i".repeat(64), DEEP_DATA_DIR: "/data" };

let upstream: Server;
let proxy: Server;
let seen: { method?: string; url?: string; headers?: IncomingMessage["headers"]; body?: string } = {};
let health: HealthState = { status: "starting", phase: "helix" };
let model: ModelState = { state: "unset" };
const base = () => `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

before(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += String(c);
    });
    req.on("end", () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "s=1" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  proxy = createProxy({ accessToken: TOKEN, upstreamPort: (upstream.address() as AddressInfo).port, health: async () => health, model: () => model });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
});
after(async () => {
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => upstream.close(r));
});

test("readEnv refuses missing or short secrets and never echoes a value", () => {
  assert.throws(() => readEnv({ ...env, DEEP_ACCESS_TOKEN: "short" }), /DEEP_ACCESS_TOKEN must be set/u);
  assert.throws(() => readEnv({ ...env, INTERNAL_KEY: undefined }), /INTERNAL_KEY/u);
  try {
    readEnv({ ...env, ENCRYPTION_KEY: "secret-but-short" });
  } catch (error) {
    assert.doesNotMatch(String(error), /secret-but-short/u);
  }
  assert.equal(readEnv(env).port, 3150);
});

test("every child binds loopback; foundry's API keeps network access off and has no reachable model endpoint", () => {
  const specs = childSpecs(readEnv(env));
  assert.deepEqual(specs.map((s) => s.name), ["helix", "executor", "api"]);
  const helix = specs[0]?.env ?? {};
  assert.match(helix.HELIX_HTTP_ADDR ?? "", /^127\.0\.0\.1:/u);
  assert.match(helix.HELIX_GRPC_ADDR ?? "", /^127\.0\.0\.1:/u);
  assert.equal(specs[1]?.env.EXECUTOR_HOST, "127.0.0.1");
  const api = specs[2]?.env ?? {};
  assert.equal(api.HOST, "127.0.0.1");
  assert.equal(api.ALLOW_NETWORK_ACCESS, undefined);
  assert.equal(api.OLLAMA_URL, "http://127.0.0.1:9");
  assert.equal(api.INLINE_WORKER, "true");
  for (const spec of specs) assert.equal(spec.env.DEEP_ACCESS_TOKEN, undefined, `${spec.name} never sees the proxy token`);
});

test("authorized: exact bearer only", () => {
  assert.equal(authorized(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(authorized(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(authorized(TOKEN, TOKEN), false);
  assert.equal(authorized(undefined, TOKEN), false);
});

test("upstream headers: host pinned to loopback; origin, cookie and the proxy token dropped; a workspace token becomes foundry's Authorization", () => {
  const out = upstreamHeaders({ host: "evil.example", origin: "https://evil.example", cookie: "a=1", authorization: `Bearer ${TOKEN}`, "x-deep-token": "ws-token-123456", "content-type": "application/json" });
  assert.equal(out.host, "127.0.0.1:3001");
  assert.equal(out.origin, undefined);
  assert.equal(out.cookie, undefined);
  assert.equal(out.authorization, "Bearer ws-token-123456");
  assert.equal(out["x-deep-token"], undefined);
  assert.equal(out["content-type"], "application/json");
  assert.equal(upstreamHeaders({ authorization: `Bearer ${TOKEN}` }).authorization, undefined, "no workspace token = no Authorization (Knowledge's admin path)");
});

test("proxy: 401 without the token, 404 outside /api/, forwards /api/ with the mapped headers, health is open and honest", async () => {
  assert.equal((await fetch(`${base()}/api/v1/workspaces`)).status, 401);
  assert.equal((await fetch(`${base()}/api/v1/workspaces`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${base()}/`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
  const res = await fetch(`${base()}/api/v1/workspaces/w1/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-deep-token": "ws-token-abcdef", origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ sql: "select 1" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null, "upstream cookies never reach Knowledge");
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/api/v1/workspaces/w1/query");
  assert.equal(seen.headers?.authorization, "Bearer ws-token-abcdef");
  assert.equal(seen.headers?.origin, undefined);
  assert.equal(seen.headers?.host, "127.0.0.1:3001");
  assert.equal(seen.body, JSON.stringify({ sql: "select 1" }));
  health = { status: "starting", phase: "executor" };
  const starting = await fetch(`${base()}/health`);
  assert.equal(starting.status, 503);
  assert.deepEqual(await starting.json(), { status: "starting", phase: "executor" });
  health = { status: "ok", phase: "serving" };
  assert.equal((await fetch(`${base()}/health`)).status, 200);
});

// ── C373: the reasoning model role → foundry ──

const role = (provider: string, model: string, extra: Record<string, string> = {}) => ({ [REASONING_ENV.provider]: provider, [REASONING_ENV.model]: model, ...extra });

test("the manifest gives the reasoning role to the deep service with the env names the supervisor reads (no embeddings: foundry has none)", () => {
  const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));
  const roles = manifest.settings.modelRoles as { role: string; usedBy: string[]; env?: Record<string, string>; required: boolean }[];
  const reasoning = roles.find((r) => r.role === "reasoning");
  assert.ok(reasoning?.usedBy.includes("deep") && reasoning.usedBy.includes("gbrain"));
  assert.deepEqual(reasoning?.env, { ...REASONING_ENV });
  assert.equal(reasoning?.required, false, "an optional role never blocks the deep service from starting");
  assert.ok(!roles.find((r) => r.role === "embeddings")?.usedBy.includes("deep"));
});

test("foundryProvider: role providers map to foundry's clients; raw data off and no background runs; unusable bindings are named", () => {
  assert.equal(foundryProvider({}), null);
  assert.deepEqual(foundryProvider(role("anthropic", "claude-sonnet-5", { [REASONING_ENV.key]: "k-ant" })), { provider: "claude", model: "claude-sonnet-5", apiKey: "k-ant", allowRawData: false, continuous: false });
  assert.deepEqual(foundryProvider(role("openai", "gpt-6-luna", { [REASONING_ENV.key]: "k-oai" })), { provider: "openai", model: "gpt-6-luna", apiKey: "k-oai", allowRawData: false, continuous: false });
  assert.deepEqual(foundryProvider(role("ollama", "qwen3:4b", { [REASONING_ENV.baseUrl]: "http://10.0.0.5:11434/v1" })), { provider: "custom", model: "qwen3:4b", baseUrl: "http://10.0.0.5:11434/v1", apiFormat: "chat-completions", allowRawData: false, continuous: false });
  assert.equal((foundryProvider(role("google", "gemini-2.5-flash", { [REASONING_ENV.key]: "k" })) as { baseUrl?: string }).baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal((foundryProvider(role("openai", "m", { [REASONING_ENV.key]: "k", [REASONING_ENV.baseUrl]: "https://proxy.example.com/v1" })) as { provider?: string }).provider, "custom");
  assert.deepEqual(foundryProvider(role("anthropic", "claude-sonnet-5")), { error: "the Anthropic reasoning model has no key" });
  assert.deepEqual(foundryProvider(role("lm-studio", "m")), { error: "the lm-studio reasoning model has no address" });
  assert.deepEqual(foundryProvider(role("voyage", "rerank-2")), { error: "provider voyage cannot run Foundry chat" });
});

test("ModelSync: PUT /provider in every workspace once; a refused model is reported without its key and retried later", async () => {
  const puts: { url: string; body: unknown }[] = [];
  let refuse = true;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/me")) return Response.json({ workspaces: [{ id: "w-1" }, { id: "w-2" }] });
    puts.push({ url, body: JSON.parse(String(init?.body)) });
    return refuse ? Response.json({ message: "401 from model: key sk-secret-1 is invalid" }, { status: 400 }) : Response.json({ ok: true });
  }) as typeof fetch;
  const unset = new ModelSync({}, { fetch: fake });
  await unset.tick();
  assert.deepEqual(unset.state, { state: "unset" });
  assert.equal(puts.length, 0, "no binding: foundry is never given a provider");
  const sync = new ModelSync(role("openai", "gpt-6-luna", { [REASONING_ENV.key]: "sk-secret-1" }), { fetch: fake, retryMs: 1000 });
  assert.equal(sync.state.state, "pending");
  await sync.tick(0);
  assert.equal(sync.state.state, "failed");
  assert.doesNotMatch(String(sync.state.error), /sk-secret-1/u);
  assert.match(String(sync.state.error), /\[key\]/u);
  refuse = false;
  await sync.tick(500);
  assert.equal(puts.length, 1, "no retry before retryMs");
  await sync.tick(2000);
  assert.equal(sync.state.state, "ok");
  assert.deepEqual(puts.slice(1).map((p) => p.url.replace(/^http:\/\/127\.0\.0\.1:\d+/u, "")), ["/api/v1/workspaces/w-1/provider", "/api/v1/workspaces/w-2/provider"]);
  await sync.tick(5000);
  assert.equal(puts.length, 3, "an applied workspace is not sent again");
});

test("proxy: /deep/status needs the token; callers can never touch /provider; analyst runs are refused while no model is applied", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(`${base()}/deep/status`)).status, 401);
  model = { state: "failed", provider: "openai", error: "no answer" };
  assert.deepEqual(await (await fetch(`${base()}/deep/status`, { headers: auth })).json(), { model });
  for (const [method, path] of [["GET", "/api/v1/workspaces/w1/provider"], ["PUT", "/api/v1/workspaces/w1/provider"], ["POST", "/api/v1/workspaces/w1/provider/pull"]] as const) {
    const res = await fetch(`${base()}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  seen = {};
  const run = () => fetch(`${base()}/api/v1/workspaces/w1/assistant/runs`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ goal: "Who is past due?", intent: "answer" }) });
  assert.equal((await run()).status, 409);
  assert.equal(seen.url, undefined, "the refused run never reached foundry");
  model = { state: "ok", provider: "openai", model: "gpt-6-luna" };
  assert.equal((await run()).status, 200);
  assert.equal(seen.url, "/api/v1/workspaces/w1/assistant/runs");
  model = { state: "unset" };
});
