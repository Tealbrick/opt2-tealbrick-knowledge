// Deploy-time settings reach the app only as env (MANIFEST §7, C16 S6). One name per setting.
export type ModelProvider = "openai" | "google" | "anthropic";

export interface KnowledgeConfig {
  engine: "gbrain" | "hindsight";
  research: boolean;
  modelProvider: ModelProvider;
  gbrainUrl: string | null;
  gbrainAdminToken: string | null;
  notebookUrl: string | null;
  notebookPassword: string | null;
  /** C336 F4: deep knowledge (helix-foundry) companion, behind its token proxy */
  deep: boolean;
  deepUrl: string | null;
  deepToken: string | null;
}

export function readConfig(env: Record<string, string | undefined>): KnowledgeConfig {
  const engine = env.KNOWLEDGE_ENGINE === "hindsight" ? "hindsight" : "gbrain";
  const provider = env.KNOWLEDGE_MODEL_PROVIDER;
  return {
    engine,
    research: env.KNOWLEDGE_RESEARCH === "true",
    modelProvider: provider === "google" || provider === "anthropic" ? provider : "openai",
    gbrainUrl: env.KNOWLEDGE_GBRAIN_URL || null,
    gbrainAdminToken: env.KNOWLEDGE_GBRAIN_ADMIN_TOKEN || null,
    notebookUrl: env.KNOWLEDGE_NOTEBOOK_URL || null,
    notebookPassword: env.KNOWLEDGE_NOTEBOOK_PASSWORD || null,
    deep: env.KNOWLEDGE_DEEP === "true",
    deepUrl: env.KNOWLEDGE_DEEP_URL || null,
    deepToken: env.KNOWLEDGE_DEEP_TOKEN || null,
  };
}

/** Provider defaults (chat model, embedding provider + model). Anthropic has no embeddings: OpenAI embeds. */
export const PROVIDER_MODELS: Record<ModelProvider, { chatModel: string; embeddingProvider: "openai" | "google"; embeddingModel: string; keys: string[] }> = {
  openai: { chatModel: "gpt-6-luna", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", keys: ["OPENAI_API_KEY"] },
  google: { chatModel: "gemini-2.5-flash", embeddingProvider: "google", embeddingModel: "gemini-embedding-2", keys: ["GOOGLE_GENERATIVE_AI_API_KEY"] },
  anthropic: { chatModel: "claude-sonnet-5", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] },
};

export const PROVIDER_KEY: Record<ModelProvider, string> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};
