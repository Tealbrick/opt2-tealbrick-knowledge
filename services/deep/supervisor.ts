// Deep knowledge companion (C130, C325, FOUNDRY-DESIGN v2 §2): helix-foundry at a pinned commit, unmodified.
// The supervisor starts HelixDB, foundry's executor and foundry's API (with its worker inline) on LOOPBACK only, then one
// token proxy on $PORT — the only listener on the private network. Upstream has no sign-in (a request without
// Authorization is the owner of every workspace), so the proxy is the wall: it needs `Authorization: Bearer
// <DEEP_ACCESS_TOKEN>` (Knowledge's generated secret) and passes a foundry workspace token, when Knowledge sends one in
// `x-deep-token`, as foundry's own `Authorization` (least privilege per deep space).
// Any child that exits stops the others and the supervisor (the platform restarts the service).
// C373: the Knowledge `reasoning` model role reaches this service as env (tb-exec fills KN_REASONING_*; a binding change
// restarts it). The supervisor gives it to foundry with `PUT /provider` in every workspace (foundry tests the model with
// one structured call first). Callers can never set or read the provider through the proxy, and the proxy refuses
// foundry's analyst runs while no model is applied (zero model egress without a binding).
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

/** The env names tb-exec fills from the `reasoning` model role (tealbrick.manifest.json settings.modelRoles, shared with gbrain). */
export const REASONING_ENV = { provider: "KN_REASONING_PROVIDER", model: "KN_REASONING_MODEL", baseUrl: "KN_REASONING_BASE_URL", key: "KN_REASONING_KEY" } as const;

/** Foundry's provider settings (packages/shared ProviderSchema at the pinned commit). */
export interface FoundryProvider {
  provider: "claude" | "openai" | "azure" | "custom";
  model: string;
  baseUrl?: string;
  apiFormat?: "chat-completions";
  apiKey?: string;
  /** foundry sends only schema + masked samples to the model; rows stay in the service (the agent gets them from deep_ask) */
  allowRawData: false;
  /** no background repair runs (they would spend model budget nobody asked for) */
  continuous: false;
}

/** OpenAI-compatible defaults for role providers foundry has no native client for (MODEL_PROVIDERS defaultBaseUrl). */
const COMPATIBLE_BASE: Record<string, string> = {
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
};
const COMPATIBLE_NEEDS_URL = new Set(["ollama", "llama-server", "lm-studio", "litellm", "openai-compatible"]);

/** The reasoning role binding as foundry settings: null = no binding; `{error}` = a binding foundry cannot use. */
export function foundryProvider(env: Record<string, string | undefined>): FoundryProvider | { error: string } | null {
  const provider = (env[REASONING_ENV.provider] ?? "").trim();
  const model = (env[REASONING_ENV.model] ?? "").trim();
  const baseUrl = (env[REASONING_ENV.baseUrl] ?? "").trim() || undefined;
  const key = env[REASONING_ENV.key] || undefined;
  if (!provider && !model) return null;
  if (!provider || !model) return { error: "the reasoning role has no provider or no model" };
  const base = { model: model.slice(0, 150), allowRawData: false as const, continuous: false as const, ...(key ? { apiKey: key } : {}) };
  if (provider === "anthropic") return key ? { provider: "claude", ...base } : { error: "the Anthropic reasoning model has no key" };
  if (provider === "openai" && (!baseUrl || /^https:\/\/api\.openai\.com\/v1\/?$/u.test(baseUrl))) return key ? { provider: "openai", ...base } : { error: "the OpenAI reasoning model has no key" };
  if (provider === "azure-openai") return baseUrl ? { provider: "azure", ...base, baseUrl } : { error: "the Azure reasoning model has no address" };
  const url = baseUrl ?? COMPATIBLE_BASE[provider];
  if (provider === "openai" || COMPATIBLE_BASE[provider] || COMPATIBLE_NEEDS_URL.has(provider)) {
    return url ? { provider: "custom", ...base, baseUrl: url, apiFormat: "chat-completions" } : { error: `the ${provider} reasoning model has no address` };
  }
  return { error: `provider ${provider.slice(0, 32)} cannot run Foundry chat` };
}

export type ModelState = { state: "unset" | "pending" | "ok" | "failed"; provider?: string; model?: string; error?: string };

/**
 * Applies the reasoning binding to every foundry workspace (new workspaces appear when Knowledge adds an area) and keeps
 * the result for `/deep/status`. Foundry checks the model on PUT (one structured call); a failure retries after `retryMs`.
 */
