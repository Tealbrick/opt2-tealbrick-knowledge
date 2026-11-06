// INC-20261106-02 (0.1.38): the research chat (Open Notebook) answered 502 on every OpenAI workspace. Its model library
// esperanto drops temperature/top_p only for o1/o3/o4/gpt-5 model names; Knowledge's OpenAI chat model is gpt-6-luna
// (config.ts), a reasoning model, and OpenAI refused its top_p with 400 "Unsupported parameter: 'top_p'" (ostra,
// 2026-11-06 10:05:17Z). The notebook image patches the check (gpt-6 counts) and verifies the result at build time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROVIDER_MODELS } from "../src/config.ts";

const dockerfile = readFileSync(new URL("../services/notebook/Dockerfile", import.meta.url), "utf8");

test("INC-20261106-02: the notebook image treats gpt-6 models as reasoning models (no top_p/temperature) and checks it at build", () => {
  const patch = dockerfile.split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
  // the upstream line must be there exactly once, else the build fails (a changed esperanto is noticed, not skipped)
  assert.match(patch, /test "\$\(grep -c 'or self\.get_model_name\(\)\.startswith\("gpt-5"\)\$' "\$f"\)" = 1/u);
  assert.match(patch, /startswith\("gpt-5"\) or self\.get_model_name\(\)\.startswith\("gpt-6"\)\/' "\$f"/u);
  // build-time proof in the built image: the gpt-6 family and a dated id are reasoning models without top_p and temperature,
  // and max_tokens goes out as max_completion_tokens exactly as for gpt-5; gpt-4o keeps temperature and top_p.
  // (Proven to fail the build without the sed: AssertionError ('gpt-6-luna', {... 'temperature': 1.0, 'top_p': 0.9 ...}).)
  assert.match(patch, /ref = sorted\(M\(model_name='gpt-5-mini'[^)]*\)\._get_api_kwargs\(max_tokens=1000\)\)/u);
  assert.match(patch, /for n in \('gpt-6-luna', 'gpt-6-luna-20260922', 'gpt-6-sol', 'gpt-6-astra'\)/u);
  assert.match(patch, /r\._is_reasoning_model\(\) and 'top_p' not in k and 'temperature' not in k and sorted\(km\) == ref == \['max_completion_tokens', 'stream'\]/u);
  assert.match(patch, /model_name='gpt-4o'.*assert not o\._is_reasoning_model\(\) and 'top_p' in o\._get_api_kwargs\(\)/u);
  // the patch runs on the pinned Open Notebook image (esperanto 2.25.1 under python3.12)
  assert.match(dockerfile, /^FROM lfnovo\/open_notebook:1\.14\.0@sha256:/mu);
  assert.match(patch, /\/app\/\.venv\/lib\/python3\.12\/site-packages\/esperanto\/providers\/llm\/openai\.py/u);
});

test("INC-20261106-02: the OpenAI chat model is one the patched check covers", () => {
  const model = PROVIDER_MODELS.openai.chatModel;
  assert.ok(/^(o1|o3|o4|gpt-5|gpt-6)/u.test(model), `${model} needs the reasoning-model handling in the notebook image`);
});

test("INC-20261106-02: a failed research call is reported with a short cause code, never upstream text or the prompt", async () => {
  const { NotebookClient, failureCause } = await import("../src/engines/notebook/client.ts");
  // ostra 2026-11-06 10:05:17Z, Open Notebook's answer to POST /api/chat/execute
  const detail = "Error code: 400 - {'error': {'message': \"Unsupported parameter: 'top_p' is not supported with this model.\", 'type': 'invalid_request_error', 'param': 'top_p'}} while answering: secret walrus question";
  assert.equal(failureCause(502, detail), "unsupported_parameter:top_p");
  assert.equal(failureCause(502, "Error code: 401 - Incorrect API key provided"), "auth_failed");
  assert.equal(failureCause(429, "Rate limit reached"), "rate_limited");
  assert.equal(failureCause(502, "The model `gpt-9` does not exist"), "model_not_found");
  assert.equal(failureCause(502, "something else"), "upstream_error");
  const seen: unknown[] = [];
  const client = new NotebookClient({
    baseUrl: "http://notebook.test",
    password: "pw",
    fetch: (async () => new Response(JSON.stringify({ detail }), { status: 502, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  client.onFailure = (failure) => seen.push(failure);
  await assert.rejects(client.health().then((ok) => (ok ? null : Promise.reject(new Error("unhealthy")))));
  assert.deepEqual(seen, [{ method: "GET", path: "/health", status: 502, cause: "unsupported_parameter:top_p" }]);
  assert.ok(!JSON.stringify(seen).includes("walrus"), "no upstream text");
});
