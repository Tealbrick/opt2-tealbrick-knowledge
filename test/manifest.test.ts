import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAppFiles, validateManifest } from "@opt2-tealbrick/manifest";

const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));
const root = new URL("..", import.meta.url).pathname;

test("manifest passes the one validator (schema + every M-* rule)", () => {
  const result = validateManifest(manifest);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.errors, null, 2));
});

test("skill files pass validateAppFiles (frontmatter, variables, sanitized content)", async () => {
  const result = await validateAppFiles(manifest, root);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.errors, null, 2));
});

test("C296 QA: provider keys are required only when the memory engine runs (the models step's own when)", async () => {
  const { activeKeyRequirements } = await import("@opt2-tealbrick/manifest");
  const m = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));
  const names = (settings: Record<string, unknown>) => activeKeyRequirements(m, settings as never).map((k: { name: string }) => k.name).sort();
  assert.deepEqual(names({ engine: "hindsight", model_provider: "openai" }), [], "no engine: no model key blocks the app");
  assert.deepEqual(names({ engine: "gbrain", model_provider: "openai" }), ["OPENAI_API_KEY"]);
  assert.deepEqual(names({ engine: "gbrain", model_provider: "anthropic" }), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  assert.deepEqual(names({ engine: "gbrain", model_provider: "google" }), ["GOOGLE_GENERATIVE_AI_API_KEY"]);
});
