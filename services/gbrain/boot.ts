// C69: GBrain boot supervisor (exec'd by entrypoint.sh after the env is composed; upstream GBrain unmodified).
// 1. Serves a status /health on $PORT until GBrain serves it: 503 {"status":"starting"|"needs_attention", reason, ...}.
// 2. init (first boot) + `gbrain apply-migrations` under the crash-safe lock (migration-lock.ts), as children that get
//    every stop signal (the old `sh` entrypoint died on SIGTERM and left upstream's lease behind: qa1, 2026-10-12).
// 3. Spawns `gbrain serve --http`, forwards signals, exits with its status.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { constants, hostname } from "node:os";
import { AbortedError, type BootStatus, type Log, migrateCrashSafe } from "./migration-lock.ts";
import { applyEnv, builtFrom, type ModelStatus, planModels } from "./models.ts";
import { connectPg, pgOptionsFromEnv } from "./pg-lock-session.ts";

/** C373: the model status file the helper serves at `/models` (labels only), on the service volume beside GBrain's home. */
export const MODEL_STATUS_FILE = "knowledge-models.json";

function writeStatus(home: string, status: ModelStatus): void {
  const path = `${home}/${MODEL_STATUS_FILE}`;
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...status, at: new Date().toISOString() })}\n`, { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGQUIT"];
const FORWARDED: readonly NodeJS.Signals[] = [...STOP_SIGNALS, "SIGHUP", "SIGUSR1", "SIGUSR2"];
/** a stopped migration runner gets this long to release its lease itself before SIGKILL */
export const CHILD_STOP_GRACE_MS = 5_000;

const log: Log = (level, event, fields) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, component: "gbrain-boot", event, ...fields })}\n`);
};

function signalCode(sig: NodeJS.Signals | null): number {
  return 128 + (sig ? (constants.signals[sig] ?? 15) : 15);
}

function seconds(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v * 1000 : fallback;
}

/** Runs one GBrain CLI command as a child; on `signal` it forwards SIGTERM, then SIGKILL after the grace period. */
export function runChild(argv: readonly string[], signal: AbortSignal, graceMs = CHILD_STOP_GRACE_MS, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve) => {
    const [file, ...args] = argv as [string, ...string[]];
    const child = spawn(file, args, { stdio: "inherit", env });
    let kill: NodeJS.Timeout | null = null;
    const onAbort = () => {
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(127);
    });
    child.once("exit", (code, sig) => {
      signal.removeEventListener("abort", onAbort);
      if (kill) clearTimeout(kill);
      resolve(code ?? signalCode(sig));
    });
    if (signal.aborted) onAbort();
  });
}