export class ModelSync {
  state: ModelState;
  private readonly settings: FoundryProvider | null;
  private readonly applied = new Set<string>();
  private retryAt = 0;
  private readonly api: string;
  private readonly fetcher: typeof fetch;
  private readonly retryMs: number;

  constructor(env: Record<string, string | undefined>, opts: { apiPort?: number; fetch?: typeof fetch; retryMs?: number } = {}) {
    this.api = `http://127.0.0.1:${opts.apiPort ?? API_PORT}`;
    this.fetcher = opts.fetch ?? fetch;
    this.retryMs = opts.retryMs ?? 5 * 60_000;
    const resolved = foundryProvider(env);
    if (!resolved) {
      this.settings = null;
      this.state = { state: "unset" };
    } else if ("error" in resolved) {
      this.settings = null;
      this.state = { state: "failed", provider: (env[REASONING_ENV.provider] ?? "").slice(0, 32), error: resolved.error };
    } else {
      this.settings = resolved;
      this.state = { state: "pending", provider: (env[REASONING_ENV.provider] ?? "").slice(0, 32), model: resolved.model };
    }
  }

  /** One pass: PUT /provider in each workspace not done yet. Never throws. */
  async tick(now = Date.now()): Promise<void> {
    if (!this.settings || now < this.retryAt) return;
    try {
      const me = (await (await this.fetcher(`${this.api}/api/v1/me`, { signal: AbortSignal.timeout(10_000) })).json()) as { workspaces?: { id?: unknown }[] };
      const ids = (me.workspaces ?? []).flatMap((w) => (typeof w.id === "string" && /^[A-Za-z0-9-]{1,100}$/u.test(w.id) ? [w.id] : []));
      for (const id of ids) {
        if (this.applied.has(id)) continue;
        const res = await this.fetcher(`${this.api}/api/v1/workspaces/${id}/provider`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.settings),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
          throw new Error(String(body.message ?? body.error ?? `foundry answered ${res.status}`));
        }
        this.applied.add(id);
      }
      if (ids.length) this.state = { ...this.state, state: "ok", error: undefined };
    } catch (error) {
      const key = this.settings.apiKey;
      let message = error instanceof Error ? error.message : "failed";
      if (key) message = message.split(key).join("[key]");
      this.state = { ...this.state, state: "failed", error: `the reasoning model did not answer Foundry's test: ${message}`.slice(0, 200) };
      this.retryAt = now + this.retryMs;
    }
  }
}

/** Provider settings belong to the supervisor: callers can neither read nor change them. */
const PROVIDER_PATH = /^\/api\/v1\/workspaces\/[^/]+\/provider(?:[/?]|$)/u;
/** Foundry's analyst calls the model: refused while no model is applied (second line; Knowledge checks first). */
const MODEL_RUN_PATH = /^\/api\/v1\/workspaces\/[^/]+\/(?:assistant\/runs(?:\/[^/]+\/resume)?|onboarding\/(?:build|recommend)|home\/metrics\/regenerate)(?:\?|$)/u;

export function createProxy(opts: { accessToken: string; upstreamPort?: number; health: () => Promise<HealthState>; model?: () => ModelState }): Server {
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
    const model = opts.model?.() ?? { state: "unset" };
    if (path === "/deep/status" && req.method === "GET") return json(200, { model });
    if (!path.startsWith(FORWARDED_PREFIX)) return json(404, { error: "not_found" });
    if (PROVIDER_PATH.test(path)) return json(403, { error: "deep_provider_owned", message: "the model comes from the reasoning role (Keys and models)" });
    if (req.method === "POST" && MODEL_RUN_PATH.test(path) && model.state !== "ok") return json(409, { error: "deep_model_off", message: "Foundry chat needs a reasoning model" });
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

  const models = new ModelSync(env);
  const server = createProxy({
    accessToken: e.accessToken,
    health: async () => (state.status === "ok" && !(await apiHealthy()) ? { status: "failed", phase: "api" } : state),
    model: () => models.state,
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
  log("info", "deep_ready", { model: models.state.state });
  // the reasoning role → foundry, now and for every workspace Knowledge adds later
  const applyModel = async () => {
    const before = models.state.state;
    await models.tick();
    if (models.state.state !== before) log(models.state.state === "failed" ? "warn" : "info", "deep_model", { state: models.state.state, provider: models.state.provider ?? "", error: models.state.error ?? "" });
  };
  await applyModel();
  const modelTimer = setInterval(() => void applyModel(), 30_000);
  modelTimer.unref();
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
