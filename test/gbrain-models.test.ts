// C373 (recipe WP6): the GBrain companion's model plan (services/gbrain/models.ts): model roles from tb-exec env, the legacy
// provider setting as a fallback, the embeddings index kept, labels-only status. Pure logic; boot.ts runs the plan.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEnv, builtFrom, planModels } from "../services/gbrain/models.ts";

const KEY_A = "sk-test-aaaaaaaaaaaa";
const KEY_B = "sk-test-bbbbbbbbbbbb";
const role = {
  embeddings: (provider: string, model: string, extra: Record<string, string> = {}) => ({ KN_EMBEDDINGS_PROVIDER: provider, KN_EMBEDDINGS_MODEL: model, ...extra }),
  reasoning: (provider: string, model: string, extra: Record<string, string> = {}) => ({ KN_REASONING_PROVIDER: provider, KN_REASONING_MODEL: model, ...extra }),
};
const LEGACY_BRAIN = { embeddingModel: "openai:text-embedding-3-small", dims: 1536, disabled: false };

test("keyless first boot (DEV): GBrain starts without embeddings and without a chat model; the status says unset", () => {
  const plan = planModels({ KNOWLEDGE_MODEL_PROVIDER: "openai" }, null);
  assert.deepEqual(plan.init, ["--no-embedding"]);
  assert.equal(plan.enable, null);
  assert.equal(plan.env.GBRAIN_CHAT_MODEL, null);
  assert.equal(plan.env.GBRAIN_EMBEDDING_MODEL, null);
  assert.deepEqual(plan.status.embeddings, { state: "unset", source: null, active: null, wanted: null });
  assert.deepEqual(plan.status.reasoning, { state: "unset", source: null, model: null });
});

test("legacy install (≤ 0.1.28 settings, no roles): the old provider defaults and keys, exactly as entrypoint.sh had them", () => {
  const plan = planModels({ KNOWLEDGE_MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY_A }, null);
  assert.deepEqual(plan.init, ["--embedding-model", "openai:text-embedding-3-small", "--embedding-dimensions", "1536"]);
  assert.equal(plan.env.GBRAIN_CHAT_MODEL, "openai:gpt-6-luna");
  assert.equal(plan.env.GBRAIN_EXPANSION_MODEL, "openai:gpt-6-luna");
  assert.equal(plan.env.OPENAI_API_KEY, undefined, "the legacy key stays as tb-exec set it");
  assert.equal(plan.status.embeddings.source, "legacy");
  // an existing legacy brain keeps running unchanged
  const again = planModels({ KNOWLEDGE_MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY_B, OPENAI_API_KEY: KEY_A }, LEGACY_BRAIN);
  assert.equal(again.init, null);
  assert.equal(again.status.embeddings.state, "ok");
  assert.deepEqual(again.status.reasoning, { state: "ok", source: "legacy", model: "anthropic:claude-sonnet-5" });
});

