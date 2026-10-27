// C69: killed-migration simulation against a real Postgres with the real boot supervisor (services/gbrain/boot.ts) and
// a lease-faithful upstream double (test/fixtures/gbrain/src/cli.ts). Needs initdb/pg_ctl on PATH (a workstation);
// skipped elsewhere (the CI node image has no Postgres; the decision logic is covered in gbrain-boot.test.ts).
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BOOT = join(REPO, "services/gbrain/boot.ts");
const FAKE_ROOT = join(REPO, "test/fixtures/gbrain");
const hasPg = spawnSync("initdb", ["--version"]).status === 0 && spawnSync("pg_ctl", ["--version"]).status === 0;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function health(port: number): Promise<{ code: number; body: Record<string, any> } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return { code: r.status, body: (await r.json()) as Record<string, any> };
  } catch {
    return null;
  }
}

interface Proc {
  child: ChildProcess;
  port: number;
  exited: Promise<number>;
  events: () => { event: string; [k: string]: unknown }[];
}

describe("GBrain boot on a real Postgres: killed migrations recover", { skip: hasPg ? false : "no initdb/pg_ctl on PATH", timeout: 120_000 }, () => {
  let dir = "";
  let pgPort = 0;
  let sql: ReturnType<typeof postgres>;
  let record = "";
  let home = "";
  const procs: ChildProcess[] = [];

  const baseEnv = (): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    GBRAIN_ROOT: FAKE_ROOT,
    GBRAIN_HOME: home,
    KNOWLEDGE_GBRAIN_LAUNCHER: process.execPath,
    GBRAIN_BIND: "127.0.0.1",
    GBRAIN_DB_HOST: "127.0.0.1",
    GBRAIN_DB_PORT: String(pgPort),
    GBRAIN_DB_USER: "postgres",
    GBRAIN_DB_PASSWORD: "test-only",
    GBRAIN_DB_NAME: "gbrain",
    FAKE_GBRAIN_RECORD: record,
  });

  /** a detached process group, like a container: SIGKILL of the group kills the runner too */
  function launch(args: string[], env: Record<string, string>): { child: ChildProcess; exited: Promise<number>; lines: string[] } {
    const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    procs.push(child);
    const lines: string[] = [];
    let buf = "";
    child.stderr?.on("data", (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      lines.push(...parts);
      if (process.env.C69_DEBUG) for (const l of parts) process.stderr.write(`[child ${child.pid}] ${l}\n`);
    });
    const exited = new Promise<number>((r) => child.once("exit", (code, sig) => r(code ?? (sig === "SIGKILL" ? 137 : 143))));
    return { child, exited, lines };
  }

  async function boot(extra: Record<string, string> = {}): Promise<Proc> {
    const port = await freePort();
    const p = launch([BOOT], { ...baseEnv(), PORT: String(port), ...extra });
    const events = () =>
      p.lines.flatMap((l) => {
        try {
          const o = JSON.parse(l);
          return o?.component === "gbrain-boot" ? [o] : [];
        } catch {
          return [];
        }
      });
    return { child: p.child, port, exited: p.exited, events };
  }

  const upstream = (extra: Record<string, string> = {}) => launch([join(FAKE_ROOT, "src/cli.ts"), "apply-migrations"], { ...baseEnv(), ...extra });
  const recorded = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean) : []);
  const leaseRow = async () => (await sql`SELECT holder_host, holder_pid FROM gbrain_cycle_locks WHERE id = 'gbrain-apply-migrations'`)[0] ?? null;
  const killGroup = (c: ChildProcess) => {
    try {
      if (c.pid) process.kill(-c.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "kn-c69-"));
    pgPort = await freePort();
    const init = spawnSync("initdb", ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8", "--no-locale"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    assert.equal(init.status, 0, init.stderr);
    const start = spawnSync("pg_ctl", ["-D", join(dir, "data"), "-l", join(dir, "pg.log"), "-w", "-o", `-p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "start"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    assert.equal(start.status, 0, start.stderr);
    const admin = postgres({ host: "127.0.0.1", port: pgPort, user: "postgres", database: "postgres", max: 1, onnotice: () => {} });
    await admin`CREATE DATABASE gbrain`;
    await admin.end();
    sql = postgres({ host: "127.0.0.1", port: pgPort, user: "postgres", database: "gbrain", max: 1, onnotice: () => {} });
    // Upstream lease table (gbrain 99de5707 src/schema.sql + migration v98 + acquisition_token).
    await sql`CREATE TABLE gbrain_cycle_locks (
      id TEXT PRIMARY KEY, holder_pid INT NOT NULL, holder_host TEXT, acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ttl_expires_at TIMESTAMPTZ NOT NULL, last_refreshed_at TIMESTAMPTZ, acquisition_token UUID NOT NULL DEFAULT gen_random_uuid())`;
  });

  after(async () => {
    for (const c of procs) killGroup(c);
    await sql?.end({ timeout: 1 }).catch(() => {});
    if (dir) {
      spawnSync("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"], { env: { ...process.env, LC_ALL: "C", LANG: "C" } });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  let n = 0;
  beforeEach(async () => {
    await sql`DELETE FROM gbrain_cycle_locks`;
    n++;
    record = join(dir, `record-${n}.txt`);
    home = join(dir, `home-${n}`);
    mkdirSync(join(home, ".gbrain"), { recursive: true });
    writeFileSync(join(home, ".gbrain", "config.json"), "{}");
  });

  test("qa1 replay: lease of a container killed mid-migration (other host, pid 21) → upstream alone exits 75; boot takes over and serves", async () => {
    await sql`INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
              VALUES ('gbrain-apply-migrations', 21, 'ffdcf33f76ab', NOW() - '10 minutes'::interval, NOW() + '50 minutes'::interval, NOW() - '10 minutes'::interval)`;
    const plain = upstream();
    assert.equal(await plain.exited, 75, "the 0.1.7 behaviour: refused, crash loop");

    const b = await boot(); // production defaults: 240 s wait, 180 s staleness
    const ok = await waitFor("GBrain serving", async () => {
      const h = await health(b.port);
      return h?.code === 200 ? h : null;
    });
    assert.equal(ok.body.status, "ok");
    const takeover = b.events().find((e) => e.event === "migration_lock_takeover");
    assert.equal(takeover?.reason, "refresh_stale");
    assert.equal(takeover?.holderHost, "ffdcf33f76ab");
    assert.equal(takeover?.holderPid, 21);
    assert.deepEqual(recorded().map((l) => l.split(" ")[0]), ["start", "end"]);
    assert.equal(await leaseRow(), null);
    b.child.kill("SIGTERM");
    assert.equal(await b.exited, 0, "SIGTERM reaches gbrain serve, which exits 0");
  });

  test("container SIGKILLed mid-migration (boot + runner) → its lease stays → the next boot on the same host recovers at once", async () => {
    const first = await boot({ FAKE_GBRAIN_WORK_MS: "60000" });
    await waitFor("migration started", () => recorded().some((l) => l.startsWith("start")));
    killGroup(first.child);
    await first.exited;
    const left = await waitFor("lease left behind", leaseRow);
    assert.equal(left.holder_host, hostname());
    assert.equal(await upstream().exited, 75, "upstream alone stays locked out");

    const second = await boot();
    await waitFor("GBrain serving", async () => (await health(second.port))?.code === 200);
    assert.equal(second.events().find((e) => e.event === "migration_lock_takeover")?.reason, "same_host");
    assert.equal(await leaseRow(), null);
    second.child.kill("SIGTERM");
    await second.exited;
  });

  test("a live holder on another host is never stolen: /health says needs_attention, the process stays up, and recovers when the holder dies", async () => {
    const holder = upstream({ FAKE_GBRAIN_HOST: "live-peer", FAKE_GBRAIN_REFRESH_MS: "100", FAKE_GBRAIN_WORK_MS: "60000" });
    await waitFor("holder running", () => recorded().some((l) => l.startsWith("start")));
    const b = await boot({ KNOWLEDGE_MIGRATION_WAIT_S: "0.5", KNOWLEDGE_MIGRATION_LOCK_STALE_S: "1", KNOWLEDGE_MIGRATION_POLL_S: "0.1", KNOWLEDGE_MIGRATION_RETRY_MIN_S: "0.2", KNOWLEDGE_MIGRATION_RETRY_MAX_S: "0.4" });
    const attention = await waitFor("needs_attention", async () => {
      const h = await health(b.port);
      return h?.body.status === "needs_attention" ? h : null;
    });
    assert.equal(attention.code, 503);
    assert.equal(attention.body.reason, "migration_lock_held");
    assert.equal(attention.body.detail.holderHost, "live-peer");
    assert.equal(b.child.exitCode, null, "no exit, no crash loop");
    assert.equal(recorded().filter((l) => l.startsWith("start")).length, 1, "boot did not run migrations beside the live holder");

    killGroup(holder.child);
    await holder.exited;
    await waitFor("GBrain serving", async () => (await health(b.port))?.code === 200);
    const ev = b.events().map((e) => e.event);
    assert.ok(ev.includes("needs_attention") && ev.includes("migration_lock_takeover") && ev.includes("needs_attention_cleared"), ev.join(","));
    b.child.kill("SIGTERM");
    await b.exited;
  });

  const statusFile = () => join(home, "knowledge-models.json");
  const written = () => JSON.parse(readFileSync(statusFile(), "utf8")) as Record<string, any>;
  const ran = (what: string) => recorded().some((l) => l.startsWith(what));
  const embeddingRole = { KN_EMBEDDINGS_PROVIDER: "openai", KN_EMBEDDINGS_MODEL: "text-embedding-3-small", KN_EMBEDDINGS_KEY: "sk-test-aaaaaaaaaaaa" };

  test("QA-KN24-3: the model status file of the previous boot is removed at start (the helper answers 503 until this boot wrote its own)", async () => {
    writeFileSync(statusFile(), JSON.stringify({ v: 1, stale: true }));
    const holder = upstream({ FAKE_GBRAIN_HOST: "live-peer", FAKE_GBRAIN_REFRESH_MS: "100", FAKE_GBRAIN_WORK_MS: "60000" });
    await waitFor("holder running", () => ran("start"));
    const b = await boot({ KNOWLEDGE_MIGRATION_WAIT_S: "0.5", KNOWLEDGE_MIGRATION_LOCK_STALE_S: "1", KNOWLEDGE_MIGRATION_POLL_S: "0.1", KNOWLEDGE_MIGRATION_RETRY_MIN_S: "0.2", KNOWLEDGE_MIGRATION_RETRY_MAX_S: "0.4" });
    await waitFor("needs_attention", async () => (await health(b.port))?.body.status === "needs_attention");
    assert.equal(existsSync(statusFile()), false, "no old answer while this boot is still starting");
    killGroup(holder.child);
    await holder.exited;
    await waitFor("GBrain serving", async () => (await health(b.port))?.code === 200);
    assert.equal(written().stale, undefined);
    assert.equal(written().v, 1, "this boot wrote its own status");
    b.child.kill("SIGTERM");
    await b.exited;
  });

  test("QA-KN24 residual: a corrupt config.json never crashes the boot: it serves, leaves the brain alone and reports 'unreadable'", async () => {
    writeFileSync(join(home, ".gbrain", "config.json"), "{not json");
    const b = await boot(embeddingRole);
    await waitFor("GBrain serving", async () => (await health(b.port))?.code === 200);
    assert.ok(b.events().some((e) => e.event === "config_unreadable"));
    assert.ok(!ran("init") && !ran("embeddings"), "no init, no enable over a brain we cannot read");
    assert.equal(written().embeddings.state, "unreadable");
    b.child.kill("SIGTERM");
    await b.exited;
  });

  test("QA-KN24 residual: a brain whose config.json names no embedding model is kept as it is (no `embeddings enable`); only an explicit embedding_disabled brain is enabled", async () => {
    writeFileSync(join(home, ".gbrain", "config.json"), JSON.stringify({ engine: "postgres" }));
    const kept = await boot(embeddingRole);
    await waitFor("GBrain serving", async () => (await health(kept.port))?.code === 200);
    assert.ok(!ran("embeddings"), "an embedded brain is never re-enabled");
    assert.equal(written().embeddings.state, "ok");
    kept.child.kill("SIGTERM");
    await kept.exited;

    writeFileSync(join(home, ".gbrain", "config.json"), JSON.stringify({ engine: "postgres", embedding_disabled: true }));
    const enabled = await boot(embeddingRole);
    await waitFor("GBrain serving", async () => (await health(enabled.port))?.code === 200);
    assert.ok(ran("embeddings-enable"), "the deferred-setup brain gets embeddings in place");
    assert.equal(written().embeddings.state, "enabled");
    enabled.child.kill("SIGTERM");
    await enabled.exited;
  });

  test("SIGTERM during migrations reaches the runner (it releases its lease); a runner ignoring it is killed and its lease removed", async () => {
    const polite = await boot({ FAKE_GBRAIN_WORK_MS: "60000" });
    await waitFor("migration started", () => recorded().some((l) => l.startsWith("start")));
    assert.ok(await leaseRow());
    polite.child.kill("SIGTERM");
    assert.equal(await polite.exited, 143);
    assert.equal(await leaseRow(), null);

    record = `${record}.2`;
    const stubborn = await boot({ FAKE_GBRAIN_WORK_MS: "60000", FAKE_GBRAIN_IGNORE_SIGTERM: "1", FAKE_GBRAIN_RECORD: record });
    await waitFor("migration started", () => recorded().some((l) => l.startsWith("start")));
    stubborn.child.kill("SIGTERM");
    assert.equal(await stubborn.exited, 143);
    assert.equal(await leaseRow(), null);
    assert.equal(stubborn.events().find((e) => e.event === "migration_lock_released")?.reason, "runner_exited");
  });

  test("two containers booting at once are serialised by the advisory lock (no overlap, no takeover)", async () => {
    const fast = { FAKE_GBRAIN_WORK_MS: "700", KNOWLEDGE_MIGRATION_POLL_S: "0.1" };
    const [a, b] = await Promise.all([boot(fast), boot(fast)]);
    await waitFor("both serving", async () => (await health(a.port))?.code === 200 && (await health(b.port))?.code === 200);
    const lines = recorded().map((l) => l.split(" "));
    assert.equal(lines.length, 4);
    const runs = new Map<string, number[]>();
    for (const [, pid, ts] of lines) runs.set(pid as string, [...(runs.get(pid as string) ?? []), Number(ts)]);
    const [r1, r2] = [...runs.values()].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
    assert.ok(r1 && r2 && (r1[1] ?? 0) <= (r2[0] ?? 0), "second run starts after the first ended");
    assert.equal([...a.events(), ...b.events()].filter((e) => e.event === "migration_lock_takeover").length, 0);
    a.child.kill("SIGTERM");
    b.child.kill("SIGTERM");
    await Promise.all([a.exited, b.exited]);
  });
});
