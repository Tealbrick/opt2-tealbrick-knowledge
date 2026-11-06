// Wiring of Knowledge's domain services onto the SDK-provided database and context.
import type { Db, Json } from "@opt2-tealbrick/spec/sdk";
import { type AreaProvisioner, Areas } from "./areas.ts";
import { type KnowledgeConfig, PROVIDER_KEY, PROVIDER_MODELS } from "./config.ts";
import { type CallApp, onDirectoryModel, startDirectoryTimer } from "./directory-feed.ts";
import { type ClientStore, GBrainClient, type StoredClient } from "./engines/gbrain/client.ts";
import { GBrainEngine } from "./engines/gbrain/engine.ts";
import { NotebookClient } from "./engines/notebook/client.ts";
import { areaSourceId, SHARED_AREA_ID } from "./ids.ts";
import { ensureDirectoryAreas } from "./people.ts";
import { Projector } from "./projection.ts";
import { DocumentStore } from "./store/documents.ts";

/** What provisioning needs from an SDK context (OpContext has both). */
export interface ServiceAccess {
  getKey(name: string): Promise<string | null>;
  callServiceHelper<O = unknown>(serviceId: string, path: string, body: never): Promise<O>;
}

export interface Services {
  db: Db;
  store: DocumentStore;
  areas: Areas;
  engine: GBrainEngine | null;
  notebook: NotebookClient | null;
  projector: Projector | null;
  config: KnowledgeConfig;
}

/** SDK app secrets (C31): sealed under TB_KEK, excluded from export. */
export interface AppSecrets {
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

/** GBrain OAuth client credentials kept as app secrets (a restore into another deployment simply re-registers). */
class SecretClientStore implements ClientStore {
  private readonly secrets: AppSecrets;
  constructor(secrets: AppSecrets) {
    this.secrets = secrets;
  }
  /** SDK secret names allow [A-Za-z0-9._:/-] only; the client key `<source>|<principal>` becomes `gbrain-client/<source>/<principal|shared>`. */
  private name(key: string) {
    const [source, principal] = key.split("|");
    return `gbrain-client/${source}/${principal || "shared"}`;
  }
  async get(key: string): Promise<StoredClient | null> {
    const raw = await this.secrets.get(this.name(key));
    return raw ? (JSON.parse(raw) as StoredClient) : null;
  }
  async set(key: string, client: StoredClient): Promise<void> {
    await this.secrets.put(this.name(key), JSON.stringify(client));
  }
  async delete(key: string): Promise<void> {
    await this.secrets.delete(this.name(key));
  }
}

/** What the memory engine last showed (QA F89, L3): recall answers and a periodic probe update it. */
export interface EngineHealth {
  /** unknown: nothing seen yet; ok: full recall; degraded: upstream ran part of its pipeline only; failing: answers fail */
  state: "unknown" | "starting" | "ok" | "degraded" | "failing";
  /** degraded stages (`stage[:reason]`, upstream closed vocabularies) or Knowledge error codes; never raw upstream text */
  detail: string[];
  at: number;
}

/** SDK-API (spec 0.1.28) `AppAttention`: app-reported condition for the owner (status push → Portal). */
export interface Attention {
  code: string;
  reason: string;
}

/** Engine probe interval: one cheap one-row query on the company area (embeds a 4-word query when embeddings work). */
export const ENGINE_PROBE_MS = 10 * 60_000;
/** QA-KN027-1: after a probe that did not reach the engine, re-probe after this, doubling up to ENGINE_REPROBE_MAX_MS. */
export const ENGINE_REPROBE_MS = 1_000;
export const ENGINE_REPROBE_MAX_MS = 60_000;
/** QA-KN027-1: how long an engine that answers "not up yet" counts as starting before it is reported failing. */
export const ENGINE_STARTING_MAX_MS = 10 * 60_000;
export const ENGINE_STARTING = "memory_engine_starting";
/** QA R-2: attention code when the provider refuses the engine's embedding calls (the key is set but rejected). */
export const KEY_REJECTED = "memory_engine_key_rejected";
/**
 * What a fresh test call shows when the provider refuses the engine's embedding calls (KN-EMBED; services/gbrain/embed-cause.ts). GBrain
 * reports them all as `embed_unavailable:provider_error` or `embed_timeout:timeout`, so only that call tells them apart.
 */
export const PROVIDER_QUOTA = "memory_engine_provider_quota";
export const PROVIDER_BUSY = "memory_engine_provider_busy";
export const MODEL_REFUSED = "memory_engine_model_refused";
export const PROVIDER_UNREACHABLE = "memory_engine_provider_unreachable";
export const PROVIDER_FAILING = "memory_engine_provider_failing";
/** At most one test call per this time from the app (the engine side also keeps its answer for a minute). */
export const EMBED_CHECK_MIN_MS = 60_000;
/**
 * GBrain stages that describe one query's answer, not a part of the engine that does not work. A status check that finds no exact
 * keyword match is not a fault (qa1 2026-10: `keyword_relaxed_carried` read as "memory engine degraded" for days).
 */
const QUERY_NOTES: ReadonlySet<string> = new Set(["keyword_zero", "keyword_relaxed_carried", "budget_truncated", "budget_dropped_all", "cache_prestamp", "reranker_skipped", "rerank_passthrough", "projection_pending", "projection_by_design", "safe_index_pending"]);
const isFault = (d: string): boolean => !QUERY_NOTES.has(d.split(":", 1)[0] as string);
/** The stages a failed embedding call gives; a missing key or embeddings turned off give others (`no_provider`, `embedding_disabled`). */
const embedCallsFail = (detail: readonly string[]): boolean => detail.some((d) => d.startsWith("embed_timeout") || (d.startsWith("embed") && d.endsWith(":provider_error")));

export type EmbedCause = "auth" | "quota" | "rate_limited" | "model" | "unreachable" | "provider_failing" | "unknown";
export const EMBED_CAUSES: readonly EmbedCause[] = ["auth", "quota", "rate_limited", "model", "unreachable", "provider_failing", "unknown"];
/** The engine's answer at helper path `/embed-check` (services/gbrain/embed-cause.ts EmbedCheck), labels only. */
export type EmbedCheck = { result: "ok" | "not_ready" } | { result: "failed"; cause: EmbedCause; status: number | null };

export function readEmbedCheck(raw: unknown): EmbedCheck | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (o?.result === "ok" || o?.result === "not_ready") return { result: o.result };
  if (o?.result !== "failed" || !EMBED_CAUSES.includes(o.cause as EmbedCause)) return null;
  return { result: "failed", cause: o.cause as EmbedCause, status: typeof o.status === "number" ? o.status : null };
}

