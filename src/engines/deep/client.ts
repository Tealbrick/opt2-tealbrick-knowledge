// Client for the deep knowledge companion (helix-foundry behind Knowledge's token proxy, services/deep/supervisor.ts).
// Every request carries the proxy token; a foundry workspace token (one per deep space, read-only or editor) goes in
// `x-deep-token` so foundry applies its own workspace role (least privilege, FOUNDRY-DESIGN v2 §2).
export class DeepError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

export interface DeepHealth {
  ok: boolean;
  status: string;
  phase: string;
}

/** Answers above this size are refused (a query result is paged by foundry; an overview is small). */
export const DEEP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class DeepClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(opts: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    const url = new URL(opts.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("KNOWLEDGE_DEEP_URL must be a bare http(s) origin");
    }
    if (!/^[\x21-\x7e]{32,1024}$/u.test(opts.token)) throw new Error("KNOWLEDGE_DEEP_TOKEN must be 32-1024 printable characters");
    this.baseUrl = url.origin;
    this.token = opts.token;
    this.fetcher = opts.fetch ?? fetch;
  }

  /** The proxy's own health (children up and foundry's API answering); never throws. */
  async health(): Promise<DeepHealth> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(5000) });
      const body = (await res.json().catch(() => ({}))) as { status?: unknown; phase?: unknown };
      return { ok: res.ok, status: typeof body.status === "string" ? body.status.slice(0, 32) : res.ok ? "ok" : "failed", phase: typeof body.phase === "string" ? body.phase.slice(0, 32) : "" };
    } catch {
      return { ok: false, status: "unreachable", phase: "" };
    }
  }

  /** One foundry API call (`path` under /api/). Errors carry foundry's status and a closed code, never the upstream body. */
  async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, opts: { body?: unknown; workspaceToken?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!path.startsWith("/api/")) throw new DeepError("deep_path_invalid", 400);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (opts.workspaceToken) headers["x-deep-token"] = opts.workspaceToken;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        redirect: "error",
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch {
      throw new DeepError("deep_unavailable", 503);
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > DEEP_MAX_RESPONSE_BYTES) throw new DeepError("deep_answer_too_large", 502);
    const text = await res.text();
    if (text.length > DEEP_MAX_RESPONSE_BYTES) throw new DeepError("deep_answer_too_large", 502);
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? "deep_forbidden" : res.status === 404 ? "deep_not_found" : res.status === 409 ? "deep_conflict" : res.status === 400 ? "deep_invalid" : "deep_failed";
      throw new DeepError(code, res.status >= 500 ? 502 : res.status);
    }
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new DeepError("deep_unparsable", 502);
    }
  }

  // ── foundry API used by Knowledge (C373): every call runs as foundry's local owner through the proxy ──

  /** The workspaces foundry knows (its first request creates "My workspace"). */
  async workspaces(): Promise<{ id: string; name: string }[]> {
    const me = await this.request<{ workspaces?: { id?: unknown; name?: unknown }[] }>("GET", "/api/v1/me");
    return (me?.workspaces ?? []).flatMap((w) => (typeof w.id === "string" ? [{ id: w.id, name: typeof w.name === "string" ? w.name : "" }] : []));
  }

  async createWorkspace(name: string): Promise<string> {
    const out = await this.request<{ id?: unknown }>("POST", "/api/v1/workspaces", { body: { name: name.slice(0, 100) } });
    if (typeof out?.id !== "string") throw new DeepError("deep_unparsable", 502);
    return out.id;
  }

  /** New dataset (no `datasetId`) or a new snapshot of one; ≤ 10 000 rows (foundry's limit). */
  async ingest(workspace: string, name: string, rows: Record<string, unknown>[], datasetId?: string): Promise<DeepDataset> {
    const out = await this.request<DeepDataset>("POST", `/api/v1/workspaces/${seg(workspace)}/ingest`, { body: { name, rows, ...(datasetId ? { datasetId } : {}) }, timeoutMs: 180_000 });
    if (typeof out?.id !== "string") throw new DeepError("deep_unparsable", 502);
    return out;
  }

  /** A schema change waits as `pendingVersion` until accepted (foundry's review step); Knowledge's documents are the source. */
  acceptVersion(workspace: string, datasetId: string): Promise<DeepDataset> {
    return this.request<DeepDataset>("POST", `/api/v1/workspaces/${seg(workspace)}/datasets/${seg(datasetId)}/accept-version`, { body: {} });
  }

  describeDataset(workspace: string, datasetId: string, description: string): Promise<unknown> {
    return this.request("PATCH", `/api/v1/workspaces/${seg(workspace)}/datasets/${seg(datasetId)}`, { body: { description: description.slice(0, 4000) } });
  }

  async datasets(workspace: string): Promise<DeepDataset[]> {
    const out = await this.request<{ items?: DeepDataset[] }>("GET", `/api/v1/workspaces/${seg(workspace)}/resources/dataset`);
    return Array.isArray(out?.items) ? out.items : [];
  }

  /** Read-only SQL over the named datasets (foundry's DuckDB executor: no network, read-only). */
  async query(workspace: string, inputs: string[], sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    const out = await this.request<{ rows?: unknown }>("POST", `/api/v1/workspaces/${seg(workspace)}/query`, { body: { inputs, sql } });
    return { rows: Array.isArray(out?.rows) ? (out.rows as Record<string, unknown>[]) : [] };
  }

  /** Starts foundry's own analyst on a question (`intent: answer`: never builds or publishes). */
  async startRun(workspace: string, goal: string): Promise<DeepRun> {
    return this.request<DeepRun>("POST", `/api/v1/workspaces/${seg(workspace)}/assistant/runs`, { body: { goal, intent: "answer" } });
  }

  getRun(workspace: string, runId: string): Promise<DeepRun> {
    return this.request<DeepRun>("GET", `/api/v1/workspaces/${seg(workspace)}/resources/run/${seg(runId)}`);
  }

  /** The supervisor's own state (model role applied to foundry, or not). Never throws. */
  async status(): Promise<DeepServiceStatus> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/deep/status`, { headers: { authorization: `Bearer ${this.token}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { model: { state: "unknown" } };
      const body = (await res.json().catch(() => ({}))) as { model?: Record<string, unknown> };
      const m = body.model ?? {};
      const state = typeof m.state === "string" && ["unset", "pending", "ok", "failed"].includes(m.state) ? (m.state as DeepModelState) : "unknown";
      return { model: { state, ...(typeof m.provider === "string" ? { provider: m.provider.slice(0, 32) } : {}), ...(typeof m.model === "string" ? { model: m.model.slice(0, 128) } : {}), ...(typeof m.error === "string" ? { error: m.error.slice(0, 200) } : {}) } };
    } catch {
      return { model: { state: "unknown" } };
    }
  }
}

const seg = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new DeepError("deep_path_invalid", 400);
  return value;
};

export interface DeepDataset {
  id: string;
  name: string;
  description?: string;
  data?: {
    activeVersion?: string | null;
    pendingVersion?: string | null;
    table?: string;
    lastSync?: string;
    profile?: { rows?: number; columns?: { name: string; type: string; sensitive?: boolean }[] };
  };
}

export interface DeepRun {
  id: string;
  data?: {
    status?: "queued" | "running" | "awaiting_review" | "succeeded" | "failed" | "canceled";
    error?: string;
    answer?: { title?: unknown; summary?: unknown; sql?: unknown; inputs?: unknown; rows?: unknown; assumptions?: unknown; [key: string]: unknown };
    [key: string]: unknown;
  };
}

export type DeepModelState = "unset" | "pending" | "ok" | "failed" | "unknown";

export interface DeepServiceStatus {
  model: { state: DeepModelState; provider?: string; model?: string; error?: string };
}
