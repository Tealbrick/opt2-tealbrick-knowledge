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
}