/** C296: background provisioning retry while an area lacks its engine source (the engine service may start after Knowledge). */
export const PROVISION_RETRY_MS = 5_000;
export const PROVISION_RETRY_MAX_MS = 5 * 60_000;
/** Retries after which an engine that still cannot create its sources is reported to the owner (5+10+20+40 s ≈ 75 s). */
export const PROVISION_UNREACHABLE_AFTER = 4;
/** C296 review: attention code when the engine companion does not answer, so its sources cannot be created. */
export const ENGINE_UNREACHABLE = "memory_engine_unreachable";
/** Attention code of an engine that runs part of its pipeline only. */
export const DEGRADED = "memory_engine_degraded";
/**
 * QA-KN24-3: after keys or model roles change, tb-exec restarts the engine (a minute or more). The check made at the change
 * still reaches the OLD engine, so ask the helper again after these delays (30 s, 90 s, 3 min) until its answer differs.
 */
export const MODELS_RECHECK_MS: readonly number[] = [30_000, 90_000, 180_000];
/** C373 (spec MODEL_ROLE_ATTENTION): an optional model role is not set (or cannot be used), so Knowledge runs with less. */
export const MODEL_ROLE_OPTIONAL = "model_role_optional";
/** C373: the embeddings binding differs from the model the memory index was built with; the index keeps its model. */
export const EMBEDDINGS_CHANGED = "embeddings_changed";

/**
 * C373: which models the memory engine runs with, as its boot wrapper reports them (services/gbrain/models.ts ModelStatus,
 * through the helper path `/models`). Labels only: GBrain `provider:model` strings and sizes, never a key or an address.
 */
export interface EngineModels {
  embeddings: { state: string; source: "role" | "legacy" | null; active: { model: string; dims: number | null } | null; wanted: { model: string; dims: number | null } | null; addressIgnored?: true };
  reasoning: { state: string; source: "role" | "legacy" | null; model: string | null; addressIgnored?: true };
}

const label = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,160}$/u.test(v) && !v.includes("//") ? v : null);
const sized = (v: unknown): { model: string; dims: number | null } | null => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const model = label(o?.model);
  return model ? { model, dims: typeof o?.dims === "number" && Number.isInteger(o.dims) && o.dims > 0 ? o.dims : null } : null;
};
const sourceOf = (v: unknown) => (v === "role" || v === "legacy" ? v : null);

/** Reads the helper answer strictly (anything unexpected → null = unknown); only closed labels pass. */
export function readEngineModels(raw: unknown): EngineModels | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const e = o?.embeddings && typeof o.embeddings === "object" ? (o.embeddings as Record<string, unknown>) : null;
  const r = o?.reasoning && typeof o.reasoning === "object" ? (o.reasoning as Record<string, unknown>) : null;
  const EMB = ["ok", "unset", "changed", "enabled", "unsupported", "dims_missing", "failed", "unreadable"];
  const RSN = ["ok", "unset", "unsupported", "conflict"];
  if (o?.v !== 1 || !e || !r || !EMB.includes(String(e.state)) || !RSN.includes(String(r.state))) return null;
  return {
    embeddings: { state: String(e.state), source: sourceOf(e.source), active: sized(e.active), wanted: sized(e.wanted), ...(e.addressIgnored === true ? { addressIgnored: true as const } : {}) },
    reasoning: { state: String(r.state), source: sourceOf(r.source), model: label(r.model), ...(r.addressIgnored === true ? { addressIgnored: true as const } : {}) },
  };
}
export type RoleState = "bound" | "not_bound" | "degraded" | "unknown";

/** C373: one row of the Settings page per model role, in plain words (no key, no address). */
export interface RoleRow {
  role: "embeddings" | "reasoning";
  label: string;
  state: RoleState;
  /** the GBrain `provider:model` label the role runs with, when bound */
  model: string | null;
  /** plain-words sentence for the owner; null when nothing needs saying */
  notice: string | null;
}

/** QA-KN24-7: shown when a base URL is bound for a provider whose address the memory engine does not let anyone change. */
const FIXED_ADDRESS = "This provider uses its fixed address, so the base URL you set is not used.";

