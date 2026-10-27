// C373 (recipe WP6): which models GBrain runs with. Inputs: the model roles tb-exec resolved from the workspace bridge
// (`KN_EMBEDDINGS_*`, `KN_REASONING_*`, manifest settings.modelRoles[].env), the legacy deploy setting `model_provider`
// with its provider keys (installs from before model roles), and what the brain was built with (GBrain's config.json).
// Output: the env for `gbrain serve`, the init / enable step, and a status of labels only (no key, no base URL) that the
// helper serves to the app (`/models`). Pure: boot.ts does the file and process work.
//
// Embeddings fix the index (MANIFEST §7.1): the model and size the brain was built with stay in use. A binding that
// differs is reported (`changed`) and never applied by itself; re-embedding needs the owner (not built yet). A brain
// built without embeddings (`--no-embedding`) gets them in place once a binding arrives (`gbrain embeddings enable`:
// refuses and changes nothing when the column width does not fit), because no vector exists yet that could be wrong.

/** One provider as GBrain knows it: the recipe id in `provider:model` strings and the env names it reads. */
export interface GBrainProvider {
  recipe: string;
  keyEnv: string;
  /** null: GBrain reads this provider's address from its own config only (hosted APIs with a fixed default) */
  baseUrlEnv: string | null;
  /** GBrain cannot derive the embedding size for this recipe: the binding must carry `dims` */
  needsDims: boolean;
}

/** Spec `MODEL_PROVIDERS` ids → GBrain 0.60.424 recipes (src/core/ai/recipes/*, build-gateway-config.ts). `azure-openai` has no
 *  GBrain recipe that reads its deployment address from env: not supported (reported, never guessed). */
