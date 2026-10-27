// Wiring of Knowledge's domain services onto the SDK-provided database and context.
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { type AreaProvisioner, Areas } from "./areas.ts";
import { type KnowledgeConfig, PROVIDER_KEY, PROVIDER_MODELS } from "./config.ts";
import { type ClientStore, GBrainClient, type StoredClient } from "./engines/gbrain/client.ts";
import { GBrainEngine } from "./engines/gbrain/engine.ts";
import { NotebookClient } from "./engines/notebook/client.ts";
import { areaSourceId, SHARED_AREA_ID } from "./ids.ts";
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
  state: "unknown" | "ok" | "degraded" | "failing";
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
/** QA R-2: attention code when the provider refuses the engine's embedding calls (the key is set but rejected). */
export const KEY_REJECTED = "memory_engine_key_rejected";
/** C296: background provisioning retry while an area lacks its engine source (the engine service may start after Knowledge). */
export const PROVISION_RETRY_MS = 5_000;
export const PROVISION_RETRY_MAX_MS = 5 * 60_000;
/** Retries after which an engine that still cannot create its sources is reported to the owner (5+10+20+40 s ≈ 75 s). */
export const PROVISION_UNREACHABLE_AFTER = 4;
/** C296 review: attention code when the engine companion does not answer, so its sources cannot be created. */
export const ENGINE_UNREACHABLE = "memory_engine_unreachable";
/** C373 (spec MODEL_ROLE_ATTENTION): an optional model role is not set (or cannot be used), so Knowledge runs with less. */
export const MODEL_ROLE_OPTIONAL = "model_role_optional";
/** C373: the embeddings binding differs from the model the memory index was built with; the index keeps its model. */
export const EMBEDDINGS_CHANGED = "embeddings_changed";

/**
 * C373: which models the memory engine runs with, as its boot wrapper reports them (services/gbrain/models.ts ModelStatus,
 * through the helper path `/models`). Labels only: GBrain `provider:model` strings and sizes, never a key or an address.
 */
export interface EngineModels {
  embeddings: { state: string; source: "role" | "legacy" | null; active: { model: string; dims: number | null } | null; wanted: { model: string; dims: number | null } | null };
  reasoning: { state: string; source: "role" | "legacy" | null; model: string | null };
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
  const EMB = ["ok", "unset", "changed", "enabled", "unsupported", "dims_missing", "failed"];
  const RSN = ["ok", "unset", "unsupported", "conflict"];
  if (o?.v !== 1 || !e || !r || !EMB.includes(String(e.state)) || !RSN.includes(String(r.state))) return null;
  return {
    embeddings: { state: String(e.state), source: sourceOf(e.source), active: sized(e.active), wanted: sized(e.wanted) },
    reasoning: { state: String(r.state), source: sourceOf(r.source), model: label(r.model) },
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
    default:
      Object.assign(emb, { state: "degraded", notice: "The memory engine refused this embeddings model, so search uses keywords only." });
  }
  const r = m.reasoning;
  const rsn: RoleRow = { role: "reasoning", label: "Reasoning (ask and explain)", state: "bound", model: r.model, notice: r.source === "legacy" ? "It comes from the older provider keys." : null };
  if (r.state === "unset") Object.assign(rsn, { state: "not_bound", model: null, notice: "No reasoning model is set, so ask cannot answer. Memory and search still work." });
  else if (r.state === "unsupported") Object.assign(rsn, { state: "degraded", notice: "The memory engine does not support this reasoning provider, so ask cannot answer." });
  else if (r.state === "conflict") Object.assign(rsn, { state: "degraded", notice: "The reasoning model needs the same provider key as embeddings. Use one provider for both, or the same key." });
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
  /** first background provisioning retry delay (default PROVISION_RETRY_MS, doubles up to PROVISION_RETRY_MAX_MS) */
  provisionRetryMs?: number;
}

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
  private pendingRequeue = false;
  private provisionTimer: ReturnType<typeof setTimeout> | null = null;
  private provisionAttempt = 0;
  private provisionAccess: ServiceAccess | null = null;
  /** C373: the models the engine reported last (null: not known yet, e.g. the engine is still starting) */
  private models: EngineModels | null = null;
  private modelCheckSeq = 0;
  private provisionInFlight = false;
  private provisionLog: ((msg: string, fields: Record<string, string>) => void) | null = null;
  private stopped = false;

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

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    if (this.provisionTimer) clearTimeout(this.provisionTimer);
    this.provisionTimer = null;
    this.stopped = true;
  }

  /** QA-KN027-1: the app log for engine-call failures (set in onStart; stage, status and cause code only). */
  engineLog: ((msg: string, fields: Record<string, string | number>) => void) | null = null;

  /** Record what the engine just showed; a change pushes the app status at once (SDK `statusChanged`). */
  noteEngine(next: { state: EngineHealth["state"]; detail: string[] } | null): void {
    if (!next) return;
    const detail = [...new Set(next.detail)].sort();
    const changed = next.state !== this.engineHealth.state || detail.join(",") !== this.engineHealth.detail.join(",");
    this.engineHealth = { state: next.state, detail, at: (this.opts.now ?? Date.now)() };
    if (changed) this.statusChanged?.();
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
    const models = this.modelAttention();
    if (models) return models;
    const { state, detail } = this.engineHealth;
    const list = detail.join(", ").slice(0, 80);
    if (state === "degraded") {
      // QA R-2: the key is set but the provider refuses the embedding calls (qa1: a 401 surfaces as provider_error, the
      // engine's closed vocabulary has no finer code). The Keys page reads this same attention, so both screens agree.
      if (detail.some((d) => d.startsWith("embed") && d.endsWith(":provider_error"))) {
        return {
          code: KEY_REJECTED,
          reason: `Key rejected by the provider: the memory engine’s embedding calls fail (${list}), so recall is keyword-only. Enter a valid key on the Keys and models page.`.slice(0, 200),
        };
      }
      const embeddings = detail.some((d) => d.startsWith("embed") || d.startsWith("keyword_only") || d.includes("no_provider") || d.includes("provider_error") || d.includes("no_key"));
      return {
        code: "memory_engine_degraded",
        reason: (embeddings
          ? `Memory engine runs without embeddings (${list}): recall is keyword-only. Check the embeddings model on the Keys and models page.`
          : `Memory engine runs degraded (${list}): recall adds keyword search.`).slice(0, 200),
      };
    }
    if (state === "failing") return { code: "memory_engine_failing", reason: `Memory engine answers fail (${list}): recall uses keyword search only.`.slice(0, 200) };
    return null;
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
      this.noteEngine({ state: "failing", detail: [code] });
    }
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
    await this.checkModels();
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
