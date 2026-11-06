// KN-EMBED: why an embedding call failed, as labels. The error shapes below are the ones real GBrain 0.60.424 threw against a fake
// OpenAI endpoint (services/gbrain/embed-check.ts run per failure mode, 2026-10-30).
import assert from "node:assert/strict";
import { test } from "node:test";
import { embedChecker, runEmbedCheck } from "../services/gbrain/boot.ts";
import { classifyEmbedFailure, EMBED_CAUSES, type EmbedCheck } from "../services/gbrain/embed-cause.ts";
import { EMBED_CAUSES as APP_CAUSES, readEmbedCheck } from "../src/knowledge.ts";

const apiError = (statusCode: number, responseBody: string) => Object.assign(new Error(responseBody), { name: "AI_APICallError", statusCode, responseBody });
const wrapped = (cause: unknown, message = "[embed(openai:text-embedding-3-small)] failed") => Object.assign(new Error(message), { name: "AIConfigError", cause });

test("each failure maps to one cause: a bad key only for 401 and 403", () => {
  const rows: [unknown, string, number | null][] = [
    [wrapped(apiError(401, "Your API key has been invalidated.")), "auth", 401],
    [wrapped(apiError(401, "Incorrect API key provided: <REDACTED:masked_key>.")), "auth", 401],
    [wrapped(apiError(403, "Project is not allowed")), "auth", 403],
    [wrapped(apiError(403, "Project does not have access to model text-embedding-3-small")), "model", 403],
    [wrapped(apiError(402, "Payment required")), "quota", 402],
    [wrapped(apiError(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}')), "quota", 429],
    [wrapped(apiError(429, "Rate limit reached for requests per min")), "rate_limited", 429],
    [wrapped(apiError(404, "The model does not exist or you do not have access to it.")), "model", 404],
    [wrapped(apiError(404, "<html>not found</html>")), "model", 404],
    [wrapped(apiError(400, "This model does not support specifying dimensions.")), "model", 400],
    [new Error("Embedding dim mismatch: model text-embedding-3-small returned 8 but schema expects 1536."), "model", null],
    [wrapped(apiError(500, "server error")), "provider_failing", 500],
    [wrapped(apiError(503, "overloaded")), "provider_failing", 503],
    [wrapped(apiError(408, "timeout")), "provider_failing", 408],
    [wrapped(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" })), "unreachable", null],
    [wrapped(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })), "unreachable", null],
    [Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }), "unreachable", null],
    [new Error("fetch failed"), "unreachable", null],
    [new Error("something else"), "unknown", null],
    [null, "unknown", null],
  ];
  for (const [err, cause, status] of rows) assert.deepEqual(classifyEmbedFailure(err), { cause, status }, String((err as Error | null)?.message));
});

test("the answer never carries upstream text, even when a provider echoes the key", () => {
  const canary = "canary-key-value-7f3a";
  const out = JSON.stringify(classifyEmbedFailure(wrapped(apiError(401, `Incorrect API key provided: ${canary}`))));
  assert.ok(!out.includes(canary));
});

test("app and engine share one closed vocabulary; the app ignores anything else", () => {
  assert.deepEqual(APP_CAUSES, EMBED_CAUSES);
  assert.deepEqual(readEmbedCheck({ result: "failed", cause: "auth", status: 401, at: "x", extra: "text" }), { result: "failed", cause: "auth", status: 401 });
  assert.deepEqual(readEmbedCheck({ result: "ok", at: "x" }), { result: "ok" });
  assert.equal(readEmbedCheck({ result: "failed", cause: "free text" }), null);
  assert.equal(readEmbedCheck({ error: { code: "engine_starting" } }), null);
  assert.equal(readEmbedCheck(null), null);
});

test("embedChecker: one call at a time, none within the fresh time; a failed run is not kept", async () => {
  let now = 0;
  let runs = 0;
  let answer: EmbedCheck | null = null;
  const check = embedChecker(
    async () => {
      runs++;
      return answer;
    },
    60_000,
    () => now,
  );
  assert.equal(await check(), null);
  assert.equal(runs, 1);
  answer = { result: "failed", cause: "auth", status: 401, at: "t" };
  const [a, b] = await Promise.all([check(), check()]);
  assert.deepEqual(a, answer);
  assert.deepEqual(b, answer);
  assert.equal(runs, 2, "single flight");
  now = 59_999;
  await check();
  assert.equal(runs, 2, "still fresh");
  now = 60_000;
  await check();
  assert.equal(runs, 3);
});

test("runEmbedCheck reads the last JSON line of stdout and drops stderr; a script that fails or prints nothing gives null", async () => {
  const run = (code: string) => runEmbedCheck([process.execPath, "-e", code], process.env);
  assert.deepEqual(await run(`console.error("secret text"); console.log("noise"); console.log(JSON.stringify({ result: "ok", at: "t" }))`), { result: "ok", at: "t" });
  assert.equal(await run("process.exit(3)"), null);
  assert.equal(await run(`console.log("not json")`), null);
  assert.equal(await runEmbedCheck(["/nonexistent-launcher"], process.env), null);
});
