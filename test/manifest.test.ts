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

test("C373: the legacy provider keys stay declared but optional (fallback for installs from before model roles)", async () => {
  const { activeKeyRequirements } = await import("@opt2-tealbrick/manifest");
  const m = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));
  const keys = (settings: Record<string, unknown>) => activeKeyRequirements(m, settings as never).map((k: { name: string; required: boolean }) => `${k.name}:${k.required}`).sort();
  assert.deepEqual(keys({ engine: "gbrain", model_provider: "openai" }), ["OPENAI_API_KEY:false"]);
  assert.deepEqual(keys({ engine: "gbrain", model_provider: "anthropic" }), ["ANTHROPIC_API_KEY:false", "OPENAI_API_KEY:false"]);
  assert.deepEqual(keys({ engine: "gbrain", model_provider: "google" }), ["GOOGLE_GENERATIVE_AI_API_KEY:false"]);
  // manifest 0.1.31: a skipped step hides its keys (the models step needs GBrain; Hindsight is a disabled "soon" choice)
  assert.deepEqual(keys({ engine: "hindsight", research: true, model_provider: "openai" }), []);
});

test("C373: model roles embeddings + reasoning are optional, standard, fed to the gbrain service under the names its boot reads", async () => {
  const { activeModelRoles } = await import("@opt2-tealbrick/manifest");
  const { ROLE_ENV } = await import("../services/gbrain/models.ts");
  const roles = manifest.settings.modelRoles as { role: string; required: boolean; minPolicy: string; usedBy: string[]; env: Record<string, string> }[];
  assert.deepEqual(roles.map((r) => [r.role, r.required, r.minPolicy, r.usedBy.join(",")]), [["embeddings", false, "standard", "gbrain"], ["reasoning", false, "standard", "gbrain,deep"]]);
  assert.deepEqual(roles.find((r) => r.role === "embeddings")?.env, ROLE_ENV.embeddings);
  assert.deepEqual(roles.find((r) => r.role === "reasoning")?.env, ROLE_ENV.reasoning);
  // MANIFEST §7.1: never GBrain's run-time model variables (a restart on keysRev would embed against the old index)
  for (const r of roles) for (const name of Object.values(r.env)) assert.ok(!name.startsWith("GBRAIN_"), name);
  assert.deepEqual(activeModelRoles(manifest, { engine: "gbrain" } as never, "gbrain").map((r: { role: string }) => r.role), ["embeddings", "reasoning"]);
  const gbrain = manifest.runtime.services.find((x: { id: string }) => x.id === "gbrain");
  assert.deepEqual(gbrain.helper.paths, ["/sources", "/models"]);
});
