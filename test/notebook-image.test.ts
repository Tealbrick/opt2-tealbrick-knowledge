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
  // build-time proof: gpt-6-luna is a reasoning model without top_p and temperature; gpt-4o keeps them
  assert.match(patch, /model_name='gpt-6-luna'.*assert r\._is_reasoning_model\(\) and 'top_p' not in k and 'temperature' not in k/u);
  assert.match(patch, /model_name='gpt-4o'.*assert not o\._is_reasoning_model\(\) and 'top_p' in o\._get_api_kwargs\(\)/u);
  // the patch runs on the pinned Open Notebook image (esperanto 2.25.1 under python3.12)
  assert.match(dockerfile, /^FROM lfnovo\/open_notebook:1\.14\.0@sha256:/mu);
  assert.match(patch, /\/app\/\.venv\/lib\/python3\.12\/site-packages\/esperanto\/providers\/llm\/openai\.py/u);
});

test("INC-20261106-02: the OpenAI chat model is one the patched check covers", () => {
  const model = PROVIDER_MODELS.openai.chatModel;
  assert.ok(/^(o1|o3|o4|gpt-5|gpt-6)/u.test(model), `${model} needs the reasoning-model handling in the notebook image`);
});
