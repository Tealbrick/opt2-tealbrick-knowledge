// C6 helper: creates GBrain sources for Knowledge areas through upstream's trusted local CLI
// (upstream refuses `sources_add` over MCP). Listens on loopback only; tb-exec exposes it on the
// manifest helper port after verifying the Knowledge instance assertion, for the declared paths only.
// C373: `POST /models` answers which models this boot runs with (boot.ts writes the labels-only status file).
// `POST /embed-check` asks boot.ts for one real embedding call and answers why it failed, as labels. This helper holds no provider
// key (tb-exec starts it without keys), so boot.ts, which holds the engine's env, makes the call on its loopback port.
// C392 R2: `POST /purge-page` {source, document} hard-deletes the engine page of a Knowledge document the owner forgot, through
// upstream's trusted local CLI `gbrain delete <slug> --purge` (upstream refuses `purge` over MCP: purge-params.ts at the pin).
// Only a `knowledge-docs/kdoc_<ULID>` page of a `ka-<24 hex>` source: the helper can never purge any other page.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const EMBED_CHECK_URL = "http://127.0.0.1:3142/check";
const SOURCE = /^ka-[a-f0-9]{24}$/u;
const NAME = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const DOCUMENT = /^kdoc_[0-9A-HJKMNP-TV-Z]{26}$/iu;
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
      const e = error as { signal?: string | null; code?: unknown };
      // labels only: the CLI output is never logged (it can carry the database address)
      const cause = cliCause(error);
      logLine({ event: "sources_add", outcome: "failed", cause, exitCode: typeof e.code === "number" ? e.code : null, signal: e.signal ?? null, ms });
      reject(new SourceAddError(cause));
    });
    child.stdin?.end();
  });
}

class PurgeError extends Error {
  readonly label: string;
  constructor(label: string) {
    super("page purge failed");
    this.label = label;
  }
}

/** A failed CLI run as a label (never its output: it can carry the database address or page text). */
function cliCause(error: unknown): string {
  const e = error as { killed?: boolean; signal?: string | null; code?: unknown };
  return e.killed ? "cli_timeout" : typeof e.code === "string" && /^E[A-Z]{2,30}$/u.test(e.code) ? e.code : typeof e.code === "number" ? `cli_exit_${e.code}` : e.signal ? `cli_signal_${e.signal}` : "cli_failed";
}

/**
 * Purge the engine page of one Knowledge document (`knowledge-docs/kdoc_<ulid>`, upstream lower-cases slugs). `--force`: the
 * owner's forget removes the page whatever revision it has (a live page or a soft-deleted tombstone alike). A fresh request id
 * per run: a page written again after an earlier purge is purged again, never answered from the old receipt. `page_not_found`
 * = there is no such page (never projected, or purged before) = `absent`.
 */
function purgePage(source: string, document: string): Promise<"purged" | "absent"> {
  const started = Date.now();
  const slug = `knowledge-docs/${document.toLowerCase()}`;
  const args = ["run", `${root}/src/cli.ts`, "delete", slug, "--source-id", source, "--purge", "--force", "--request-id", randomUUID(), "--json"];
  return new Promise((resolve, reject) => {
    const child = execFile("bun", args, { timeout: SOURCES_ADD_TIMEOUT_MS, killSignal: "SIGKILL" }, (error, stdout) => {
      const ms = Date.now() - started;
      if (!error) {
        logLine({ event: "page_purge", outcome: "purged", ms });
        return resolve("purged");
      }
      if (cliErrorCode(stdout) === "page_not_found") {
        logLine({ event: "page_purge", outcome: "absent", ms });
        return resolve("absent");
      }
      const cause = cliCause(error);
      logLine({ event: "page_purge", outcome: "failed", cause, ms });
      reject(new PurgeError(cause));
    });
    child.stdin?.end();
  });
}

/**
 * The error code of a `--json` CLI failure, or null. Under `--json` upstream writes exactly one envelope to stdout with the
 * code at the top level (`writeCliError`, src/cli/cli-error.ts:53-74 at the pin; an NDJSON stream ends with that envelope as
 * its last line). Read from the LAST line that parses as a JSON object: `code`, else `error.code`. Never a substring match:
 * page text or another error that mentions `page_not_found` must not count as an absent page.
 */
function cliErrorCode(stdout: string): string | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let doc: unknown;
    try {
      doc = JSON.parse(lines[i] as string);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
    const d = doc as { code?: unknown; error?: { code?: unknown } | null };
    const code = typeof d.code === "string" ? d.code : d.error && typeof d.error.code === "string" ? d.error.code : null;
    return code;
  }
  return null;
}

async function readJson(req: AsyncIterable<unknown>): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
  if (req.method === "POST" && req.url === "/purge-page") {
    const input = await readJson(req);
    if (!input || typeof input.source !== "string" || !SOURCE.test(input.source) || typeof input.document !== "string" || !DOCUMENT.test(input.document)) {
      return reply(400, { error: { code: "invalid_request", message: "source must be ka-<24 hex>, document kdoc_<ULID>" } });
    }
    const { source, document } = input as { source: string; document: string };
    // One CLI process at a time (shared with `sources add`).
    const run = queue.then(() => purgePage(source, document));
    queue = run.catch(() => undefined);
    try {
      return reply(200, { status: await run });
    } catch (e) {
      const cause = e instanceof PurgeError ? e.label : "cli_failed";
      return reply(502, { error: { code: "page_purge_failed", message: "the engine could not purge the page", details: { cause } } });
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
// Loopback only: the one way in is tb-exec's helper proxy, which forwards a request only with a valid instance assertion
// (signed by this Knowledge instance's key, bound to this service, path and body, never replayed) and only for the manifest's
// declared paths. SDK tests: opt2-tealbrick-sdk packages/miniapp-sdk/test/exec/tb-exec.test.ts "helper proxy refuses a wrong
// key, a sibling service, a tampered body, a missing header and a replay" and "helper proxy refuses an undeclared path even
// with a valid assertion"; parseArgs there refuses a non-loopback helper target. test/gbrain-helper.test.ts checks the bind.
server.listen(3141, "127.0.0.1", () => logLine({ event: "helper_listening", port: 3141 }));
