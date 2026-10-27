// Wiring of Knowledge's domain services onto the SDK-provided database and context.
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { type AreaProvisioner, Areas } from "./areas.ts";
import { type KnowledgeConfig, PROVIDER_KEY, PROVIDER_MODELS } from "./config.ts";
import { DeepClient, type DeepHealth } from "./engines/deep/client.ts";
import { DeepSync } from "./engines/deep/sync.ts";
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
  /** C336 F4: deep knowledge companion client (null when the setting is off or the service is not wired) */
  deep: DeepClient | null;
  /** C373: the feed of Knowledge documents into the deep service (null when deep is off) */
  deepSync: DeepSync | null;
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
/** C296 QA INFO-2: attention code while the memory engine waits for its provider key (tb-exec holds GBrain until it is set). */
export const ENGINE_KEY_MISSING = "memory_engine_key_missing";
/** C296: attention code when no memory engine runs at all (a setting that is not available, or no engine service). */
export const ENGINE_MISSING = "engine_missing";
/** C336 F4: deep knowledge is on but its service is not wired, or its proxy does not answer healthy */
export const DEEP_MISSING = "deep_missing";
export const DEEP_UNREACHABLE = "deep_unreachable";
export const DEEP_RETRY_MS = 60_000;
/** C373: how often the deep feed looks for document changes it was not kicked for (writes kick it at once) */
export const DEEP_SYNC_MS = 60_000;

export interface KnowledgeOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** projection drain interval; 0 disables the timer (tests drive drains explicitly) */
  drainIntervalMs?: number;
  /** engine probe interval (default ENGINE_PROBE_MS); 0 probes once at start only */
  engineProbeMs?: number;
  /** first background provisioning retry delay (default PROVISION_RETRY_MS, doubles up to PROVISION_RETRY_MAX_MS) */
  provisionRetryMs?: number;
  /** C373: deep feed interval (default DEEP_SYNC_MS); 0 syncs once at start only */
  deepSyncMs?: number;
}