/** C373: the two model roles as the owner reads them: bound / not bound / degraded (+ a notice), or unknown while the engine has not answered. */
export function roleRows(m: EngineModels | null): RoleRow[] {
  if (!m) {
    const none = "The memory engine has not reported its models yet.";
    return [
      { role: "embeddings", label: "Embeddings (search by meaning)", state: "unknown", model: null, notice: none },
      { role: "reasoning", label: "Reasoning (ask and explain)", state: "unknown", model: null, notice: none },
    ];
  }
  const e = m.embeddings;
  const via = (src: "role" | "legacy" | null) => (src === "legacy" ? " It comes from the older provider keys." : "");
  const emb: RoleRow = { role: "embeddings", label: "Embeddings (search by meaning)", state: "bound", model: e.active?.model ?? e.wanted?.model ?? null, notice: null };
  switch (e.state) {
    case "ok":
      emb.notice = via(e.source).trim() || null;
      break;
    case "enabled":
      emb.model = e.wanted?.model ?? emb.model;
      emb.notice = `The memory engine is adding embeddings to the documents it already holds. This runs in the background.${via(e.source)}`;
      break;
    case "changed":
      emb.state = "degraded";
      emb.notice = `The model is now ${e.wanted?.model ?? "another model"}, but the memory index was built with ${e.active?.model ?? "its first model"}. The index keeps its model until it is re-indexed (not automatic yet).`;
      break;
    case "unset":
      Object.assign(emb, { state: "not_bound", model: null, notice: "No embeddings model is set. Search uses keywords only. Set one on the Keys and models page (open it from Portal)." });
      break;
    case "unsupported":
      Object.assign(emb, { state: "degraded", notice: "The memory engine does not support this embeddings provider, so search uses keywords only." });
      break;
    case "dims_missing":
      Object.assign(emb, { state: "degraded", notice: "This embeddings model needs its vector size. Set it on the Keys and models page. Until then search uses keywords only." });
      break;
    case "unreadable":
      Object.assign(emb, { state: "degraded", notice: "The memory engine cannot read its own setup file, so it left embeddings as they were. Ask support to check the engine volume." });
      break;
    default:
      Object.assign(emb, { state: "degraded", notice: "The memory engine refused this embeddings model, so search uses keywords only." });
  }
  if (e.addressIgnored) emb.notice = `${emb.notice ? `${emb.notice} ` : ""}${FIXED_ADDRESS}`;
  const r = m.reasoning;
  const rsn: RoleRow = { role: "reasoning", label: "Reasoning (ask and explain)", state: "bound", model: r.model, notice: r.source === "legacy" ? "It comes from the older provider keys." : null };
  if (r.state === "unset") Object.assign(rsn, { state: "not_bound", model: null, notice: "No reasoning model is set, so ask cannot answer. Memory and search still work." });
  else if (r.state === "unsupported") Object.assign(rsn, { state: "degraded", notice: "The memory engine does not support this reasoning provider, so ask cannot answer." });
  else if (r.state === "conflict") Object.assign(rsn, { state: "degraded", notice: "The reasoning model needs the same provider key as embeddings. Use one provider for both, or the same key." });
  if (r.addressIgnored) rsn.notice = `${rsn.notice ? `${rsn.notice} ` : ""}${FIXED_ADDRESS}`;
  return [emb, rsn];
}

/** C296: attention code when no memory engine runs at all (a setting that is not available, or no engine service). */
export const ENGINE_MISSING = "engine_missing";

export interface KnowledgeOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** projection drain interval; 0 disables the timer (tests drive drains explicitly) */
  drainIntervalMs?: number;
  /** engine probe interval (default ENGINE_PROBE_MS); 0 probes once at start only */
  engineProbeMs?: number;
  /** first quick re-probe after a probe that did not reach the engine (default ENGINE_REPROBE_MS; tests) */
  engineReprobeMs?: number;
  /** longest quick re-probe delay (default ENGINE_REPROBE_MAX_MS; tests) */
  engineReprobeMaxMs?: number;
  /** how long "not up yet" counts as starting (default ENGINE_STARTING_MAX_MS; tests) */
  engineStartingMaxMs?: number;
  /** first background provisioning retry delay (default PROVISION_RETRY_MS, doubles up to PROVISION_RETRY_MAX_MS) */
  provisionRetryMs?: number;
  /** C373: Governance directory refresh interval (default REFRESH_MS, 60 s) */
  directoryRefreshMs?: number;
  /** delays of the model re-checks after keys or roles changed (default MODELS_RECHECK_MS; tests) */
  modelsRecheckMs?: readonly number[];
}

/** SDK C85 background `callApp` (StartContext), as Knowledge uses it for the Governance directory (C373). */
export type StartContextCallApp = (product: string, op: string, input: Json) => Promise<{ status: "ok"; output: unknown } | { status: "held"; holdId: string }>;