export const GBRAIN_PROVIDERS: Readonly<Record<string, GBrainProvider>> = {
  openai: { recipe: "openai", keyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", needsDims: false },
  anthropic: { recipe: "anthropic", keyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", needsDims: false },
  google: { recipe: "google", keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY", baseUrlEnv: "GOOGLE_GENERATIVE_AI_BASE_URL", needsDims: false },
  openrouter: { recipe: "openrouter", keyEnv: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL", needsDims: false },
  ollama: { recipe: "ollama", keyEnv: "OLLAMA_API_KEY", baseUrlEnv: "OLLAMA_BASE_URL", needsDims: false },
  "llama-server": { recipe: "llama-server", keyEnv: "LLAMA_SERVER_API_KEY", baseUrlEnv: "LLAMA_SERVER_BASE_URL", needsDims: true },
  "lm-studio": { recipe: "lmstudio", keyEnv: "LMSTUDIO_API_KEY", baseUrlEnv: "LMSTUDIO_BASE_URL", needsDims: true },
  litellm: { recipe: "litellm", keyEnv: "LITELLM_API_KEY", baseUrlEnv: "LITELLM_BASE_URL", needsDims: true },
  // any OpenAI-compatible address: GBrain's generic OpenAI-compatible recipe is the LiteLLM one (base URL + optional key)
  "openai-compatible": { recipe: "litellm", keyEnv: "LITELLM_API_KEY", baseUrlEnv: "LITELLM_BASE_URL", needsDims: true },
  together: { recipe: "together", keyEnv: "TOGETHER_API_KEY", baseUrlEnv: null, needsDims: false },
  mistral: { recipe: "mistral", keyEnv: "MISTRAL_API_KEY", baseUrlEnv: null, needsDims: false },
  deepseek: { recipe: "deepseek", keyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: null, needsDims: false },
  voyage: { recipe: "voyage", keyEnv: "VOYAGE_API_KEY", baseUrlEnv: null, needsDims: false },
};

/** Legacy `model_provider` defaults (knowledge ≤ 0.1.28 entrypoint.sh, unchanged): chat model, embedding model + size, keys. */
export const LEGACY_MODELS: Readonly<Record<string, { chat: string; chatKey: string; embedding: string; dims: number; embeddingKey: string }>> = {
  openai: { chat: "openai:gpt-6-luna", chatKey: "OPENAI_API_KEY", embedding: "openai:text-embedding-3-small", dims: 1536, embeddingKey: "OPENAI_API_KEY" },
  google: { chat: "google:gemini-2.5-flash", chatKey: "GOOGLE_GENERATIVE_AI_API_KEY", embedding: "google:gemini-embedding-2", dims: 768, embeddingKey: "GOOGLE_GENERATIVE_AI_API_KEY" },
  anthropic: { chat: "anthropic:claude-sonnet-5", chatKey: "ANTHROPIC_API_KEY", embedding: "openai:text-embedding-3-small", dims: 1536, embeddingKey: "OPENAI_API_KEY" },
};

/** The env names tb-exec fills from the bindings (tealbrick.manifest.json settings.modelRoles[].env). */
export const ROLE_ENV = {
  embeddings: { provider: "KN_EMBEDDINGS_PROVIDER", model: "KN_EMBEDDINGS_MODEL", baseUrl: "KN_EMBEDDINGS_BASE_URL", key: "KN_EMBEDDINGS_KEY", dims: "KN_EMBEDDINGS_DIMS" },
  reasoning: { provider: "KN_REASONING_PROVIDER", model: "KN_REASONING_MODEL", baseUrl: "KN_REASONING_BASE_URL", key: "KN_REASONING_KEY" },
} as const;

/** What the brain on the volume was built with (GBrain `~/.gbrain/config.json`); null before the first init. */
export interface BuiltBrain {
  embeddingModel: string | null;
  dims: number | null;
  /** built with `--no-embedding` (deferred setup) */
  disabled: boolean;
}

/** `failed`: GBrain refused the init or the in-place enable with this model (wrong size, unknown model): keyword recall. */
export type EmbeddingsState = "ok" | "unset" | "changed" | "enabled" | "unsupported" | "dims_missing" | "failed";
export type ReasoningState = "ok" | "unset" | "unsupported" | "conflict";

/** Labels only (never a key or a base URL): GBrain `provider:model` strings and sizes, the source of each. */
export interface ModelStatus {
  v: 1;
  embeddings: { state: EmbeddingsState; source: "role" | "legacy" | null; active: { model: string; dims: number | null } | null; wanted: { model: string; dims: number | null } | null };
  reasoning: { state: ReasoningState; source: "role" | "legacy" | null; model: string | null };
}

export interface ModelPlan {
  /** env added to (or, for `null`, removed from) the upstream env */
  env: Record<string, string | null>;
  /** first boot: `gbrain init` arguments after `init --non-interactive` */
  init: string[] | null;
  /** brain built without embeddings and a binding now exists: `gbrain embeddings enable` arguments */
  enable: string[] | null;
  status: ModelStatus;
}

interface Binding {
  provider: GBrainProvider | null;
  providerId: string;
  model: string;
  baseUrl: string | null;
  key: string | null;
  dims: number | null;
}

const text = (v: string | undefined): string | null => v?.trim() || null;

function binding(env: Record<string, string | undefined>, names: { provider: string; model: string; baseUrl: string; key: string; dims?: string }): Binding | null {
  const providerId = text(env[names.provider]);
  const model = text(env[names.model]);
  if (!providerId || !model) return null;
  const dims = names.dims ? Number(text(env[names.dims]) ?? Number.NaN) : Number.NaN;
  return { provider: GBRAIN_PROVIDERS[providerId] ?? null, providerId, model, baseUrl: text(env[names.baseUrl]), key: text(env[names.key]), dims: Number.isInteger(dims) && dims > 0 ? dims : null };
}

const gbrainModel = (b: Binding): string => `${(b.provider as GBrainProvider).recipe}:${b.model}`;

/**
 * The model plan for one boot. `built` is null on the first boot (no config.json yet). Precedence per role: the bound model
 * role, else the legacy `model_provider` defaults when that provider's key is present, else nothing.
 */
export function planModels(env: Record<string, string | undefined>, built: BuiltBrain | null): ModelPlan {
  const out: Record<string, string | null> = {};
  const legacy = LEGACY_MODELS[env.KNOWLEDGE_MODEL_PROVIDER ?? "openai"] ?? LEGACY_MODELS.openai;
  const embRole = binding(env, ROLE_ENV.embeddings);
  const chatRole = binding(env, ROLE_ENV.reasoning);
  // GBrain env names a role binding sets (key and base URL); the embeddings binding wins a clash (it holds the index)
  const owned = new Map<string, string>();
  const apply = (b: Binding): boolean => {
    const p = b.provider as GBrainProvider;
    const wants: [string, string | null][] = [[p.keyEnv, b.key], ...(p.baseUrlEnv ? ([[p.baseUrlEnv, b.baseUrl]] as [string, string | null][]) : [])];
    if (wants.some(([name, value]) => owned.has(name) && owned.get(name) !== (value ?? ""))) return false;
    for (const [name, value] of wants) {
      owned.set(name, value ?? "");
      // a keyless local server still needs the name absent, not empty (GBrain treats "" as unset; null removes it)
      out[name] = value;
    }
    return true;
  };

  // ── embeddings ──
  let wanted: { model: string; dims: number | null } | null = null;
  let source: ModelStatus["embeddings"]["source"] = null;
  let state: EmbeddingsState = "unset";
  let wantedBinding: Binding | null = null;
  if (embRole) {
    source = "role";
    if (!embRole.provider) state = "unsupported";
    else if (embRole.provider.needsDims && embRole.dims === null) state = "dims_missing";
    else {
      wanted = { model: gbrainModel(embRole), dims: embRole.dims };
      wantedBinding = embRole;
    }
  } else if (text(env[legacy.embeddingKey])) {
    source = "legacy";
    wanted = { model: legacy.embedding, dims: legacy.dims };
  }

  let init: string[] | null = null;
  let enable: string[] | null = null;
  let active: { model: string; dims: number | null } | null = null;
  const sizeArgs = (w: { model: string; dims: number | null }) => ["--embedding-model", w.model, ...(w.dims !== null ? ["--embedding-dimensions", String(w.dims)] : [])];
  if (!built) {
    init = wanted ? sizeArgs(wanted) : ["--no-embedding"];
    active = wanted;
  } else if (built.disabled || !built.embeddingModel) {
    if (wanted) {
      enable = sizeArgs(wanted);
      active = wanted;
    }
  } else {
    active = { model: built.embeddingModel, dims: built.dims };
  }
  if (wanted && active) state = sameModel(wanted, active) ? (enable ? "enabled" : "ok") : "changed";
  else if (!wanted && active) state = source === null ? "ok" : state; // built brain, nothing bound: it keeps its model
  // the credentials the ACTIVE model needs: from the embeddings binding when it is that model, else the legacy key in env
  if (wantedBinding && active && sameModel(wanted as { model: string; dims: number | null }, active)) apply(wantedBinding);
  else if (active) {
    // the active model runs on credentials already in env (legacy keys): a reasoning binding must not replace them
    const p = Object.values(GBRAIN_PROVIDERS).find((x) => active.model.startsWith(`${x.recipe}:`));
    if (p) {
      owned.set(p.keyEnv, text(env[p.keyEnv]) ?? "");
      if (p.baseUrlEnv) owned.set(p.baseUrlEnv, text(env[p.baseUrlEnv]) ?? "");
    }
  }

  // ── reasoning ──
  let chat: ModelStatus["reasoning"] = { state: "unset", source: null, model: null };
  if (chatRole) {
    if (!chatRole.provider) chat = { state: "unsupported", source: "role", model: null };
    else if (!apply(chatRole)) chat = { state: "conflict", source: "role", model: null };
    else chat = { state: "ok", source: "role", model: gbrainModel(chatRole) };
  } else if (text(env[legacy.chatKey])) {
    chat = { state: "ok", source: "legacy", model: legacy.chat };
  }
  // GBrain reads its chat and expansion models from env at run time; without a reasoning model none is set (think refuses)
  for (const name of ["GBRAIN_CHAT_MODEL", "GBRAIN_MODEL", "GBRAIN_EXPANSION_MODEL"]) out[name] = chat.model;
  // never GBRAIN_EMBEDDING_*: GBrain would read them at run time over config.json and embed queries with another model
  out.GBRAIN_EMBEDDING_MODEL = null;
  out.GBRAIN_EMBEDDING_DIMENSIONS = null;
  for (const names of Object.values(ROLE_ENV)) for (const name of Object.values(names)) out[name] = null;

  return { env: out, init, enable, status: { v: 1, embeddings: { state, source, active, wanted }, reasoning: chat } };
}

function sameModel(a: { model: string; dims: number | null }, b: { model: string; dims: number | null }): boolean {
  return a.model === b.model && (a.dims === null || b.dims === null || a.dims === b.dims);
}

/** GBrain config.json → what the brain was built with (unknown shapes read as "built without embeddings"). */
export function builtFrom(config: unknown): BuiltBrain {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const model = typeof c.embedding_model === "string" && c.embedding_model.trim() ? c.embedding_model.trim() : null;
  const dims = typeof c.embedding_dimensions === "number" && c.embedding_dimensions > 0 ? c.embedding_dimensions : null;
  return { embeddingModel: model, dims, disabled: c.embedding_disabled === true || model === null };
}

/** The upstream env with the plan applied (null removes a name). */
export function applyEnv(base: Record<string, string | undefined>, plan: Record<string, string | null>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(plan)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}