export class Knowledge {
  readonly config: KnowledgeConfig;
  private readonly opts: KnowledgeOptions;
  private services: Services | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private provisioning: Promise<void> | null = null;
  private secrets: AppSecrets = memorySecrets();
  private engineHealth: EngineHealth = { state: "unknown", detail: [], at: 0 };
  /** C336 F4: last deep knowledge probe (null = not probed yet) */
  private deepHealth: DeepHealth | null = null;
  private deepRetry: ReturnType<typeof setTimeout> | null = null;
  private deepTimer: ReturnType<typeof setInterval> | null = null;
  private deepKick: ReturnType<typeof setTimeout> | null = null;
  private statusChanged: (() => void) | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRequeue = false;
  private provisionTimer: ReturnType<typeof setTimeout> | null = null;
  private provisionAttempt = 0;
  private provisionAccess: ServiceAccess | null = null;
  /** C296 INFO-2: provider keys the engine needs that the bridge reports unset (last check) */
  private missingKeys: string[] = [];
  private keyCheckSeq = 0;
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
      engine = new GBrainEngine(client, areaSourceId(SHARED_AREA_ID));
    }
    const notebook =
      this.config.research && this.config.notebookUrl && this.config.notebookPassword
        ? new NotebookClient({ baseUrl: this.config.notebookUrl, password: this.config.notebookPassword, fetch: this.opts.fetch })
        : null;
    const projector = engine ? new Projector(db, store, areas, engine, now) : null;
    const deep = this.config.deep && this.config.deepUrl && this.config.deepToken ? new DeepClient({ baseUrl: this.config.deepUrl, token: this.config.deepToken, fetch: this.opts.fetch }) : null;
    const deepSync = deep ? new DeepSync(db, areas, deep, now) : null;
    this.services = { db, store, areas, engine, notebook, projector, deep, deepSync, config: this.config };
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
    if (this.deepRetry) clearTimeout(this.deepRetry);
    this.deepRetry = null;
    if (this.deepTimer) clearInterval(this.deepTimer);
    this.deepTimer = null;
    if (this.deepKick) clearTimeout(this.deepKick);
    this.deepKick = null;
    this.stopped = true;
  }

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
    // C296 INFO-2: the engine cannot start without its provider key: name it (more precise than "unreachable").
    if (this.missingKeys.length) {
      const keys = this.missingKeys.join(", ");
      return {
        code: ENGINE_KEY_MISSING,
        reason: `The memory engine waits for ${keys}, so recall is keyword-only. Enter ${this.missingKeys.length > 1 ? "them" : "it"} on the bridge key page (open it from Portal); the engine then starts by itself.`.slice(0, 200),
      };
    }
    if (this.provisionAttempt > PROVISION_UNREACHABLE_AFTER) {
      return { code: ENGINE_UNREACHABLE, reason: "A memory area cannot be set up in the memory engine (retried for over a minute), so recall there is keyword-only. Check the GBrain service in your project." };
    }
    const { state, detail } = this.engineHealth;
    const list = detail.join(", ").slice(0, 80);
    if (state === "degraded") {
      // QA R-2: the key is set but the provider refuses the embedding calls (qa1: a 401 surfaces as provider_error, the
      // engine's closed vocabulary has no finer code). The Keys page reads this same attention, so both screens agree.
      if (detail.some((d) => d.startsWith("embed") && d.endsWith(":provider_error"))) {
        return {
          code: KEY_REJECTED,
          reason: `Key rejected by the provider: the memory engine’s embedding calls fail (${list}), so recall is keyword-only. Enter a valid model key on the bridge key page.`.slice(0, 200),
        };
      }
      const embeddings = detail.some((d) => d.startsWith("embed") || d.startsWith("keyword_only") || d.includes("no_provider") || d.includes("provider_error") || d.includes("no_key"));
      return {
        code: "memory_engine_degraded",
        reason: (embeddings
          ? `Memory engine runs without embeddings (${list}): recall is keyword-only. Check the engine's embedding provider key.`
          : `Memory engine runs degraded (${list}): recall adds keyword search.`).slice(0, 200),
      };
    }
    if (state === "failing") return { code: "memory_engine_failing", reason: `Memory engine answers fail (${list}): recall uses keyword search only.`.slice(0, 200) };
    return this.deepAttention();
  }

  /** C336 F4: deep knowledge after the memory engine (memory is the core; a data service fault never hides an engine fault). */
  private deepAttention(): Attention | null {
    if (!this.config.deep) return null;
    if (!this.config.deepUrl || !this.config.deepToken) return { code: DEEP_MISSING, reason: "Deep knowledge is on but its data service is not deployed with this app. Redeploy the app from Portal to add it." };
    if (this.deepHealth && !this.deepHealth.ok) {
      return { code: DEEP_UNREACHABLE, reason: `The deep knowledge service does not answer healthy (${this.deepHealth.status}${this.deepHealth.phase ? `: ${this.deepHealth.phase}` : ""}). Check the deep service in your project.`.slice(0, 200) };
    }
    return null;
  }

  /** One deep knowledge probe (the proxy's /health); pushes the status when the result changes. */
  async probeDeep(services: Services): Promise<void> {
    if (!services.deep) return;
    const next = await services.deep.health();
    const changed = !this.deepHealth || this.deepHealth.ok !== next.ok || this.deepHealth.status !== next.status;
    this.deepHealth = next;
    if (changed) this.statusChanged?.();
    // the service needs minutes to start (HelixDB, executor, API): look again in a minute, not only at the 10 min probe
    if (!next.ok && !this.stopped && !this.deepRetry && (this.opts.engineProbeMs ?? ENGINE_PROBE_MS) > 0) {
      this.deepRetry = setTimeout(() => {
        this.deepRetry = null;
        void this.probeDeep(this.services ?? services).catch(() => undefined);
      }, DEEP_RETRY_MS);
      this.deepRetry.unref();
    }
  }

  /** One engine probe on the company area (no agent principal): a one-row query, recorded with `noteEngine`. */
  async probeEngine(services: Services): Promise<void> {
    const engine = services.engine;
    const area = services.areas.get(SHARED_AREA_ID);
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
    if ((services.engine || services.deep) && intervalMs > 0 && !this.probeTimer) {
      this.probeTimer = setInterval(() => {
        void this.probeEngine(this.services ?? services).catch(() => undefined);
        void this.probeDeep(this.services ?? services).catch(() => undefined);
      }, intervalMs);
      this.probeTimer.unref();
    }
    return Promise.all([this.probeEngine(services), this.probeDeep(services)]).then(() => undefined);
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
    this.kickDeep(services);
  }

  /** C373: a document write reaches the deep service a moment later (writes in a burst share one pass). */
  kickDeep(services: Services, delayMs = 2000) {
    if (!services.deepSync || this.stopped || this.deepKick) return;
    this.deepKick = setTimeout(() => {
      this.deepKick = null;
      void services.deepSync?.run().catch(() => undefined);
    }, delayMs);
    this.deepKick.unref();
  }

  /** C373: sync the deep feed now and every `intervalMs` (onStart). */
  watchDeep(services: Services, intervalMs = DEEP_SYNC_MS): Promise<unknown> {
    if (!services.deepSync) return Promise.resolve();
    if (intervalMs > 0 && !this.deepTimer) {
      this.deepTimer = setInterval(() => void (this.services ?? services).deepSync?.run().catch(() => undefined), intervalMs);
      this.deepTimer.unref();
    }
    return services.deepSync.run();
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
        .then(() => (this.stopped ? undefined : this.checkProviderKeys()))
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
   * C296 INFO-2: which provider keys of the configured model provider the bridge reports unset (getKey → null). A key the
   * bridge cannot answer for right now is not counted (unknown is not "missing"). The status is pushed when the set changes.
   */
  async checkProviderKeys(access?: Pick<ServiceAccess, "getKey">): Promise<string[]> {
    const source = access ?? this.provisionAccess;
    if (!source || this.config.engine !== "gbrain") return this.missingKeys;
    const seq = ++this.keyCheckSeq;
    const missing: string[] = [];
    for (const name of PROVIDER_MODELS[this.config.modelProvider].keys) {
      try {
        if ((await source.getKey(name)) === null) missing.push(name);
      } catch {
        // the bridge cannot answer right now (paused, updating): keep what was known for this key (review)
        if (this.missingKeys.includes(name)) missing.push(name);
      }
    }
    if (seq !== this.keyCheckSeq) return this.missingKeys; // a newer check started meanwhile: it decides (review)
    missing.sort();
    if (missing.join(",") !== this.missingKeys.join(",")) {
      const keysArrived = this.missingKeys.length > 0 && missing.length === 0;
      this.missingKeys = missing;
      this.statusChanged?.();
      // The engine starts now (tb-exec had held it): provision again at once, not after the long backoff, so the owner never
      // reads "cannot be set up" for minutes after entering the key (review).
      if (keysArrived) this.restartProvisioning();
    }
    return missing;
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