function statusServer(port: number, bind: string, current: () => BootStatus): Promise<Server> {
  const server = createServer((req, res) => {
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "10" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(current()));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const root = env.GBRAIN_ROOT ?? "/opt/gbrain";
  const home = env.GBRAIN_HOME ?? "/data";
  // tests swap the launcher (default: upstream's own `bun run src/cli.ts`)
  const gbrain = [...(env.KNOWLEDGE_GBRAIN_LAUNCHER ?? "bun run").split(" ").filter(Boolean), `${root}/src/cli.ts`];
  const port = Number(env.PORT ?? 3131);
  const bind = env.GBRAIN_BIND ?? "::";
  const host = hostname();

  let status: BootStatus = { status: "starting", phase: "migrations" };
  const stop = new AbortController();
  let stopSignal: NodeJS.Signals | null = null;
  let serve: ChildProcess | null = null;
  for (const sig of FORWARDED) {
    process.on(sig, () => {
      if (serve) {
        serve.kill(sig);
        return;
      }
      if (STOP_SIGNALS.includes(sig) && !stopSignal) {
        stopSignal = sig;
        stop.abort();
      }
    });
  }

  // C373: the models this boot runs with (model roles, else the legacy provider setting); the env GBrain gets is composed here
  const configPath = `${home}/.gbrain/config.json`;
  const readBuilt = () => (existsSync(configPath) ? builtFrom(JSON.parse(readFileSync(configPath, "utf8"))) : null);
  let plan = planModels(env, readBuilt());
  let gbEnv = applyEnv(env, plan.env);
  let enabled = false;
  const server = await statusServer(port, bind, () => status);
  try {
    const pg = pgOptionsFromEnv(env);
    await migrateCrashSafe({
      connect: () => connectPg(pg),
      host,
      log,
      signal: stop.signal,
      onStatus: (s) => {
        status = s;
      },
      waitMs: seconds(env, "KNOWLEDGE_MIGRATION_WAIT_S", 240_000),
      staleAfterMs: seconds(env, "KNOWLEDGE_MIGRATION_LOCK_STALE_S", 180_000),
      pollMs: seconds(env, "KNOWLEDGE_MIGRATION_POLL_S", 2_000),
      attentionMinMs: seconds(env, "KNOWLEDGE_MIGRATION_RETRY_MIN_S", 30_000),
      attentionMaxMs: seconds(env, "KNOWLEDGE_MIGRATION_RETRY_MAX_S", 300_000),
      run: async (signal) => {
        plan = planModels(env, readBuilt());
        gbEnv = applyEnv(env, plan.env);
        if (plan.init) {
          let code = await runChild([...gbrain, "init", "--non-interactive", ...plan.init], signal, undefined, gbEnv);
          if (code !== 0 && plan.init[0] !== "--no-embedding" && !signal.aborted) {
            // GBrain refused this embeddings model (unknown size, unknown model): start without embeddings, say so
            log("warn", "embeddings_init_failed", { model: plan.status.embeddings.wanted?.model ?? null, code });
            code = await runChild([...gbrain, "init", "--non-interactive", "--no-embedding"], signal, undefined, gbEnv);
            plan.status.embeddings = { ...plan.status.embeddings, state: "failed", active: null };
          }
          if (code !== 0) return code;
        }
        const code = await runChild([...gbrain, "apply-migrations", "--yes", "--no-autopilot-install"], signal, undefined, gbEnv);
        if (code !== 0 || !plan.enable) return code;
        // a brain built without embeddings and a binding now: enable in place (refuses, changing nothing, when it cannot fit)
        const enable = await runChild([...gbrain, "embeddings", "enable", ...plan.enable], signal, undefined, gbEnv);
        enabled = enable === 0;
        if (!enabled) {
          log("warn", "embeddings_enable_failed", { model: plan.status.embeddings.wanted?.model ?? null, code: enable });
          plan.status.embeddings = { ...plan.status.embeddings, state: "failed", active: null };
        }
        return 0;
      },
    });
  } catch (e) {
    await closeServer(server);
    if (e instanceof AbortedError) return signalCode(stopSignal);
    log("error", "boot_failed", { message: e instanceof Error ? e.message : String(e) });
    return 1;
  }
  status = { status: "starting", phase: "serve" };
  await closeServer(server);
  if (stopSignal) return signalCode(stopSignal);
  try {
    writeStatus(home, plan.status);
  } catch (e) {
    log("warn", "model_status_unwritten", { message: e instanceof Error ? e.message : String(e) });
  }
  log("info", "models", { embeddings: plan.status.embeddings.state, embeddingModel: plan.status.embeddings.active?.model ?? null, reasoning: plan.status.reasoning.state, reasoningModel: plan.status.reasoning.model });

  // Private-network shape from upstream docs/mcp/DEPLOY.md ("Plain HTTP"): no --public-url, so the OAuth issuer stays
  // the default http://localhost:<port> (the MCP SDK refuses a non-HTTPS issuer on any other host). Knowledge's
  // client_credentials tokens are bound to that default resource and verified without reading the request host.
  const [file, ...args] = [...gbrain, "serve", "--http", "--bind", bind, "--port", String(port), "--suppress-bootstrap-token", "--fail-fast"] as [string, ...string[]];
  log("info", "serve_starting", { port });
  const child = spawn(file, args, { stdio: "inherit", env: gbEnv });
  serve = child;
  if (enabled) {
    // embeddings were just enabled: vectors for the existing chunks, beside serve (Postgres; per-source upstream locks)
    const embed = new AbortController();
    child.once("exit", () => embed.abort());
    void runChild([...gbrain, "embed", "--stale"], embed.signal, undefined, gbEnv).then((code) => log(code === 0 ? "info" : "warn", "embed_stale_done", { code }));
  }
  return new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code, sig) => resolve(code ?? signalCode(sig)));
  });
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
