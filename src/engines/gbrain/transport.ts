// Stateless MCP transport to an unmodified upstream GBrain service (`gbrain serve --http`).
// Plain JSON-RPC POST to /mcp (no initialize handshake: upstream is stateless), JSON or SSE answers,
// bounded body, no redirects, never retries (a possibly executed write must stay uncertain).
import { randomUUID } from "node:crypto";

export const GBRAIN_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Upstream error categories that may leave Knowledge; any other upstream text is dropped. */
export const SAFE_TOOL_ERRORS: ReadonlySet<string> = new Set([
  "permission_denied", "scope_denied", "embedding_failed", "extraction_failed", "rate_limited",
  "invalid_params", "page_not_found", "revision_conflict", "unavailable", "operation_failed",
]);

export type GBrainErrorKind = "http" | "protocol" | "tool";

export class GBrainError extends Error {
  readonly kind: GBrainErrorKind;
  readonly status: number | null;
  /** allowlisted upstream code (tool errors) or null */
  readonly code: string | null;
  constructor(kind: GBrainErrorKind, message: string, opts: { status?: number; code?: string | null } = {}) {
    super(message);
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseEnvelope(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GBrainError("protocol", "invalid GBrain MCP JSON response");
  }
}

function firstText(result: Record<string, unknown>): string | undefined {
  const first = Array.isArray(result.content) ? result.content.find((item) => isRecord(item) && item.type === "text") : undefined;
  return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
}

/** A GBrain notice (upstream 0.60.57.0 `_meta.gbrain_notices[]` and `[gbrain notice <code> kind=<kind>]` text blocks). */
export interface GBrainNotice {
  code: string;
  kind: string;
}

/** A degraded retrieval stage (`_meta.retrieval.degraded[]`; closed upstream vocabularies, never raw error text). */
export interface DegradedStage {
  stage: string;
  reason: string | null;
}

/** A parsed tool answer: the ONE result item plus what upstream said about how it was produced. */
export interface ToolAnswer {
  data: unknown;
  notices: GBrainNotice[];
  /** recall-affecting degraded stages (upstream's ranking-only `reranker_skipped` is left out) */
  degraded: DegradedStage[];
}

const NOTICE_BLOCK = /^\[gbrain notice ([a-z0-9_]{1,64}) kind=([a-z_]{1,32})\]/u;
const VOCAB = /^[a-z0-9_]{1,64}$/u;
/** Upstream RANKING_ONLY_DEGRADED_STAGES at the pin: the result set is complete, only its order differs. */
const RANKING_ONLY = new Set(["reranker_skipped"]);

function noticesOf(result: Record<string, unknown>, blocks: string[]): GBrainNotice[] {
  const out = new Map<string, GBrainNotice>();
  const meta = isRecord(result._meta) ? result._meta : null;
  for (const item of Array.isArray(meta?.gbrain_notices) ? meta.gbrain_notices : []) {
    if (isRecord(item) && typeof item.code === "string" && VOCAB.test(item.code)) out.set(item.code, { code: item.code, kind: typeof item.kind === "string" && VOCAB.test(item.kind) ? item.kind : "info" });
  }
  for (const block of blocks) {
    const match = NOTICE_BLOCK.exec(block);
    if (match && !out.has(match[1] as string)) out.set(match[1] as string, { code: match[1] as string, kind: match[2] as string });
  }
  return [...out.values()];
}

function degradedOf(result: Record<string, unknown>): DegradedStage[] {
  const meta = isRecord(result._meta) ? result._meta : null;
  const retrieval = isRecord(meta?.retrieval) ? meta.retrieval : null;
  const list = Array.isArray(retrieval?.degraded) ? retrieval.degraded : [];
  return list.flatMap((item): DegradedStage[] => {
    const stage = typeof item === "string" ? item : isRecord(item) && typeof item.stage === "string" ? item.stage : null;
    if (!stage || !VOCAB.test(stage) || RANKING_ONLY.has(stage)) return [];
    const reason = isRecord(item) && typeof item.reason === "string" && VOCAB.test(item.reason) ? item.reason : null;
    return [{ stage, reason }];
  });
}

/**
 * The result item, picked by SHAPE, never by position (QA F88): upstream puts the result JSON first and may add notice
 * blocks (`[gbrain notice …]`) and plain evidence blocks after it. Exactly one text item that parses as a JSON object or
 * array is the result; two are ambiguous and refused; with none, the plain text is the result (a string: a caller that
 * expects rows treats it as unparsable, falls back and says so, L3); notice blocks are never the result.
 */
function pickResult(texts: string[]): unknown {
  const blocks = texts.filter((text) => !NOTICE_BLOCK.test(text));
  const parsed = blocks.flatMap((text) => {
    try {
      const value: unknown = JSON.parse(text);
      return value !== null && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (parsed.length === 1) return parsed[0];
  if (parsed.length > 1) throw new GBrainError("protocol", "GBrain answer carries more than one result item");
  if (!blocks.length) throw new GBrainError("protocol", "GBrain answer has no result item");
  if (blocks.length > 1) return blocks.join("\n\n");
  try {
    return JSON.parse(blocks[0] as string);
  } catch {
    return blocks[0];
  }
}

function resultData(message: unknown, id: string): ToolAnswer {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || message.id !== id) throw new GBrainError("protocol", "invalid or mismatched GBrain MCP response");
  if ("error" in message) throw new GBrainError("protocol", "GBrain MCP protocol error");
  const result = message.result;
  if (!isRecord(result) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new GBrainError("protocol", "invalid GBrain MCP tool result");
  if (result.isError) {
    let code: unknown;
    try {
      const text = firstText(result);
      code = text ? (JSON.parse(text) as Record<string, unknown>).error : undefined;
    } catch {
      code = undefined;
    }
    const safe = typeof code === "string" && SAFE_TOOL_ERRORS.has(code) ? code : null;
    throw new GBrainError("tool", `GBrain tool execution failed${safe ? `: ${safe}` : ""}`, { code: safe });
  }
  const text = Array.isArray(result.content) ? result.content.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text") : [];
  if (text.some((item) => typeof item.text !== "string")) throw new GBrainError("protocol", "invalid GBrain text content");
  const texts = text.map((item) => item.text as string);
  const notices = noticesOf(result, texts);
  const degraded = degradedOf(result);
  if ("structuredContent" in result) {
    if (!isRecord(result.structuredContent)) throw new GBrainError("protocol", "invalid GBrain structured content");
    return { data: result.structuredContent, notices, degraded };
  }
  if (!Array.isArray(result.content)) throw new GBrainError("protocol", "missing GBrain tool content");
  return { data: pickResult(texts), notices, degraded };
}

async function rpc(baseUrl: string, token: string, body: Record<string, unknown>, timeoutMs: number, fetcher: typeof fetch): Promise<{ text: string; sse: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(`${baseUrl}/mcp`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GBrainError("http", `GBrain HTTP ${response.status}`, { status: response.status });
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const sse = contentType === "text/event-stream";
    if (!sse && contentType !== "application/json") {
      await response.body?.cancel();
      throw new GBrainError("protocol", "unsupported GBrain MCP content type");
    }
    if (!response.body) throw new GBrainError("protocol", "missing GBrain MCP response body");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > GBRAIN_MAX_RESPONSE_BYTES) throw new GBrainError("protocol", "GBrain MCP response exceeds 2 MiB");
      }
      text += decoder.decode(value, { stream: !done });
      // An SSE stream may stay open after the result: stop at the first complete JSON-RPC answer.
      if (sse && /\r?\n\r?\n/u.test(text) && sseResult(text, body.id as string) !== undefined) break;
      if (done) break;
    }
    return { text, sse };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

/** First SSE event that answers `id` (progress notifications are skipped). */
function sseResult(text: string, id: string): unknown {
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) continue;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (isRecord(message) && message.id === id) return message;
  }
  return undefined;
}

export interface TransportOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** One tool call; the parsed result item with upstream's notices and degraded stages. */
export async function callToolAnswer(opts: TransportOptions & { name: string; args: Record<string, unknown> }): Promise<ToolAnswer> {
  const id = randomUUID();
  const { text, sse } = await rpc(opts.baseUrl, opts.token, { jsonrpc: "2.0", id, method: "tools/call", params: { name: opts.name, arguments: opts.args } }, opts.timeoutMs ?? 30_000, opts.fetch ?? fetch);
  const message = sse ? sseResult(text, id) : parseEnvelope(text);
  if (message === undefined) throw new GBrainError("protocol", "GBrain MCP stream ended without a result");
  return resultData(message, id);
}

/** One tool call; the parsed result item only. */
export async function callTool(opts: TransportOptions & { name: string; args: Record<string, unknown> }): Promise<unknown> {
  return (await callToolAnswer(opts)).data;
}

export async function listTools(opts: TransportOptions): Promise<Record<string, unknown>[]> {
  const id = randomUUID();
  const { text, sse } = await rpc(opts.baseUrl, opts.token, { jsonrpc: "2.0", id, method: "tools/list", params: {} }, opts.timeoutMs ?? 30_000, opts.fetch ?? fetch);
  const message = sse ? sseResult(text, id) : parseEnvelope(text);
  if (!isRecord(message) || message.id !== id || !isRecord(message.result) || !Array.isArray(message.result.tools)) {
    throw new GBrainError("protocol", "invalid GBrain MCP tools/list response");
  }
  return message.result.tools.filter(isRecord);
}

/** MCP resources/read: the first text content parsed as JSON (C296: `gbrain://capabilities`, readiness + surface). */
export async function readJsonResource(opts: TransportOptions & { uri: string }): Promise<unknown> {
  const id = randomUUID();
  const { text, sse } = await rpc(opts.baseUrl, opts.token, { jsonrpc: "2.0", id, method: "resources/read", params: { uri: opts.uri } }, opts.timeoutMs ?? 15_000, opts.fetch ?? fetch);
  const message = sse ? sseResult(text, id) : parseEnvelope(text);
  const contents = isRecord(message) && message.id === id && isRecord(message.result) && Array.isArray(message.result.contents) ? message.result.contents : null;
  const first = contents?.find((c): c is Record<string, unknown> => isRecord(c) && typeof c.text === "string");
  if (!first) throw new GBrainError("protocol", "invalid GBrain MCP resources/read response");
  try {
    return JSON.parse(first.text as string);
  } catch {
    throw new GBrainError("protocol", "GBrain resource is not JSON");
  }
}
