// Deep knowledge companion (C130, C325, FOUNDRY-DESIGN v2 §2): helix-foundry at a pinned commit, unmodified.
// The supervisor starts HelixDB, foundry's executor and foundry's API (with its worker inline) on LOOPBACK only, then one
// token proxy on $PORT — the only listener on the private network. Upstream has no sign-in (a request without
// Authorization is the owner of every workspace), so the proxy is the wall: it needs `Authorization: Bearer
// <DEEP_ACCESS_TOKEN>` (Knowledge's generated secret) and passes a foundry workspace token, when Knowledge sends one in
// `x-deep-token`, as foundry's own `Authorization` (least privilege per deep space).
// Any child that exits stops the others and the supervisor (the platform restarts the service).
import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export const API_PORT = 3001;
export const EXECUTOR_PORT = 3002;
export const HELIX_HTTP_PORT = 6969;
export const HELIX_GRPC_PORT = 6970;
/** Only foundry's API is reachable through the proxy; its web app and everything else are not served. */
export const FORWARDED_PREFIX = "/api/";
/** Request bodies the proxy forwards (CSV/Parquet uploads are the large ones). */
export const MAX_BODY_BYTES = 256 * 1024 * 1024;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "origin", "cookie", "authorization", "x-deep-token"]);

export interface ChildSpec {
  name: "helix" | "executor" | "api";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SupervisorEnv {
  accessToken: string;
  encryptionKey: string;
  internalKey: string;
  port: number;
  dataDir: string;
  foundryRoot: string;
  helixBin: string;
  nodeBin: string;
}

export function readEnv(env: Record<string, string | undefined>): SupervisorEnv {
  const need = (name: string, min: number) => {
    const value = env[name] ?? "";
    if (value.length < min) throw new Error(`${name} must be set (at least ${min} characters)`);
    return value;
  };
  return {
    accessToken: need("DEEP_ACCESS_TOKEN", 32),
    encryptionKey: need("ENCRYPTION_KEY", 32),
    internalKey: need("INTERNAL_KEY", 32),
    port: Number(env.PORT ?? 3150),
    dataDir: env.DEEP_DATA_DIR ?? "/data",
    foundryRoot: env.FOUNDRY_ROOT ?? "/opt/foundry",
    helixBin: env.HELIX_BIN ?? "/usr/local/bin/helix-server",
    nodeBin: env.NODE_BIN ?? process.execPath,
  };
}

/** The three loopback children, in start order. No model endpoint is set: foundry's own model runs only after Knowledge configures a provider through the API (C322(2), model roles). */
export function childSpecs(e: SupervisorEnv): ChildSpec[] {
  const base = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", HOME: e.dataDir };
  const foundryData = join(e.dataDir, "foundry");
  return [
    {
      name: "helix",
      command: e.helixBin,
      args: [],
      cwd: join(e.dataDir, "helix"),
      env: { ...base, HELIX_HTTP_ADDR: `127.0.0.1:${HELIX_HTTP_PORT}`, HELIX_GRPC_ADDR: `127.0.0.1:${HELIX_GRPC_PORT}`, DB_PATH: join(e.dataDir, "helix", "db") + "/", RUST_LOG: "server=info,db=info" },
    },
    {
      name: "executor",
      command: e.nodeBin,
      args: ["--import", "tsx", "services/executor/src/server.ts"],
      cwd: e.foundryRoot,
      env: { ...base, INTERNAL_KEY: e.internalKey, DATA_DIR: foundryData, EXECUTOR_HOST: "127.0.0.1", EXECUTOR_PORT: String(EXECUTOR_PORT), DUCKDB_MEMORY: "512MB" },
    },
    {
      name: "api",
      command: e.nodeBin,
      args: ["--import", "tsx", "apps/api/src/server.ts"],
      cwd: e.foundryRoot,
      env: {
        ...base,
        HOST: "127.0.0.1",
        PORT: String(API_PORT),
        APP_ORIGIN: `http://localhost:${API_PORT}`,
        HELIX_URL: `http://127.0.0.1:${HELIX_HTTP_PORT}`,
        EXECUTOR_URL: `http://127.0.0.1:${EXECUTOR_PORT}`,
        INTERNAL_KEY: e.internalKey,
        ENCRYPTION_KEY: e.encryptionKey,
        DATA_DIR: foundryData,
        INLINE_WORKER: "true",
        // a closed loopback port: no model call leaves the service until a provider is set (zero egress by default)
        OLLAMA_URL: "http://127.0.0.1:9",
      },
    },
  ];
}

/** Constant-time check of `Authorization: Bearer <token>`. */
export function authorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer (\S+)$/u.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1] as string);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Headers forwarded to foundry: hop-by-hop, host, origin, cookies and both tokens are dropped; a workspace token becomes foundry's `Authorization`. */
export function upstreamHeaders(incoming: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out.host = `127.0.0.1:${API_PORT}`;
  const workspaceToken = incoming["x-deep-token"];
  if (typeof workspaceToken === "string" && /^\S{8,512}$/u.test(workspaceToken)) out.authorization = `Bearer ${workspaceToken}`;
  return out;
}

