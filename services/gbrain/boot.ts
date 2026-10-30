// C69: GBrain boot supervisor (exec'd by entrypoint.sh after the env is composed; upstream GBrain unmodified).
// 1. Serves a status /health on $PORT until GBrain serves it: 503 {"status":"starting"|"needs_attention", reason, ...}.
// 2. init (first boot) + `gbrain apply-migrations` under the crash-safe lock (migration-lock.ts), as children that get
//    every stop signal (the old `sh` entrypoint died on SIGTERM and left upstream's lease behind: qa1, 2026-10-12).
// 3. Spawns `gbrain serve --http`, forwards signals, exits with its status.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { constants, hostname } from "node:os";
import type { EmbedCheck } from "./embed-cause.ts";
import { AbortedError, type BootStatus, type Log, migrateCrashSafe } from "./migration-lock.ts";
import { applyEnv, type BuiltBrain, builtFrom, type ModelStatus, planModels } from "./models.ts";
import { connectPg, pgOptionsFromEnv } from "./pg-lock-session.ts";

/** C373: the model status file the helper serves at `/models` (labels only), on the service volume beside GBrain's home. */
export const MODEL_STATUS_FILE = "knowledge-models.json";

function writeStatus(home: string, status: ModelStatus): void {
  const path = `${home}/${MODEL_STATUS_FILE}`;
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...status, at: new Date().toISOString() })}\n`, { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

/** Loopback port of the embedding check; only the helper in this container calls it (helper.ts EMBED_CHECK_URL). */
export const EMBED_CHECK_PORT = 3142;
/** A check answers from its last result for this long: at most one provider call per minute, whoever asks. */
export const EMBED_CHECK_FRESH_MS = 60_000;
const EMBED_CHECK_TIMEOUT_MS = 26_000;
/** The most one boot's backfill may spend on the owner's key (`gbrain embed --max-usd`); the next boot continues the rest. */
export const EMBED_BACKFILL_MAX_USD = "1";

/** Runs embed-check.ts once. Only its one JSON line on stdout is read; stderr is dropped because upstream text can carry a key. */
export function runEmbedCheck(argv: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = EMBED_CHECK_TIMEOUT_MS): Promise<EmbedCheck | null> {
  return new Promise((resolve) => {
    const [file, ...args] = argv as [string, ...string[]];
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], env });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "") as EmbedCheck;
        resolve(parsed && typeof parsed.result === "string" ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** One check at a time, and none within `freshMs` of the last answer. */
export function embedChecker(run: () => Promise<EmbedCheck | null>, freshMs = EMBED_CHECK_FRESH_MS, now: () => number = Date.now): () => Promise<EmbedCheck | null> {
  let last: { value: EmbedCheck; at: number } | null = null;
  let running: Promise<EmbedCheck | null> | null = null;
  return () => {
    if (last && now() - last.at < freshMs) return Promise.resolve(last.value);
    running ??= run()
      .then((value) => {
        if (value) last = { value, at: now() };
        return value;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}

function embedCheckServer(check: () => Promise<EmbedCheck | null>, port = EMBED_CHECK_PORT): Server {
  const server = createServer((req, res) => {
    req.resume();
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/check") return reply(404, { error: { code: "not_found", message: "not found" } });
    void check().then(
      (value) => (value ? reply(200, value) : reply(503, { error: { code: "embed_check_failed", message: "the check gave no answer" } })),
      () => reply(503, { error: { code: "embed_check_failed", message: "the check gave no answer" } }),
    );
  });
  // a second boot on the port cannot happen in one container; a failed listen only loses the check, never the engine
  server.once("error", (e) => log("warn", "embed_check_unavailable", { message: e instanceof Error ? e.message : String(e) }));
  server.listen(port, "127.0.0.1");
  server.unref();
  return server;
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
  // A config.json that cannot be parsed never stops the boot (the status server must come up): the brain is kept as it is
  // and the status says "unreadable" (a plain attention for the owner), see models.ts BuiltBrain.keep.
  const readBuilt = (): BuiltBrain | null => {
    if (!existsSync(configPath)) return null;
    try {
      return builtFrom(JSON.parse(readFileSync(configPath, "utf8")));
    } catch {
      log("warn", "config_unreadable", {});
      return builtFrom(undefined);
    }
  };
  // QA-KN24-3: the status file of the PREVIOUS boot is stale from now on (the models may have changed): the helper answers
  // 503 engine_starting until this boot has written its own, so Knowledge never reads an old answer as the new one.
  try {
    rmSync(`${home}/${MODEL_STATUS_FILE}`, { force: true });
  } catch (e) {
    log("warn", "model_status_stale", { message: e instanceof Error ? e.message : String(e) });
  }
  let plan = planModels(env, readBuilt());
  let gbEnv = applyEnv(env, plan.env);
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
        if (enable !== 0) {
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
  const [file, ...args] = [...gbrain, "serve", "--http", "--bind", bind, "--port", String(port), "--suppress-bootstrap-token", "--fail-fast"] as unknown as [string, ...string[]];
  log("info", "serve_starting", { port });
  const child = spawn(file, args, { stdio: "inherit", env: gbEnv });
  serve = child;
  // Why embedding calls fail (helper path /embed-check), asked when recall reports them failing. And after each boot: a key was
  // replaced or embeddings were enabled, so fill the vectors the documents lack. A failed embed leaves its chunks without vectors,
  // and with no autopilot here nothing else fills them later. `--yes`: the owner entered this key for exactly this; `embed` refuses
  // without it in a non-interactive run (before 0.1.30 the enable path never backfilled). Skipped while the key does not work.
  const checkScript = `${import.meta.dirname}/embed-check.ts`;
  const launcher = (env.KNOWLEDGE_GBRAIN_LAUNCHER ?? "bun run").split(" ").filter(Boolean);
  const check = embedChecker(() => runEmbedCheck([...launcher, checkScript], gbEnv));
  embedCheckServer(check);
  if (plan.status.embeddings.active) {
    const embed = new AbortController();
    child.once("exit", () => embed.abort());
    void check().then(async (result) => {
      log("info", "embed_check", { result: result?.result ?? null, cause: result?.result === "failed" ? result.cause : null, status: result?.result === "failed" ? result.status : null });
      if (result?.result !== "ok" || embed.signal.aborted) return;
      const code = await runChild([...gbrain, "embed", "--stale", "--yes", "--max-usd", EMBED_BACKFILL_MAX_USD], embed.signal, undefined, gbEnv);
      log(code === 0 ? "info" : "warn", "embed_stale_done", { code });
    });
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
