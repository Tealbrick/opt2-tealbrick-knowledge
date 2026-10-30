// Why an embedding call failed, in a closed vocabulary. GBrain reports every failed embedding call as
// `embed_unavailable:provider_error` on purpose (its stage codes never carry upstream text), so a 401, an empty quota, a wrong
// model and an unreachable address all look the same from outside. Labels only: this module never returns upstream text,
// because a provider can echo the key in it. Pure: embed-check.ts feeds it the error of one real call.

/**
 * - `auth`: the provider refuses the key (401, 403).
 * - `quota`: the account has no credit or quota left (402, 429 naming quota or billing).
 * - `rate_limited`: 429 without a quota reason; clears by itself.
 * - `model`: the provider answers but refuses the request: unknown model, no access to it, wrong address path, wrong size.
 * - `unreachable`: no HTTP answer at all: DNS, refused connection, TLS, timeout.
 * - `provider_failing`: the provider answers 408 or 5xx.
 * - `unknown`: none of these could be told.
 */
export type EmbedCause = "auth" | "quota" | "rate_limited" | "model" | "unreachable" | "provider_failing" | "unknown";
export const EMBED_CAUSES: readonly EmbedCause[] = ["auth", "quota", "rate_limited", "model", "unreachable", "provider_failing", "unknown"];

/** The result of one check. `ok`: a real call just worked. `not_ready`: GBrain has no usable embeddings setup, so no call was made. */
export type EmbedCheck = { result: "ok"; at: string } | { result: "not_ready"; at: string } | { result: "failed"; cause: EmbedCause; status: number | null; at: string };

interface Facts {
  status: number | null;
  /** lower-case text from the error chain; used for matching only, never returned */
  text: string;
  network: boolean;
}

const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ConnectionRefused", "FailedToOpenSocket", "UND_ERR_CONNECT_TIMEOUT"]);
const NETWORK_NAMES = new Set(["AbortError", "TimeoutError"]);
const NETWORK_TEXT = /fetch failed|unable to connect|connection refused|socket|timed out|timeout|getaddrinfo|network/u;
const QUOTA_TEXT = /insufficient_quota|quota|billing|credit|payment/u;
const MODEL_ACCESS_TEXT = /model_not_found|does not have access to model|no access to|not available for|model .*(not found|does not exist)/u;

function facts(err: unknown): Facts {
  let status: number | null = null;
  let network = false;
  const text: string[] = [];
  let current = err;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const e = current as Record<string, unknown>;
    for (const field of [e.status, e.statusCode, e.apiErrorStatus]) {
      if (status === null && typeof field === "number" && field >= 100 && field < 600) status = field;
    }
    if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) network = true;
    if (typeof e.name === "string" && NETWORK_NAMES.has(e.name)) network = true;
    for (const field of [e.message, e.responseBody]) if (typeof field === "string") text.push(field.toLowerCase());
    current = e.cause;
  }
  return { status, text: text.join(" "), network };
}

/** What one failed embedding call means for the owner. */
export function classifyEmbedFailure(err: unknown): { cause: EmbedCause; status: number | null } {
  const { status, text, network } = facts(err);
  const cause = ((): EmbedCause => {
    if (status === 401) return "auth";
    if (status === 403) return MODEL_ACCESS_TEXT.test(text) ? "model" : "auth";
    if (status === 402) return "quota";
    if (status === 429) return QUOTA_TEXT.test(text) ? "quota" : "rate_limited";
    if (status === 408 || (status !== null && status >= 500)) return "provider_failing";
    if (status !== null && status >= 400) return "model";
    if (network || NETWORK_TEXT.test(text)) return "unreachable";
    // no HTTP status and no network sign: GBrain's own checks of the answer (the vector has the wrong size)
    if (/dimension|\bdim\b|\bdims\b/u.test(text)) return "model";
    return "unknown";
  })();
  return { cause, status };
}
