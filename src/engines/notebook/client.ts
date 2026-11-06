// Open Notebook (research) adapter for the pinned upstream service (lfnovo/open_notebook 1.14.0).
// Notebook-scoped reads only (no global inventory), membership proven before and after detail reads,
// context built server-side from enumerated membership (upstream would otherwise include every item),
// and every POST failure classified `rejected` (known not executed) or `ambiguous` (may have executed).

export type Disposition = "rejected" | "ambiguous";

export class NotebookError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly disposition: Disposition;
  constructor(code: string, disposition: Disposition, status: number | null = null) {
    super(`research engine: ${code}`);
    this.code = code;
    this.disposition = disposition;
    this.status = status;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const REJECTED_POST_STATUS = new Set([400, 401, 403, 404, 413, 422]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_ITEMS = 100;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

export function validId(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith(prefix)) throw new NotebookError("invalid_id", "rejected");
  return value;
}

export interface SourceSummary {
  id: string;
  title: string | null;
  updated: string | null;
}
export interface NoteSummary {
  id: string;
  title: string | null;
  noteType: string | null;
  updated: string | null;
}
export interface ChatMessage {
  id: string;
  type: "human" | "ai";
  content: string;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

function asList(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new NotebookError("response_invalid", "rejected");
  return value.filter(isObject);
}

export interface NotebookClientOptions {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * INC-20261106-02: the cause of a failed research engine call, as a short fixed code from upstream's error text (never the
 * text itself: it may quote the prompt or a provider message). Open Notebook answers errors as {"detail": "<text>"}.
 */
const PARAMETERS = ["top_p", "temperature", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format", "tools", "stream"];
export function failureCause(status: number, detail: string): string {
  const text = detail.toLowerCase();
  const param = /unsupported (?:parameter|value)/u.test(text) ? PARAMETERS.find((name) => text.includes(`'${name}'`) || text.includes(`"${name}"`)) : undefined;
  if (param) return `unsupported_parameter:${param}`;
  if (/unsupported (?:parameter|value)/u.test(text)) return "unsupported_parameter";
  if (/decrypt|encryption key|fernet|invalid token/u.test(text)) return "credential_decrypt";
  if (/api key|apikey|unauthori[sz]ed|authentication|\b401\b|invalid_api_key|expired/u.test(text)) return "auth_failed";
  if (/rate limit|\b429\b|quota|insufficient_quota/u.test(text)) return "rate_limited";
  if (/model[^.]{0,40}(?:not found|does not exist)|model_not_found|unknown model/u.test(text)) return "model_not_found";
  if (/credential|no default model|not configured|configuration/u.test(text)) return "model_config";
  if (/timed? ?out|timeout/u.test(text)) return "timeout";
  if (/context length|too many tokens|maximum context/u.test(text)) return "context_too_long";
  return status >= 500 ? "upstream_error" : "upstream_rejected";
}

/** One failed research engine call: method, path without query, HTTP status (or null) and the cause code. */
export type NotebookFailure = { method: string; path: string; status: number | string; cause: string };

export class NotebookClient {
  /** INC-20261106-02: called for every failed call (Knowledge logs it); never carries upstream text. */
  onFailure: ((failure: NotebookFailure) => void) | null = null;
  private readonly baseUrl: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(opts: NotebookClientOptions) {
    const url = new URL(opts.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("KNOWLEDGE_NOTEBOOK_URL must be a bare http(s) origin");
    }
    this.baseUrl = url.origin;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetcher = opts.fetch ?? fetch;
  }

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const post = method !== "GET";
    const failure = (code: string, status: number | null) =>
      new NotebookError(code, post && !(status !== null && REJECTED_POST_STATUS.has(status)) ? "ambiguous" : "rejected", status);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${this.password}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const cause = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
      this.onFailure?.({ method, path: path.split("?")[0] ?? path, status: "none", cause });
      throw failure("upstream_unavailable", null);
    }
    if (!response.ok) {
      if (response.status !== 404) {
        // a bounded read of {"detail": …}: only the derived cause code leaves this function
        let detail = "";
        try {
          const raw = (await response.text()).slice(0, 4096);
          const parsed = JSON.parse(raw) as unknown;
          detail = isObject(parsed) && typeof parsed.detail === "string" ? parsed.detail : raw;
        } catch {
          detail = "";
        }
        this.onFailure?.({ method, path: path.split("?")[0] ?? path, status: response.status, cause: failureCause(response.status, detail) });
      } else {
        await response.body?.cancel();
      }
      throw failure(response.status === 404 ? "not_found" : "upstream_rejected", response.status);
    }
    if (response.status === 204) return null;
    const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (method === "DELETE" && type === "") {
      await response.body?.cancel();
      return null;
    }
    if (type !== "application/json" && !type.endsWith("+json")) {
      await response.body?.cancel();
      throw failure("response_invalid", null);
    }
    const raw = await response.arrayBuffer();
    if (raw.byteLength > MAX_RESPONSE_BYTES) throw failure("response_too_large", null);
    try {
      return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw failure("response_invalid", null);
    }
  }

  async health(): Promise<boolean> {
    try {
      const body = await this.request("GET", "/health", undefined, 2000);
      return isObject(body) && body.status === "healthy";
    } catch {
      return false;
    }
  }

  // ── notebooks (one per area; created at area provisioning) ──

  /** Find a notebook by exact name, else create it (create is not idempotent upstream, so list first). */
  async ensureNotebook(name: string, description: string): Promise<string> {
    const listed = asList(await this.request("GET", "/api/notebooks?order_by=updated%20desc"));
    const found = listed.find((notebook) => notebook.name === name && typeof notebook.id === "string");
    if (found) return validId(found.id, "notebook:");
    const created = await this.request("POST", "/api/notebooks", { name, description });
    if (!isObject(created)) throw new NotebookError("response_invalid", "ambiguous");
    return validId(created.id, "notebook:");
  }

  // ── sources ──

  async listSources(notebookId: string, limit = 50, offset = 0): Promise<SourceSummary[]> {
    const nb = encodeURIComponent(validId(notebookId, "notebook:"));
    const rows = asList(await this.request("GET", `/api/sources?notebook_id=${nb}&limit=${Math.min(Math.max(limit, 1), 100)}&offset=${Math.max(offset, 0)}&sort_by=updated&sort_order=desc`));
    return rows.map((row) => ({ id: validId(row.id, "source:"), title: text(row.title), updated: text(row.updated) }));
  }

  private async sourceIsMember(notebookId: string, sourceId: string): Promise<boolean> {
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = await this.listSources(notebookId, 100, offset);
      if (page.some((source) => source.id === sourceId)) return true;
      if (page.length < 100) return false;
    }
    return false;
  }

  /** A source is returned only after its membership in the notebook is proven (no scoped GET upstream). */
  async getSource(notebookId: string, sourceId: string): Promise<Json> {
    const id = validId(sourceId, "source:");
    if (!(await this.sourceIsMember(notebookId, id))) throw new NotebookError("not_found", "rejected", 404);
    const detail = await this.request("GET", `/api/sources/${encodeURIComponent(id)}`);
    if (!isObject(detail) || detail.id !== id) throw new NotebookError("response_invalid", "rejected");
    if (Array.isArray(detail.notebooks) && !detail.notebooks.includes(notebookId)) throw new NotebookError("not_found", "rejected", 404);
    return { id, title: text(detail.title), fullText: text(detail.full_text), updated: text(detail.updated) };
  }

  async addTextSource(notebookId: string, title: string, content: string): Promise<string> {
    const nb = validId(notebookId, "notebook:");
    const created = await this.request("POST", "/api/sources/json", {
      type: "text", notebooks: [nb], content, title, transformations: [], embed: false, delete_source: false, async_processing: false,
    });
    if (!isObject(created)) throw new NotebookError("response_invalid", "ambiguous");
    const id = validId(created.id, "source:");
    // Verify the write landed in the right notebook before reporting success.
    if (!(await this.sourceIsMember(nb, id))) throw new NotebookError("verification_failed", "ambiguous");
    return id;
  }

  /** Delete a source only after its membership in this notebook is proven. */
  async deleteSource(notebookId: string, sourceId: string): Promise<void> {
    const id = validId(sourceId, "source:");
    if (!(await this.sourceIsMember(notebookId, id))) throw new NotebookError("not_found", "rejected", 404);
    await this.request("DELETE", `/api/sources/${encodeURIComponent(id)}`);
  }

  // ── notes ──

  async listNotes(notebookId: string): Promise<NoteSummary[]> {
    const nb = encodeURIComponent(validId(notebookId, "notebook:"));
    return asList(await this.request("GET", `/api/notes?notebook_id=${nb}`)).map((row) => ({
      id: validId(row.id, "note:"),
      title: text(row.title),
      noteType: text(row.note_type),
      updated: text(row.updated),
    }));
  }

  async getNote(notebookId: string, noteId: string): Promise<Json> {
    const id = validId(noteId, "note:");
    const member = async () => (await this.listNotes(notebookId)).some((note) => note.id === id);
    if (!(await member())) throw new NotebookError("not_found", "rejected", 404);
    const detail = await this.request("GET", `/api/notes/${encodeURIComponent(id)}`);
    if (!isObject(detail) || detail.id !== id || !("content" in detail)) throw new NotebookError("response_invalid", "rejected");
    if (!(await member())) throw new NotebookError("not_found", "rejected", 404);
    return { id, title: text(detail.title), content: text(detail.content), updated: text(detail.updated) };
  }

  // ── chat ──

  /** Context map from enumerated membership (explicit maps, also when empty). */
  private async contextConfig(notebookId: string) {
    const sources = await this.listSources(notebookId, MAX_CONTEXT_ITEMS, 0);
    const notes = await this.listNotes(notebookId);
    if (sources.length >= MAX_CONTEXT_ITEMS || notes.length > MAX_CONTEXT_ITEMS) throw new NotebookError("context_limit_exceeded", "rejected", 413);
    return {
      sources: Object.fromEntries(sources.map((source) => [source.id, "full content"])),
      notes: Object.fromEntries(notes.map((note) => [note.id, "full content"])),
    };
  }

  /** The notebook context research chat sees, built server-side from enumerated membership; membership re-checked after. */
  async context(notebookId: string): Promise<{ sources: unknown[]; notes: unknown[]; tokenCount: number | null }> {
    const nb = validId(notebookId, "notebook:");
    const config = await this.contextConfig(nb);
    let body: unknown;
    try {
      body = await this.request("POST", "/api/chat/context", { notebook_id: nb, context_config: config });
    } catch (error) {
      if (error instanceof NotebookError && error.status === 413) throw new NotebookError("context_limit_exceeded", "rejected", 413);
      throw error;
    }
    const after = await this.contextConfig(nb);
    const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
    if (!same(config.sources, after.sources) || !same(config.notes, after.notes)) throw new NotebookError("context_membership_changed", "rejected", 409);
    if (!isObject(body) || !isObject(body.context)) throw new NotebookError("response_invalid", "rejected");
    const ctx = body.context;
    const sources = Array.isArray(ctx.sources) ? ctx.sources : [];
    const notes = Array.isArray(ctx.notes) ? ctx.notes : [];
    // Nothing outside the enumerated membership may come back.
    const allowed = new Set([...Object.keys(config.sources), ...Object.keys(config.notes)]);
    for (const item of [...sources, ...notes]) if (!isObject(item) || typeof item.id !== "string" || !allowed.has(item.id)) throw new NotebookError("incomplete_context", "rejected");
    return { sources, notes, tokenCount: typeof body.token_count === "number" ? body.token_count : null };
  }

  async createSession(notebookId: string, modelId: string, title?: string): Promise<string> {
    const nb = validId(notebookId, "notebook:");
    const created = await this.request("POST", "/api/chat/sessions", { notebook_id: nb, ...(title ? { title } : {}), model_override: validId(modelId, "model:") });
    if (!isObject(created)) throw new NotebookError("response_invalid", "ambiguous");
    return validId(created.id, "chat_session:");
  }

  async getSession(notebookId: string, sessionId: string): Promise<{ id: string; title: string | null; modelId: string | null; messages: ChatMessage[] }> {
    const id = validId(sessionId, "chat_session:");
    const body = await this.request("GET", `/api/chat/sessions/${encodeURIComponent(id)}`);
    // A session of another notebook answers like a missing one.
    if (!isObject(body) || body.id !== id || body.notebook_id !== notebookId) throw new NotebookError("not_found", "rejected", 404);
    return { id, title: text(body.title), modelId: text(body.model_override), messages: asList(body.messages ?? []).map(parseMessage) };
  }

  /** Execute one turn. `/api/chat/execute` returns the whole history: the answer is recovered by an exact diff. */
  async ask(notebookId: string, sessionId: string, modelId: string, message: string): Promise<ChatMessage> {
    const session = await this.getSession(notebookId, sessionId);
    if (session.modelId !== modelId) throw new NotebookError("model_policy_mismatch", "rejected");
    const context = await this.contextConfig(notebookId);
    const body = await this.request("POST", "/api/chat/execute", { session_id: session.id, message, context, model_override: modelId }, 300_000);
    if (!isObject(body) || body.session_id !== session.id || !Array.isArray(body.messages)) throw new NotebookError("response_mismatch", "ambiguous");
    const messages = body.messages.map(parseMessage);
    const prior = session.messages;
    if (messages.length !== prior.length + 2 || prior.some((item, i) => messages[i]?.id !== item.id)) throw new NotebookError("message_history_mismatch", "ambiguous");
    const human = messages[prior.length];
    const answer = messages[prior.length + 1];
    if (!human || !answer || human.type !== "human" || human.content !== message || answer.type !== "ai") throw new NotebookError("response_mismatch", "ambiguous");
    return answer;
  }

  // ── one-time model provisioning (keys from the bridge key store via getKey, C2) ──

  async provisionModels(input: { provider: string; apiKey: string; chatModel: string; embeddingProvider: string; embeddingApiKey: string; embeddingModel: string }): Promise<string> {
    const status = await this.request("GET", "/api/credentials/status");
    if (!isObject(status) || status.encryption_configured !== true) throw new NotebookError("encryption_not_configured", "rejected");
    const credential = async (provider: string, apiKey: string, modalities: string[]) => {
      const name = `knowledge-${provider}`;
      const listed = asList(await this.request("GET", `/api/credentials/by-provider/${encodeURIComponent(provider)}`));
      const match = listed.find((row) => row.name === name && typeof row.id === "string");
      if (match) {
        await this.request("PUT", `/api/credentials/${encodeURIComponent(String(match.id))}`, { api_key: apiKey, modalities });
        return String(match.id);
      }
      const created = await this.request("POST", "/api/credentials", { name, provider, modalities, api_key: apiKey });
      if (!isObject(created) || typeof created.id !== "string") throw new NotebookError("response_invalid", "ambiguous");
      return created.id;
    };
    const same = input.provider === input.embeddingProvider;
    const chatCredential = await credential(input.provider, input.apiKey, same ? ["embedding", "language"] : ["language"]);
    const embeddingCredential = same ? chatCredential : await credential(input.embeddingProvider, input.embeddingApiKey, ["embedding"]);
    const model = async (type: "language" | "embedding", provider: string, name: string, credentialId: string) => {
      const listed = asList(await this.request("GET", `/api/models?type=${type}`));
      const match = listed.find((row) => row.provider === provider && row.name === name && typeof row.id === "string");
      if (match && match.credential === credentialId) return String(match.id);
      if (match) await this.request("DELETE", `/api/models/${encodeURIComponent(String(match.id))}`); // no update endpoint upstream
      const created = await this.request("POST", "/api/models", { name, provider, type, credential: credentialId });
      if (!isObject(created) || typeof created.id !== "string") throw new NotebookError("response_invalid", "ambiguous");
      return created.id;
    };
    const chatModelId = await model("language", input.provider, input.chatModel, chatCredential);
    const embeddingModelId = await model("embedding", input.embeddingProvider, input.embeddingModel, embeddingCredential);
    const defaults = await this.request("GET", "/api/models/defaults");
    const currentEmbedding = isObject(defaults) && typeof defaults.default_embedding_model === "string" ? defaults.default_embedding_model : null;
    await this.request("PUT", "/api/models/defaults", {
      default_chat_model: chatModelId,
      default_transformation_model: chatModelId,
      default_tools_model: chatModelId,
      large_context_model: chatModelId,
      // Never switch the embedding model under existing vectors.
      ...(currentEmbedding && currentEmbedding !== embeddingModelId ? {} : { default_embedding_model: embeddingModelId }),
    });
    return validId(chatModelId, "model:");
  }
}

function parseMessage(value: unknown): ChatMessage {
  if (!isObject(value) || typeof value.id !== "string" || (value.type !== "human" && value.type !== "ai") || typeof value.content !== "string") {
    throw new NotebookError("response_invalid", "ambiguous");
  }
  return { id: value.id, type: value.type, content: value.content };
}