export class Knowledge {
  readonly config: KnowledgeConfig;
  private readonly opts: KnowledgeOptions;
  private services: Services | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private provisioning: Promise<void> | null = null;
  private secrets: AppSecrets = memorySecrets();
  private engineHealth: EngineHealth = { state: "unknown", detail: [], at: 0 };
  private statusChanged: (() => void) | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private reprobeTimer: ReturnType<typeof setTimeout> | null = null;
  private reprobeDelay = 0;
  /** first "not up yet" answer of the current start-up (null once the engine answered) */
  private startingSince: number | null = null;
  private pendingRequeue = false;
  private provisionTimer: ReturnType<typeof setTimeout> | null = null;
  private provisionAttempt = 0;
  private provisionAccess: ServiceAccess | null = null;
  /** C373: the models the engine reported last (null: not known yet, e.g. the engine is still starting) */
  private models: EngineModels | null = null;
  private modelCheckSeq = 0;
  private modelsRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  private provisionInFlight = false;
  private provisionLog: ((msg: string, fields: Record<string, string>) => void) | null = null;
  /** KN-EMBED: the last embedding test call while embedding calls fail (null: not asked yet, or they do not fail) */
  private embedCheck: EmbedCheck | null = null;
  private embedCheckAt = 0;
  private embedCheckInFlight = false;
  private stopped = false;
  private stopDirectory: (() => void) | null = null;

  constructor(config: KnowledgeConfig, opts: KnowledgeOptions = {}) {
    this.config = config;
    this.opts = opts;
  }

  /** Services over the SDK database (the same handle for the whole process). */
  /** `secrets` is the SDK app-secret store (every SDK context carries the same one). */
  bind(db: Db, secrets?: AppSecrets): Services {
    if (secrets && secrets !== this.secrets) {
      // First context that carries the SDK secret store: rebuild so engine clients use it.
      this.secrets = secrets;
      this.services = null;
    }
    if (this.services && this.services.db === db) return this.services;
    const now = this.opts.now ?? Date.now;
    const store = new DocumentStore(db, now);
    const areas = new Areas(db, now);
    let engine: GBrainEngine | null = null;
    if (this.config.engine === "gbrain" && this.config.gbrainUrl && this.config.gbrainAdminToken) {
      const client = new GBrainClient({ baseUrl: this.config.gbrainUrl, adminToken: this.config.gbrainAdminToken, store: new SecretClientStore(this.secrets), fetch: this.opts.fetch, now });
      client.onFailure = ({ stage, status, cause }) => this.engineLog?.("memory engine call failed", { stage, ...(status === undefined ? {} : { status }), ...(cause ? { cause } : {}) });
      engine = new GBrainEngine(client, areaSourceId(SHARED_AREA_ID));
    }
    const notebook =
      this.config.research && this.config.notebookUrl && this.config.notebookPassword
        ? new NotebookClient({ baseUrl: this.config.notebookUrl, password: this.config.notebookPassword, fetch: this.opts.fetch })
        : null;
    const projector = engine ? new Projector(db, store, areas, engine, now) : null;
    this.services = { db, store, areas, engine, notebook, projector, config: this.config };
    // C373: a new Governance directory creates its person and team areas; their engine sources follow in the background
    onDirectoryModel(db, (model) => {
      if (ensureDirectoryAreas(areas, model) > 0 && this.services?.db === db) this.retryProvision(this.services);
    });
    const interval = this.opts.drainIntervalMs ?? 30_000;
    if (projector && interval > 0 && !this.timer) {
      this.timer = setInterval(() => void this.services?.projector?.drain().catch(() => undefined), interval);
      this.timer.unref();
    }
    return this.services;
  }

  /** Services already bound (null before the first call or event). */
  current(): Services | null {
    return this.services;
  }

  /** C373: start the Governance directory timer once (src/directory-feed.ts); no `callApp` = no directory (fail closed). */
  watchDirectory(db: Db, callApp: StartContextCallApp | undefined): void {
    if (!callApp || this.stopDirectory || this.stopped) return;
    this.stopDirectory = startDirectoryTimer(db, ((product, op, input) => callApp(product, op, input)) as CallApp, this.opts.directoryRefreshMs);
  }

  stop() {
    this.stopDirectory?.();
    this.stopDirectory = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    if (this.reprobeTimer) clearTimeout(this.reprobeTimer);
    this.reprobeTimer = null;
    if (this.provisionTimer) clearTimeout(this.provisionTimer);
    this.provisionTimer = null;
    if (this.modelsRecheckTimer) clearTimeout(this.modelsRecheckTimer);
    this.modelsRecheckTimer = null;
    this.stopped = true;
  }

  /** QA-KN027-1: the app log for engine-call failures (set in onStart; stage, status and cause code only). */
  engineLog: ((msg: string, fields: Record<string, string | number>) => void) | null = null;

  /** Record what the engine just showed; a change pushes the app status at once (SDK `statusChanged`). */
  noteEngine(next: { state: EngineHealth["state"]; detail: string[] } | null): void {
    if (!next) return;
    const detail = [...new Set(next.detail.filter(isFault))].sort();
    const state = next.state === "degraded" && detail.length === 0 ? "ok" : next.state;
    const changed = state !== this.engineHealth.state || detail.join(",") !== this.engineHealth.detail.join(",");
    this.engineHealth = { state, detail, at: (this.opts.now ?? Date.now)() };
    if (embedCallsFail(detail)) void this.askEmbedCheck();
    else this.embedCheck = null;
    if (changed) this.statusChanged?.();
    if (state === "ok" || state === "degraded") {
      this.reprobeDelay = 0;
      this.startingSince = null;
      if (this.reprobeTimer) clearTimeout(this.reprobeTimer);
      this.reprobeTimer = null;
    } else this.armReprobe();
  }

  engineStatus(): EngineHealth {
    return { ...this.engineHealth, detail: [...this.engineHealth.detail] };
  }