test("roles on a first boot: a self-hosted Ollama /v1 for embeddings and OpenRouter for reasoning, keys under GBrain's own names", () => {
  const env = {
    KNOWLEDGE_MODEL_PROVIDER: "openai",
    ...role.embeddings("ollama", "nomic-embed-text", { KN_EMBEDDINGS_BASE_URL: "http://gpu.internal.example.com:11434/v1", KN_EMBEDDINGS_DIMS: "768" }),
    ...role.reasoning("openrouter", "openai/gpt-5.2-chat", { KN_REASONING_BASE_URL: "https://openrouter.ai/api/v1", KN_REASONING_KEY: KEY_B }),
  };
  const plan = planModels(env, null);
  assert.deepEqual(plan.init, ["--embedding-model", "ollama:nomic-embed-text", "--embedding-dimensions", "768"]);
  assert.equal(plan.env.OLLAMA_BASE_URL, "http://gpu.internal.example.com:11434/v1");
  assert.equal(plan.env.OLLAMA_API_KEY, null, "a keyless local server: no key name at all");
  assert.equal(plan.env.OPENROUTER_API_KEY, KEY_B);
  assert.equal(plan.env.OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(plan.env.GBRAIN_CHAT_MODEL, "openrouter:openai/gpt-5.2-chat");
  for (const name of ["KN_EMBEDDINGS_PROVIDER", "KN_REASONING_KEY", "KN_EMBEDDINGS_BASE_URL"]) assert.equal(plan.env[name], null, `${name} is not passed on`);
  const status = JSON.stringify(plan.status);
  assert.ok(!status.includes(KEY_B) && !status.includes("://"), "the status carries labels only (no key, no address)");
  // any OpenAI-compatible address goes through GBrain's generic recipe and needs the vector size
  const custom = planModels(role.embeddings("openai-compatible", "bge-m3", { KN_EMBEDDINGS_BASE_URL: "https://llm.example.com/v1", KN_EMBEDDINGS_KEY: KEY_A, KN_EMBEDDINGS_DIMS: "1024" }), null);
  assert.deepEqual(custom.init, ["--embedding-model", "litellm:bge-m3", "--embedding-dimensions", "1024"]);
  assert.equal(custom.env.LITELLM_BASE_URL, "https://llm.example.com/v1");
  assert.equal(custom.env.LITELLM_API_KEY, KEY_A);
});

test("the index keeps its model: a different embeddings binding is reported (changed), never applied; the legacy key keeps serving it", () => {
  const plan = planModels({ KNOWLEDGE_MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY_A, ...role.embeddings("ollama", "nomic-embed-text", { KN_EMBEDDINGS_DIMS: "768" }) }, LEGACY_BRAIN);
  assert.equal(plan.init, null);
  assert.equal(plan.enable, null);
  assert.equal(plan.status.embeddings.state, "changed");
  assert.deepEqual(plan.status.embeddings.active, { model: "openai:text-embedding-3-small", dims: 1536 });
  assert.deepEqual(plan.status.embeddings.wanted, { model: "ollama:nomic-embed-text", dims: 768 });
  assert.equal(plan.env.OLLAMA_BASE_URL, undefined, "the new provider is not wired: nothing embeds with it yet");
  assert.equal(plan.env.GBRAIN_EMBEDDING_MODEL, null, "never GBrain's run-time embedding variables");
  // the same model through a role (an install that moves to roles): ok, and the role's key serves it
  const same = planModels(role.embeddings("openai", "text-embedding-3-small", { KN_EMBEDDINGS_KEY: KEY_B, KN_EMBEDDINGS_DIMS: "1536" }), LEGACY_BRAIN);
  assert.equal(same.status.embeddings.state, "ok");
  assert.equal(same.env.OPENAI_API_KEY, KEY_B);
});

test("a brain built without embeddings gets them in place once a binding exists (enable, not re-init)", () => {
  const plan = planModels(role.embeddings("openai", "text-embedding-3-small", { KN_EMBEDDINGS_KEY: KEY_A }), { embeddingModel: null, dims: null, disabled: true });
  assert.equal(plan.init, null);
  assert.deepEqual(plan.enable, ["--embedding-model", "openai:text-embedding-3-small"]);
  assert.equal(plan.status.embeddings.state, "enabled");
  assert.equal(plan.env.OPENAI_API_KEY, KEY_A);
  const still = planModels({}, { embeddingModel: null, dims: null, disabled: true });
  assert.equal(still.enable, null);
  assert.equal(still.status.embeddings.state, "unset");
});

test("bindings GBrain cannot use are named, never guessed: no size for a generic server, an unknown provider, a key clash", () => {
  const noDims = planModels(role.embeddings("llama-server", "qwen3-embed", { KN_EMBEDDINGS_BASE_URL: "http://10.0.0.5:8080/v1" }), null);
  assert.equal(noDims.status.embeddings.state, "dims_missing");
  assert.deepEqual(noDims.init, ["--no-embedding"]);
  const azure = planModels(role.reasoning("azure-openai", "gpt-5"), LEGACY_BRAIN);
  assert.equal(azure.status.reasoning.state, "unsupported");
  assert.equal(azure.env.GBRAIN_CHAT_MODEL, null);
  // the index runs on the legacy OpenAI key; a reasoning binding with ANOTHER OpenAI key would replace it: refused
  const clash = planModels({ OPENAI_API_KEY: KEY_A, ...role.reasoning("openai", "gpt-6-luna", { KN_REASONING_KEY: KEY_B }) }, LEGACY_BRAIN);
  assert.equal(clash.status.reasoning.state, "conflict");
  assert.equal(clash.env.OPENAI_API_KEY, undefined, "the embeddings key stays");
  const sameKey = planModels({ OPENAI_API_KEY: KEY_A, ...role.reasoning("openai", "gpt-6-luna", { KN_REASONING_KEY: KEY_A }) }, LEGACY_BRAIN);
  assert.equal(sameKey.status.reasoning.state, "ok");
});

test("builtFrom reads GBrain's config.json; applyEnv removes what the plan nulls", () => {
  assert.deepEqual(builtFrom({ embedding_model: "openai:text-embedding-3-small", embedding_dimensions: 1536 }), LEGACY_BRAIN);
  assert.deepEqual(builtFrom({ embedding_disabled: true }), { embeddingModel: null, dims: null, disabled: true });
  assert.deepEqual(builtFrom("garbage"), { embeddingModel: null, dims: null, disabled: true });
  assert.deepEqual(applyEnv({ A: "1", B: "2", C: undefined }, { B: null, D: "4" }), { A: "1", D: "4" });
});
