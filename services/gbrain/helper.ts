// C6 helper: creates GBrain sources for Knowledge areas through upstream's trusted local CLI
// (upstream refuses `sources_add` over MCP). Listens on loopback only; tb-exec exposes it on the
// manifest helper port after verifying the Knowledge instance assertion, for the declared paths only.
// C373: `POST /models` answers which models this boot runs with (boot.ts writes the labels-only status file).
// `POST /embed-check` asks boot.ts for one real embedding call and answers why it failed, as labels. This helper holds no provider
// key (tb-exec starts it without keys), so boot.ts, which holds the engine's env, makes the call on its loopback port.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const EMBED_CHECK_URL = "http://127.0.0.1:3142/check";
const SOURCE = /^ka-[a-f0-9]{24}$/u;
const NAME = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const root = process.env.GBRAIN_ROOT ?? "/opt/gbrain";
const home = process.env.GBRAIN_HOME ?? "/data";
let queue: Promise<unknown> = Promise.resolve();

/**
 * C390 (knowledge#38): below the SDK's helper timeout (30 s), so a slow CLI answers 502 `cli_timeout` with a cause and
 * never shows up as an unreachable helper (503). stdin is closed: the CLI can never wait for an answer.
 */
export const SOURCES_ADD_TIMEOUT_MS = 25_000;

/** One log line per `sources add` (stderr reaches the service log): labels and numbers only, never CLI output. */
function logLine(fields: Record<string, string | number | null>): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: "gbrain-helper", ...fields }));
}

class SourceAddError extends Error {
  readonly label: string;
  constructor(label: string) {
    super("sources add failed");
    this.label = label;
  }
}

function addSource(id: string, name: string): Promise<"created" | "exists"> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile("bun", ["run", `${root}/src/cli.ts`, "sources", "add", id, "--name", name], { timeout: SOURCES_ADD_TIMEOUT_MS, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      const ms = Date.now() - started;
      if (!error) {
        logLine({ event: "sources_add", outcome: "created", ms });
        return resolve("created");
      }
      if (out.includes("source_id_taken")) {
        logLine({ event: "sources_add", outcome: "exists", ms });
        return resolve("exists");
      }
      const e = error as { killed?: boolean; signal?: string | null; code?: unknown };
      // labels only: the CLI output is never logged or scanned (it can carry the database address)
      const cause = e.killed ? "cli_timeout" : typeof e.code === "string" && /^E[A-Z]{2,30}$/u.test(e.code) ? e.code : typeof e.code === "number" ? `cli_exit_${e.code}` : e.signal ? `cli_signal_${e.signal}` : "cli_failed";
      logLine({ event: "sources_add", outcome: "failed", cause, exitCode: typeof e.code === "number" ? e.code : null, signal: e.signal ?? null, ms });
      reject(new SourceAddError(cause));
    });
    child.stdin?.end();
  });
}

const server = createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && req.url === "/models") {
    req.resume(); // the body is empty: drain it
    try {
      // labels only (models.ts ModelStatus): never a key or a base URL
      return reply(200, JSON.parse(await readFile(`${home}/knowledge-models.json`, "utf8")));
    } catch {
      return reply(503, { error: { code: "engine_starting", message: "the memory engine has not started yet" } });
    }
  }
  if (req.method === "POST" && req.url === "/embed-check") {
    req.resume(); // the body is empty: drain it
    try {
      const answer = await fetch(EMBED_CHECK_URL, { method: "POST", signal: AbortSignal.timeout(28_000) });
      return reply(answer.status, await answer.json());
    } catch {
      return reply(503, { error: { code: "engine_starting", message: "the memory engine has not started yet" } });
    }
  }
  if (req.method !== "POST" || req.url !== "/sources") return reply(404, { error: { code: "not_found", message: "not found" } });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let input: { id?: unknown; name?: unknown };
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reply(400, { error: { code: "invalid_request", message: "invalid JSON" } });
  }
  if (typeof input.id !== "string" || !SOURCE.test(input.id) || typeof input.name !== "string" || !NAME.test(input.name)) {
    return reply(400, { error: { code: "invalid_request", message: "id must be ka-<24 hex>, name a slug" } });
  }
  const { id, name } = input as { id: string; name: string };
  // One CLI process at a time.
  const run = queue.then(() => addSource(id, name));
  queue = run.catch(() => undefined);
  try {
    reply(200, { status: await run });
  } catch (e) {
    const cause = e instanceof SourceAddError ? e.label : "cli_failed";
    reply(502, { error: { code: "source_add_failed", message: "the engine could not create the source", details: { cause } } });
  }
});
server.listen(3141, "127.0.0.1", () => logLine({ event: "helper_listening", port: 3141 }));