  /**
   * The condition the owner must see (spec 0.1.28 `defineApp({attention})`), or null. The app keeps serving (recall
   * falls back to keyword search), so this is an attention, not a failure.
   */
  attention(): Attention | null {
    // C296: never silent when no engine runs (prod ran engine "hindsight", a "soon" choice, with no engine for days).
    if (this.config.engine !== "gbrain") {
      return {
        code: ENGINE_MISSING,
        reason: `No memory engine runs: the engine setting "${this.config.engine}" is not available yet, so recall is keyword-only. Choose GBrain in Portal, in the app settings.`.slice(0, 200),
      };
    }
    if (!this.config.gbrainUrl || !this.config.gbrainAdminToken) {
      return { code: ENGINE_MISSING, reason: "No memory engine runs: the GBrain service is not deployed with this app, so recall is keyword-only. Redeploy the app from Portal to add it." };
    }
    if (this.provisionAttempt > PROVISION_UNREACHABLE_AFTER) {
      return { code: ENGINE_UNREACHABLE, reason: "A memory area cannot be set up in the memory engine (retried for over a minute), so recall there is keyword-only. Check the GBrain service in your project." };
    }
    // QA-KN24-1: what the engine itself shows (key rejected, failing, starting) comes before the model notices, which only
    // explain a working engine (an embeddings-only install must still read "key rejected" or "engine failing"). A plain
    // "degraded" engine reads as the model notice when one exists (it names the cause); otherwise as degraded.
    const health = this.healthAttention();
    if (health && health.code !== DEGRADED) return health;
    return this.modelAttention() ?? health;
  }

  /** What the last engine answers show, as an owner attention (null: ok or not known yet). */
  private healthAttention(): Attention | null {
    const { state, detail } = this.engineHealth;
    const list = detail.join(", ").slice(0, 80);
    if (state === "degraded") {
      // KN-EMBED: never read a failed embedding call as a bad key by itself: the test call below names the cause.
      if (embedCallsFail(detail)) return this.embedFailureAttention(list);
      const embeddings = detail.some((d) => d.startsWith("embed") || d.startsWith("keyword_only") || d.includes("no_provider") || d.includes("provider_error") || d.includes("no_key"));
      return {
        code: DEGRADED,
        reason: (embeddings
          ? `Memory engine runs without embeddings (${list}): recall is keyword-only. Check the embeddings model on the Keys and models page.`
          : `Memory engine runs degraded (${list}): recall adds keyword search.`).slice(0, 200),
      };
    }
    if (state === "starting") {
      return { code: ENGINE_STARTING, reason: "The memory engine is starting: recall uses keyword search until it answers (checked again within a minute)." };
    }
    if (state === "failing") return { code: "memory_engine_failing", reason: `Memory engine answers fail (${list}): recall uses keyword search only.`.slice(0, 200) };
    return null;
  }

  /** Embedding calls fail: what the owner must do, from the last test call. Same words on the Keys page and in Portal. */
  private embedFailureAttention(list: string): Attention {
    const check = this.embedCheck;
    if (check?.result === "failed" && check.cause !== "unknown") {
      const http = check.status === null ? "no answer" : `HTTP ${check.status}`;
      const model = this.models?.embeddings.active?.model ?? "the embeddings model";
      const role = this.models?.embeddings.source === "role";
      const provider = model.split(":", 1)[0];
      const keyName = provider === "google" ? "Google Gemini API key" : provider === "openai" ? "OpenAI API key" : "API key";
      const where = role ? "the provider key chosen for Embeddings" : `"${keyName}" under App keys`;
      const fixModel = role ? "Check the Embeddings row on the Keys and models page." : "Check that the key has access to it, or set Embeddings on the Keys and models page.";
      const by: Record<Exclude<EmbedCause, "unknown">, [string, string]> = {
        auth: [KEY_REJECTED, `The provider rejected the embeddings key (${http}), so recall is keyword-only. Replace ${where} on the Keys and models page.`],
        quota: [PROVIDER_QUOTA, `The embeddings provider has no quota or credit left on this account (${http}), so recall is keyword-only. Add credit at the provider. The key stays.`],
        rate_limited: [PROVIDER_BUSY, `The embeddings provider is limiting calls (${http}), so recall is keyword-only for now. This clears by itself.`],
        model: [MODEL_REFUSED, `The embeddings provider refuses ${model} (${http}), so recall is keyword-only. ${fixModel}`],
        unreachable: [PROVIDER_UNREACHABLE, `The memory engine gets no answer from the embeddings provider, so recall is keyword-only. Check the provider's address on the Keys and models page and the network.`],
        provider_failing: [PROVIDER_FAILING, `The embeddings provider has a fault (${http}), so recall is keyword-only. This clears when the provider recovers.`],
      };
      const [code, reason] = by[check.cause];
      return { code, reason: reason.slice(0, 200) };
    }
    if (check?.result === "ok") return { code: DEGRADED, reason: `Embedding calls failed in a recall (${list}), but a new test call works. Recall adds keyword search until the next check.`.slice(0, 200) };
    return { code: DEGRADED, reason: `The memory engine’s embedding calls fail (${list}), so recall is keyword-only. The cause is being checked.`.slice(0, 200) };
  }