export type HealthState = { status: "starting" | "ok" | "failed"; phase: string };

export function createProxy(opts: { accessToken: string; upstreamPort?: number; health: () => Promise<HealthState> }): Server {
  const upstreamPort = opts.upstreamPort ?? API_PORT;
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const path = req.url ?? "/";
    if (path === "/health" && req.method === "GET") {
      const state = await opts.health().catch((): HealthState => ({ status: "failed", phase: "health" }));
      return json(state.status === "ok" ? 200 : 503, state);
    }
    if (!authorized(req.headers.authorization, opts.accessToken)) return json(401, { error: "unauthorized" });
    if (!path.startsWith(FORWARDED_PREFIX)) return json(404, { error: "not_found" });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    const upstream = httpRequest({ host: "127.0.0.1", port: upstreamPort, method: req.method, path, headers: upstreamHeaders(req.headers) }, (answer) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !["connection", "keep-alive", "transfer-encoding", "set-cookie"].includes(name)) headers[name] = value;
      res.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) json(502, { error: "deep_unavailable" });
      else res.destroy();
    });
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        upstream.destroy();
        if (!res.headersSent) json(413, { error: "too_large" });
        req.destroy();
      }
    });
    req.pipe(upstream);
  });
}

async function apiHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const e = readEnv(env);
  for (const dir of [join(e.dataDir, "helix", "db"), join(e.dataDir, "foundry")]) mkdirSync(dir, { recursive: true });
  const children = new Map<string, ChildProcess>();
  let state: HealthState = { status: "starting", phase: "helix" };
  let stopping = false;
  let exitCode = 0;
  const log = (level: string, msg: string, fields: Record<string, unknown> = {}) => process.stderr.write(`${JSON.stringify({ level, msg, svc: "deep", ...fields })}\n`);

  const stopAll = async (code: number) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    state = { status: "failed", phase: "stopping" };
    for (const child of [...children.values()].reverse()) child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 10_000).unref());
    for (const child of children.values()) if (child.exitCode === null) child.kill("SIGKILL");
    server.close();
  };

  const server = createProxy({
    accessToken: e.accessToken,
    health: async () => (state.status === "ok" && !(await apiHealthy()) ? { status: "failed", phase: "api" } : state),
  });
  await new Promise<void>((resolve) => server.listen(e.port, "::", resolve));
  log("info", "proxy_listening", { port: e.port });

  for (const spec of childSpecs(e)) {
    state = { status: "starting", phase: spec.name };
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "inherit", "inherit"] });
    children.set(spec.name, child);
    child.once("exit", (code, signal) => {
      if (stopping) return;
      log("error", "child_exited", { child: spec.name, code, signal });
      void stopAll(1);
    });
    child.once("error", () => void stopAll(127));
    // wait for each loopback port before starting the next child
    const port = spec.name === "helix" ? HELIX_HTTP_PORT : spec.name === "executor" ? EXECUTOR_PORT : API_PORT;
    const ready = await waitForPort(port, 180_000, () => stopping);
    if (!ready) {
      log("error", "child_not_ready", { child: spec.name, port });
      await stopAll(1);
      return exitCode;
    }
  }
  state = { status: "ok", phase: "serving" };
  log("info", "deep_ready");
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void stopAll(0));
  await new Promise<void>((resolve) => server.once("close", resolve));
  return exitCode;
}

async function waitForPort(port: number, timeoutMs: number, aborted: () => boolean): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !aborted()) {
    const open = await new Promise<boolean>((resolve) => {
      const probe = httpRequest({ host: "127.0.0.1", port, method: "GET", path: "/", timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      probe.on("error", () => resolve(false));
      probe.on("timeout", () => {
        probe.destroy();
        resolve(false);
      });
      probe.end();
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${JSON.stringify({ level: "error", msg: "deep_boot_failed", svc: "deep", error: error instanceof Error ? error.message : "unknown" })}\n`);
      process.exit(1);
    },
  );
}
