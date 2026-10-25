// Connection to the private, unmodified upstream GBrain service.
// Knowledge holds only GBrain's own bootstrap credential and registers OAuth clients through the
// upstream admin API. Every MCP call carries a token of a client bound to exactly ONE GBrain source
// (one Knowledge area), so upstream itself enforces source isolation. One client per (source, agent)
// keeps upstream ownership (forget) and delta cursors per agent.
import { createHash, randomBytes } from "node:crypto";
import { callToolAnswer, GBrainError, listTools, readJsonResource, type ToolAnswer } from "./transport.ts";

/** Upstream source id grammar (≤ 32 chars). */
export const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

export interface StoredClient {
  clientId: string;
  clientSecret: string;
  sourceId: string;
  principal: string | null;
}

/** Where registered client credentials live (SDK app secrets: sealed, never exported). */
export interface ClientStore {
  get(key: string): Promise<StoredClient | null>;
  set(key: string, client: StoredClient): Promise<void>;
  delete(key: string): Promise<void>;
}

export class GBrainServiceError extends Error {
  readonly code: "area_binding_required" | "gbrain_admin_unavailable" | "gbrain_client_registration_failed" | "gbrain_starting" | "gbrain_token_unavailable";
  constructor(code: GBrainServiceError["code"], message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export const principalClientKey = (principalId: string) => `kc-${createHash("sha256").update(principalId).digest("hex").slice(0, 24)}`;

/** Deterministic UUID-shaped request id: an identical intent replays upstream, a new intent never collides. */
export function deterministicRequestId(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export interface GBrainClientOptions {
  baseUrl: string;
  adminToken: string;
  store: ClientStore;
  fetch?: typeof fetch;
  now?: () => number;
}

/** QA-KN027-1: why an engine call failed, for the app log. Stage, HTTP status and the error's own code only: never a body, URL or token. */
export interface GBrainFailure {
  stage: "admin_login" | "full_stats" | "register_client" | "token";
  status?: number;
  cause?: string;
}

/**
 * The error chain for the log, outermost first, at most 5 links: name, code, errno, syscall, address, port of each
 * (undici puts the network error in `cause`, e.g. `TypeError` <- `Error code=ECONNREFUSED syscall=connect address=fd12::1 port=3131`).
 * Never the message: it can carry a URL or an upstream body. Each field is sanitized and short; the whole string at most 400.
 */
export function failureCause(error: unknown): string {
  const clean = (v: unknown, n: number) => String(v).replace(/[^A-Za-z0-9_.:/[\]-]/gu, "").slice(0, n);
  const links: string[] = [];
  let current: unknown = error;
  for (let i = 0; current !== undefined && current !== null && i < 5; i++) {
    if (typeof current !== "object") {
      links.push(clean(typeof current, 16));
      break;
    }
    const c = current as { name?: unknown; code?: unknown; errno?: unknown; syscall?: unknown; address?: unknown; port?: unknown; cause?: unknown; constructor?: { name?: unknown } };
    const parts = [clean(c.name ?? c.constructor?.name ?? "object", 40)];
    for (const key of ["code", "errno", "syscall", "address", "port"] as const) if (c[key] !== undefined && c[key] !== null) parts.push(`${key}=${clean(c[key], key === "address" ? 64 : 32)}`);
    links.push(parts.join(" "));
    current = c.cause;
  }
  return links.join(" <- ").slice(0, 400);
}

/**
 * QA-KN027-1: until GBrain serves, the companion's boot supervisor answers EVERY path with 503 {"status":"starting"}
 * (services/gbrain/boot.ts). Such an answer means "not up yet", not "broken": callers retry instead of failing.
 */
async function bootStarting(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  const body = (await response.clone().json().catch(() => null)) as { status?: unknown } | null;
  return body?.status === "starting";
}

export class GBrainClient {
  readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly store: ClientStore;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private adminCookie: { value: string; expires: number } | null = null;
  /** QA-KN027-1: set by the app (onStart) to log engine-call failures; each distinct failure is logged once in a row. */
  onFailure: ((failure: GBrainFailure) => void) | null = null;
  private lastFailure = "";

  private failed(failure: GBrainFailure): void {
    const key = `${failure.stage}|${failure.status ?? ""}|${failure.cause ?? ""}`;
    if (key === this.lastFailure) return;
    this.lastFailure = key;
    this.onFailure?.(failure);
  }
  private readonly tokens = new Map<string, { token: string; expires: number }>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(opts: GBrainClientOptions) {
    const url = new URL(opts.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("KNOWLEDGE_GBRAIN_URL must be a bare http(s) origin");
    }
    if (!/^[\x21-\x7e]{32,1024}$/u.test(opts.adminToken)) throw new Error("KNOWLEDGE_GBRAIN_ADMIN_TOKEN must be 32-1024 printable characters");
    this.baseUrl = url.origin;
    this.adminToken = opts.adminToken;
    this.store = opts.store;
    this.fetcher = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async admin(): Promise<string> {
    if (this.adminCookie && this.adminCookie.expires > this.now()) return this.adminCookie.value;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/admin/login`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.adminToken }),
      });
    } catch (error) {
      this.failed({ stage: "admin_login", cause: failureCause(error) });
      throw new GBrainServiceError("gbrain_admin_unavailable");
    }
    if (await bootStarting(response)) {
      await response.body?.cancel();
      this.failed({ stage: "admin_login", status: 503, cause: "engine_starting" });
      throw new GBrainServiceError("gbrain_starting");
    }
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    await response.body?.cancel();
    if (!response.ok || !cookie?.startsWith("gbrain_admin=")) {
      this.failed({ stage: "admin_login", status: response.status, cause: response.ok ? "no_admin_cookie" : "http_status" });
      throw new GBrainServiceError("gbrain_admin_unavailable");
    }
    this.lastFailure = "";
    // Upstream admin sessions last 24 h; renew well before.
    this.adminCookie = { value: cookie, expires: this.now() + 12 * 3_600_000 };
    return cookie;
  }

  private async register(sourceId: string, principal: string | null): Promise<StoredClient> {
    const name = `knowledge-${sourceId}${principal ? `-${principal}` : ""}-${randomBytes(4).toString("hex")}`;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/admin/api/register-client`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", cookie: await this.admin() },
        body: JSON.stringify({ name, source: sourceId, scopes: "read write", grantTypes: ["client_credentials"] }),
      });
    } catch (error) {
      if (error instanceof GBrainServiceError) throw error;
      this.failed({ stage: "register_client", cause: failureCause(error) });
      throw new GBrainServiceError("gbrain_client_registration_failed");
    }
    if (await bootStarting(response)) {
      await response.body?.cancel();
      throw new GBrainServiceError("gbrain_starting");
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 401) this.adminCookie = null;
    if (!response.ok) {
      this.failed({ stage: "register_client", status: response.status, cause: "http_status" });
      if (body?.error === "unknown_source" || body?.error === "archived_source") throw new GBrainServiceError("area_binding_required", "memory engine source is not provisioned for this area");
      throw new GBrainServiceError("gbrain_client_registration_failed");
    }
    if (typeof body?.clientId !== "string" || typeof body.clientSecret !== "string") throw new GBrainServiceError("gbrain_client_registration_failed");
    return { clientId: body.clientId, clientSecret: body.clientSecret, sourceId, principal };
  }

  private async client(key: string, sourceId: string, principal: string | null): Promise<StoredClient> {
    const existing = await this.store.get(key);
    if (existing && existing.sourceId === sourceId && existing.principal === principal) return existing;
    const registered = await this.register(sourceId, principal);
    await this.store.set(key, registered);
    return registered;
  }

  private async mint(stored: StoredClient): Promise<{ token: string; expiresIn: number } | null> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: stored.clientId, client_secret: stored.clientSecret, scope: "read write" }),
      });
    } catch (error) {
      this.failed({ stage: "token", cause: failureCause(error) });
      throw new GBrainServiceError("gbrain_token_unavailable");
    }
    if (await bootStarting(response)) {
      await response.body?.cancel();
      throw new GBrainServiceError("gbrain_starting");
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 400 || response.status === 401) return null; // revoked or unknown client: re-register once
    if (!response.ok || typeof body?.access_token !== "string") {
      this.failed({ stage: "token", status: response.status, cause: response.ok ? "no_access_token" : "http_status" });
      throw new GBrainServiceError("gbrain_token_unavailable");
    }
    return { token: body.access_token, expiresIn: typeof body.expires_in === "number" ? body.expires_in : 300 };
  }

  /** Access token for a source (optionally per agent), cached until 60 s before expiry; concurrent callers share one mint. */
  async token(sourceId: string, principalId?: string): Promise<string> {
    if (!SOURCE_ID.test(sourceId)) throw new GBrainServiceError("area_binding_required");
    const principal = principalId ? principalClientKey(principalId) : null;
    const key = `${sourceId}|${principal ?? ""}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires > this.now()) return cached.token;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const request = (async () => {
      let stored = await this.client(key, sourceId, principal);
      let minted = await this.mint(stored);
      if (!minted) {
        await this.store.delete(key);
        stored = await this.client(key, sourceId, principal);
        minted = await this.mint(stored);
        if (!minted) throw new GBrainServiceError("gbrain_token_unavailable");
      }
      this.tokens.set(key, { token: minted.token, expires: this.now() + Math.max(30, minted.expiresIn - 60) * 1000 });
      return minted.token;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private invalidate(sourceId: string, principalId?: string) {
    this.tokens.delete(`${sourceId}|${principalId ? principalClientKey(principalId) : ""}`);
  }

  async call(sourceId: string, name: string, args: Record<string, unknown>, opts: { principalId?: string; timeoutMs?: number } = {}): Promise<unknown> {
    return (await this.callAnswer(sourceId, name, args, opts)).data;
  }

  /** `call` with upstream's notices and degraded stages (recall reports a degraded engine, QA F88/F89). */
  async callAnswer(sourceId: string, name: string, args: Record<string, unknown>, opts: { principalId?: string; timeoutMs?: number } = {}): Promise<ToolAnswer> {
    const invoke = async () =>
      callToolAnswer({ baseUrl: this.baseUrl, token: await this.token(sourceId, opts.principalId), name, args, timeoutMs: opts.timeoutMs, fetch: this.fetcher });
    try {
      return await invoke();
    } catch (error) {
      // Upstream rejects a stale token before dispatch, so one retry cannot double-execute.
      if (error instanceof GBrainError && error.kind === "http" && error.status === 401) {
        this.invalidate(sourceId, opts.principalId);
        return invoke();
      }
      throw error;
    }
  }

  async tools(sourceId: string): Promise<Record<string, unknown>[]> {
    const list = async () => listTools({ baseUrl: this.baseUrl, token: await this.token(sourceId), fetch: this.fetcher });
    try {
      return await list();
    } catch (error) {
      // C296: a stale token (e.g. the engine restarted) is retried once with a fresh one, as tool calls are.
      if (error instanceof GBrainError && error.kind === "http" && error.status === 401) {
        this.invalidate(sourceId);
        return list();
      }
      throw error;
    }
  }

  /** C296: the engine's own view of this connection (`gbrain://capabilities`): surface, visible operations, readiness. */
  async capabilities(sourceId: string): Promise<unknown> {
    const read = async () => readJsonResource({ baseUrl: this.baseUrl, token: await this.token(sourceId), uri: "gbrain://capabilities", fetch: this.fetcher });
    try {
      return await read();
    } catch (error) {
      if (error instanceof GBrainError && error.kind === "http" && error.status === 401) {
        this.invalidate(sourceId);
        return read();
      }
      throw error;
    }
  }

  /** C296: brain-wide counts from the admin API (`/admin/api/full-stats`): pages, chunks, embedded chunks, version. */
  async fullStats(): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}/admin/api/full-stats`, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { cookie: await this.admin() } });
      } catch (error) {
        if (error instanceof GBrainServiceError) throw error;
        this.failed({ stage: "full_stats", cause: failureCause(error) });
        throw new GBrainServiceError("gbrain_admin_unavailable");
      }
      // Admin sessions live in the engine's memory: after an engine restart the cookie is unknown; log in again once.
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        this.adminCookie = null;
        continue;
      }
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      // An unhealthy engine answers 503 {error, error_description}: no counts → unavailable.
      if (!body || typeof body.page_count !== "number") {
        this.failed({ stage: "full_stats", status: response.status, cause: body ? "no_page_count" : "no_json" });
        throw new GBrainServiceError("gbrain_admin_unavailable");
      }
      return body;
    }
    throw new GBrainServiceError("gbrain_admin_unavailable");
  }

  /** Knowledge owns its projected pages: write against the current revision with a deterministic request id. */
  async putCanonicalPage(sourceId: string, slug: string, content: string): Promise<void> {
    const contentHash = createHash("sha256").update(content).digest("hex");
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = await this.pageRevision(sourceId, slug);
      try {
        await this.call(sourceId, "put_page", {
          slug,
          content,
          ...(revision ? { expected_revision: revision } : {}),
          request_id: deterministicRequestId("put_page", sourceId, slug, contentHash, revision ?? "create"),
        }, { timeoutMs: 300_000 });
        return;
      } catch (error) {
        if (attempt === 0 && error instanceof GBrainError && error.code === "revision_conflict") continue;
        throw error;
      }
    }
  }

  async deleteCanonicalPage(sourceId: string, slug: string): Promise<"deleted" | "absent"> {
    const revision = await this.pageRevision(sourceId, slug);
    if (!revision) return "absent";
    await this.call(sourceId, "delete_page", { slug, expected_revision: revision, request_id: deterministicRequestId("delete_page", sourceId, slug, revision) });
    return "deleted";
  }

  private async pageRevision(sourceId: string, slug: string): Promise<string | null> {
    try {
      const page = (await this.call(sourceId, "get_page", { slug, include_content: true })) as Record<string, unknown> | null;
      return page && typeof page.revision === "string" ? page.revision : null;
    } catch (error) {
      if (error instanceof GBrainError && error.code === "page_not_found") return null;
      throw error;
    }
  }

  async health(timeoutMs = 1500): Promise<{ ok: true; version: string | null } | { ok: false; reason: string }> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      const text = (await response.text()).slice(0, 16_384);
      if (!response.ok) return { ok: false, reason: `http_${response.status}` };
      const body = JSON.parse(text) as Record<string, unknown>;
      if (body.status !== "ok") return { ok: false, reason: "not_ok" };
      return { ok: true, version: typeof body.version === "string" ? body.version : null };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }
}
