// Deep knowledge companion (C336 F4): the token proxy is the only private-network listener in front of an upstream that
// has no sign-in; every child binds loopback; no model endpoint is reachable until a provider is configured.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { authorized, childSpecs, createProxy, type HealthState, readEnv, upstreamHeaders } from "../services/deep/supervisor.ts";

const TOKEN = "t".repeat(48);
const env = { DEEP_ACCESS_TOKEN: TOKEN, ENCRYPTION_KEY: "e".repeat(64), INTERNAL_KEY: "i".repeat(64), DEEP_DATA_DIR: "/data" };

let upstream: Server;
let proxy: Server;
let seen: { method?: string; url?: string; headers?: IncomingMessage["headers"]; body?: string } = {};
let health: HealthState = { status: "starting", phase: "helix" };
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
  proxy = createProxy({ accessToken: TOKEN, upstreamPort: (upstream.address() as AddressInfo).port, health: async () => health });
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