  /** KN-EMBED: one real embedding call on the engine side, to name why embedding calls fail. An engine that cannot answer yet leaves it unknown. */
  private async askEmbedCheck(): Promise<void> {
    const access = this.provisionAccess;
    const now = (this.opts.now ?? Date.now)();
    if (!access || this.embedCheckInFlight || now - this.embedCheckAt < EMBED_CHECK_MIN_MS) return;
    this.embedCheckInFlight = true;
    this.embedCheckAt = now;
    try {
      const next = readEmbedCheck(await access.callServiceHelper("gbrain", "/embed-check", {} as never));
      if (!next || !embedCallsFail(this.engineHealth.detail)) return;
      const changed = JSON.stringify(next) !== JSON.stringify(this.embedCheck);
      this.embedCheck = next;
      if (changed) this.statusChanged?.();
    } catch {
      this.embedCheckAt = 0; // engine restarting or an old image: ask again at the next look
    } finally {
      this.embedCheckInFlight = false;
    }
  }

  /** One engine probe on the company area (no agent principal): a one-row query, recorded with `noteEngine`. */
  async probeEngine(services: Services): Promise<void> {
    const engine = services.engine;
    const area = services.areas.get(SHARED_AREA_ID);
    // C373: the models the engine runs with (a restart on new keys or roles changes them)
    await this.checkModels().catch(() => undefined);
    if (!engine || !area?.sourceReady) return;
    try {
      const { degraded } = await engine.recall(area.id, area.sourceId, "knowledge engine status check", 1);
      this.noteEngine(degraded.length ? { state: "degraded", detail: degraded } : { state: "ok", detail: [] });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code).slice(0, 64) : "engine_error";
      if (code === "gbrain_starting") {
        // Not up yet (boot supervisor 503, 502, refused/reset connection, timeout): "starting" for up to
        // ENGINE_STARTING_MAX_MS, then failing. The quick re-probe follows it either way.
        const now = (this.opts.now ?? Date.now)();
        this.startingSince ??= now;
        const limit = this.opts.engineStartingMaxMs ?? ENGINE_STARTING_MAX_MS;
        this.noteEngine(now - this.startingSince < limit ? { state: "starting", detail: [] } : { state: "failing", detail: ["gbrain_not_started"] });
      } else this.noteEngine({ state: "failing", detail: [code] });
    }
  }

  /**
   * QA-KN027-1: a probe or recall that did not reach the engine (failing, or still starting) is re-probed soon, doubling
   * from ENGINE_REPROBE_MS (1 s) up to ENGINE_REPROBE_MAX_MS (60 s), until the engine answers (ok/degraded). Before 0.1.28 the next look was
   * the 10 min probe, so one 503 from GBrain's boot supervisor kept "memory engine failing" for up to 10 min.
   */
  private armReprobe(): void {
    if (this.stopped || this.reprobeTimer || !this.services?.engine) return;
    const interval = this.opts.engineProbeMs ?? ENGINE_PROBE_MS;
    if (interval <= 0) return;
    const max = Math.min(this.opts.engineReprobeMaxMs ?? ENGINE_REPROBE_MAX_MS, interval);
    this.reprobeDelay = Math.min(this.reprobeDelay ? this.reprobeDelay * 2 : (this.opts.engineReprobeMs ?? ENGINE_REPROBE_MS), max);
    this.reprobeTimer = setTimeout(() => {
      this.reprobeTimer = null;
      const services = this.services;
      if (!this.stopped && services) void this.probeEngine(services).catch(() => undefined);
    }, this.reprobeDelay);
    this.reprobeTimer.unref();
  }

  /** Probe now and every ENGINE_PROBE_MS; `statusChanged` pushes the app status when the engine state changes. */
  watchEngine(services: Services, statusChanged: (() => void) | null, intervalMs = ENGINE_PROBE_MS): Promise<void> {
    this.statusChanged = statusChanged;
    if (services.engine && intervalMs > 0 && !this.probeTimer) {
      this.probeTimer = setInterval(() => void this.probeEngine(this.services ?? services).catch(() => undefined), intervalMs);
      this.probeTimer.unref();
    }
    return this.probeEngine(services);
  }

  /** After a restore the engine may hold an older or newer state: re-project every live document and re-delete tombstones.
   *  The SDK restores before onStart binds the services, so `restored()` only marks it and onStart runs the requeue. */
  restored(): void {
    const services = this.services;
    if (services?.projector) {
      services.projector.requeueAll();
      this.kick(services);
    } else this.pendingRequeue = true;
  }

  /** The requeue a restore asked for before the services were bound (once). Returns the rows. */
  requeueAfterRestore(services: Services): number {
    if (!this.pendingRequeue || !services.projector) return 0;
    this.pendingRequeue = false;
    return services.projector.requeueAll();
  }

  /** Kick the projection outbox without waiting (called after every document write). */
  kick(services: Services) {
    void services.projector?.drain().catch(() => undefined);
  }

  /** Provision engine resources for areas that lack them (shared by concurrent callers). */
  provision(services: Services, access: ServiceAccess, log?: (msg: string, fields: Record<string, string>) => void): Promise<void> {
    if (!this.provisioning) {
      this.provisioning = services.areas.provisionPending(this.provisioner(services, access), log).finally(() => (this.provisioning = null));
    }
    return this.provisioning;
  }

  /**
   * C296 (prod 2026-10-20): onStart provisions before a new engine companion is reachable, and before this only an agent
   * call retried it, so every projection row failed area_not_ready. While an area lacks its source, retry in the
   * background with backoff; an area that becomes ready re-arms its rows (Areas.provisionPending) and the outbox drains.
   */
  retryProvision(services: Services, access?: ServiceAccess, log?: (msg: string, fields: Record<string, string>) => void): void {
    if (access) this.provisionAccess = access;
    if (log) this.provisionLog = log;
    const current = this.services ?? services;
    const known = this.provisionAccess;
    if (this.stopped || !known || !current.engine || this.provisionTimer) return;
    if (!current.areas.list().some((area) => !area.sourceReady)) {
      const retried = this.provisionAttempt > 0;
      const wasUnreachable = this.provisionAttempt > PROVISION_UNREACHABLE_AFTER;
      this.provisionAttempt = 0;
      // Ready after retries: probe at once so the owner status does not wait for the 10 min probe; clear "unreachable".
      if (wasUnreachable) this.statusChanged?.();
      if (retried) void this.probeEngine(current).catch(() => undefined);
      return;
    }
    const delay = Math.min((this.opts.provisionRetryMs ?? PROVISION_RETRY_MS) * 2 ** this.provisionAttempt, PROVISION_RETRY_MAX_MS);
    this.provisionAttempt++;
    if (this.provisionAttempt === PROVISION_UNREACHABLE_AFTER + 1) this.statusChanged?.();
    this.provisionTimer = setTimeout(() => {
      if (this.stopped) return;
      this.provisionInFlight = true;
      const attempt = this.provisionAttempt;
      // Log the first failure and every 5th, never upstream bodies (Areas logs the error message only).
      const quiet = attempt !== 1 && attempt % 5 !== 0;
      void this.provision(this.services ?? current, known, quiet ? undefined : this.provisionLog ?? undefined)
        .catch(() => undefined)
        .then(() => (this.stopped ? undefined : this.checkModels()))
        .catch(() => undefined)
        .then(() => {
          this.provisionInFlight = false;
          this.provisionTimer = null;
          if (this.stopped) return;
          this.kick(this.services ?? current);
          this.retryProvision(this.services ?? current);
        });
    }, delay);
    this.provisionTimer.unref();
  }

  /**
   * C373: the display name of an app caller that wrote here (documents keep its instance id in `created_by`), so the document
   * page names "Observer", not an id, also after the app is gone. Stored once per caller in kn_state (no migration).
   */
  noteCaller(services: Services, caller: { id: string; name: string; product?: string }): void {
    const label = (caller.name && caller.name !== caller.id ? caller.name : (caller.product ?? "")).slice(0, 80);
    if (!label) return;
    services.db.prepare("INSERT INTO kn_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`caller/${caller.id}`, label);
  }

  /** C373: display names of the app callers among `ids` (agents and people are named by the UI from tb.agents_list / the session). */
  callerNames(services: Services, ids: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    const read = services.db.prepare("SELECT value FROM kn_state WHERE key = ?");
    for (const id of new Set(ids)) {
      if (!id.startsWith("ins_")) continue;
      const row = read.get(`caller/${id}`);
      if (row) out[id] = String(row.value);
    }
    return out;
  }

  /** C373: the models the engine runs with (last helper answer), or null when not known yet. */
  engineModels(): EngineModels | null {
    return this.models ? structuredClone(this.models) : null;
  }

  /**
   * C373: the owner-facing attention for model roles (spec MODEL_ROLE_ATTENTION): an embeddings binding that differs from
   * the index (`embeddings_changed`), or optional roles that are not usable (`model_role_optional`, readiness degraded).
   */
  private modelAttention(): Attention | null {
    const m = this.models;
    if (!m) return null;
    const e = m.embeddings;
    if (e.state === "changed") {
      return {
        code: EMBEDDINGS_CHANGED,
        reason: `The embeddings model changed to ${e.wanted?.model ?? "another model"}. The memory index keeps ${e.active?.model ?? "its model"} until it is re-indexed (not automatic yet).`.slice(0, 200),
      };
    }
    const why: Record<string, string> = {
      unset: "no embeddings model is set",
      unsupported: "the embeddings provider is not supported by the memory engine",
      dims_missing: "the embeddings model needs its vector size on the Keys and models page",
      failed: "the memory engine refused the embeddings model",
      unreadable: "the memory engine cannot read its setup file",
    };
    const embeddings = why[e.state];
    const reasoning = m.reasoning.state === "ok" ? null : m.reasoning.state === "conflict" ? "the reasoning model needs the same provider key as embeddings" : "no reasoning model is set, so ask cannot answer";
    if (embeddings) {
      return {
        code: MODEL_ROLE_OPTIONAL,
        reason: `Recall is keyword-only: ${embeddings}.${reasoning ? ` Also ${reasoning}.` : ""} Set models on the Keys and models page (open it from Portal).`.slice(0, 200),
      };
    }
    if (reasoning) return { code: MODEL_ROLE_OPTIONAL, reason: `Memory works, but ${reasoning}. Set a reasoning model on the Keys and models page (open it from Portal).`.slice(0, 200) };
    return null;
  }

  /**
   * C373: asks the engine's helper which models this boot runs with. A helper that cannot answer (engine starting, old
   * image without `/models`) keeps what was known. The status is pushed when the answer changes.
   */
  async checkModels(access?: Pick<ServiceAccess, "callServiceHelper">): Promise<EngineModels | null> {
    const source = access ?? this.provisionAccess;
    if (!source || this.config.engine !== "gbrain" || !this.config.gbrainUrl) return this.models;
    const seq = ++this.modelCheckSeq;
    let next: EngineModels | null;
    try {
      next = readEngineModels(await source.callServiceHelper("gbrain", "/models", {} as never));
    } catch {
      return this.models;
    }
    if (seq !== this.modelCheckSeq || !next) return this.models;
    const before = this.models ? JSON.stringify(this.models) : null;
    this.models = next;
    if (JSON.stringify(next) !== before) this.statusChanged?.();
    return next;
  }

  /** C373: keys or model roles changed (keysRev): the engine restarts with them; ask its helper again and provision at once. */
  async modelsChanged(): Promise<void> {
    this.restartProvisioning();
    // a new key or binding: the last test call says nothing about it
    this.embedCheck = null;
    this.embedCheckAt = 0;
    const before = this.models ? JSON.stringify(this.models) : null;
    await this.checkModels();
    // QA-KN24-3: that answer probably came from the engine that is about to restart; look again until it changes
    // KN-EMBED: a replaced key changes no model label, and its effect shows only in the engine's health: always look again
    this.armModelsRecheck(before, 0);
  }

  /**
   * Probes the engine (health and models) after each delay of the schedule. It ends early only when the models changed and the engine
   * is ok: a replaced key changes no label, and the first look may still reach the engine that is about to restart.
   */
  private armModelsRecheck(before: string | null, step: number): void {
    if (this.modelsRecheckTimer) clearTimeout(this.modelsRecheckTimer);
    this.modelsRecheckTimer = null;
    const schedule = this.opts.modelsRecheckMs ?? MODELS_RECHECK_MS;
    const delay = schedule[step];
    if (this.stopped || delay === undefined) return;
    this.modelsRecheckTimer = setTimeout(() => {
      this.modelsRecheckTimer = null;
      if (this.stopped) return;
      const services = this.services;
      void (services ? this.probeEngine(services) : this.checkModels())
        .catch(() => undefined)
        .then(() => {
          if ((this.models ? JSON.stringify(this.models) : null) !== before && this.engineHealth.state === "ok") return;
          this.armModelsRecheck(before, step + 1);
        });
    }, delay);
    this.modelsRecheckTimer.unref();
  }

  /** C296 INFO-2: start the background provisioning over (counter reset, next try soon), e.g. once the engine's key arrived. */
  private restartProvisioning(): void {
    this.provisionAttempt = 0;
    if (this.provisionInFlight || !this.provisionTimer || !this.services) return; // a running try reschedules from attempt 0
    clearTimeout(this.provisionTimer);
    this.provisionTimer = null;
    this.retryProvision(this.services);
  }

  /** True while a background provisioning retry is scheduled or running. */
  provisionRetrying(): boolean {
    return this.provisionTimer !== null;
  }

  private provisioner(services: Services, access: ServiceAccess): AreaProvisioner {
    const provisioner: AreaProvisioner = {};
    if (services.engine) {
      // C6: the GBrain companion image carries a helper that runs upstream's trusted `gbrain sources add`.
      provisioner.createSource = async (sourceId, label) => {
        await access.callServiceHelper("gbrain", "/sources", GBrainEngine.sourceRequest(sourceId, label) as never);
      };
    }
    if (services.notebook) {
      const notebook = services.notebook;
      provisioner.ensureNotebook = (areaId, label) => notebook.ensureNotebook(`knowledge-${areaId}`, label);
    }
    return provisioner;
  }

  /** Research chat model in Open Notebook, provisioned once from the bridge-held keys (C2). */
  async researchModel(services: Services, access: ServiceAccess): Promise<string> {
    const cached = services.db.prepare("SELECT value FROM kn_state WHERE key = 'notebook_model'").get();
    if (cached) return String(cached.value);
    if (!services.notebook) throw new Error("research disabled");
    const provider = this.config.modelProvider;
    const models = PROVIDER_MODELS[provider];
    const apiKey = await access.getKey(PROVIDER_KEY[provider]);
    const embeddingApiKey = await access.getKey(PROVIDER_KEY[models.embeddingProvider]);
    if (!apiKey || !embeddingApiKey) throw Object.assign(new Error("model keys are missing"), { code: "key_missing" });
    const modelId = await services.notebook.provisionModels({
      provider,
      apiKey,
      chatModel: models.chatModel,
      embeddingProvider: models.embeddingProvider,
      embeddingApiKey,
      embeddingModel: models.embeddingModel,
    });
    services.db.prepare("INSERT INTO kn_state (key, value) VALUES ('notebook_model', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(modelId);
    return modelId;
  }

  /** After a key change the research engine must be re-provisioned with the new value. */
  forgetResearchModel(services: Services) {
    services.db.prepare("DELETE FROM kn_state WHERE key = 'notebook_model'").run();
  }
}

/** The SDK's app-secret name rule (miniapp-sdk app-secrets: 1..128 chars of [A-Za-z0-9._:/-]). */
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

/** Fallback before the SDK hands over its secret store (tests); enforces the SDK name rule so tests catch bad names. */
export function memorySecrets(): AppSecrets {
  const values = new Map<string, string>();
  const check = (name: string) => {
    if (!SECRET_NAME.test(name)) throw Object.assign(new Error("secret name must be 1..128 chars of [A-Za-z0-9._:/-]"), { code: "secret_name_invalid" });
  };
  return {
    put: async (name, value) => {
      check(name);
      values.set(name, value);
    },
    get: async (name) => {
      check(name);
      return values.get(name) ?? null;
    },
    delete: async (name) => {
      check(name);
      values.delete(name);
    },
  };
}
