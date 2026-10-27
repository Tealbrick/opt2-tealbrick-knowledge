// Test double of upstream `gbrain` (garrytan/gbrain 99de5707) for the migration lease only, run by boot.ts in the
// real-Postgres tests. apply-migrations takes `gbrain_cycle_locks.id = 'gbrain-apply-migrations'` with upstream's
// acquire statement (src/core/db-lock.ts tryAcquireDbLock: 60 min TTL, steal only after TTL + grace), refreshes it,
// releases it on SIGTERM (upstream registerCleanup) and exits 75 when the lease is busy. serve answers /health.
// Knobs: FAKE_GBRAIN_HOST (holder_host), FAKE_GBRAIN_WORK_MS, FAKE_GBRAIN_REFRESH_MS, FAKE_GBRAIN_EXIT,
// FAKE_GBRAIN_IGNORE_SIGTERM, FAKE_GBRAIN_RECORD (file that gets "start|end <pid> <epoch ms>" lines).
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import postgres from "postgres";

const env = process.env;
const [cmd, ...rest] = process.argv.slice(2);
const record = (what: string) => {
  if (env.FAKE_GBRAIN_RECORD) appendFileSync(env.FAKE_GBRAIN_RECORD, `${what} ${process.pid} ${Date.now()}\n`);
};

if (cmd === "init") {
  record("init");
} else if (cmd === "embeddings") {
  // C373: `embeddings enable` (the boot enables embeddings in place on a brain built without them)
  record(`embeddings-${rest[0] ?? ""}`);
} else if (cmd === "embed") {
  record("embed");
} else if (cmd === "serve") {
  const port = Number(rest[rest.indexOf("--port") + 1]);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "fake" }));
  });
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (cmd === "apply-migrations") {
  const db = postgres({
    host: env.GBRAIN_DB_HOST,
    port: Number(env.GBRAIN_DB_PORT),
    user: env.GBRAIN_DB_USER,
    password: env.GBRAIN_DB_PASSWORD,
    database: env.GBRAIN_DB_NAME,
    max: 1,
    onnotice: () => {},
  });
  const token = randomUUID();
  const host = env.FAKE_GBRAIN_HOST ?? hostname();
  const rows = await db`
    INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
    VALUES ('gbrain-apply-migrations', ${process.pid}, ${host}, NOW(), NOW() + '60 minutes'::interval, NOW(), ${token}::uuid)
    ON CONFLICT (id) DO UPDATE
      SET holder_pid = ${process.pid}, holder_host = ${host}, acquired_at = NOW(), acquisition_token = ${token}::uuid,
          ttl_expires_at = NOW() + '60 minutes'::interval, last_refreshed_at = NOW()
      WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
        AND (gbrain_cycle_locks.last_refreshed_at IS NULL OR gbrain_cycle_locks.last_refreshed_at < NOW() - 60 * INTERVAL '1 second')
    RETURNING id`;
  if (rows.length === 0) {
    console.error("apply-migrations refused: another apply-migrations is running");
    await db.end();
    process.exit(75);
  }
  const release = () => db`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-apply-migrations' AND acquisition_token = ${token}::uuid`;
  process.on("SIGTERM", () => {
    if (env.FAKE_GBRAIN_IGNORE_SIGTERM) return;
    release()
      .catch(() => {})
      .finally(() => process.exit(143));
  });
  const refresh = setInterval(() => {
    db`UPDATE gbrain_cycle_locks SET ttl_expires_at = NOW() + '60 minutes'::interval, last_refreshed_at = NOW()
        WHERE id = 'gbrain-apply-migrations' AND acquisition_token = ${token}::uuid`.catch(() => {});
  }, Number(env.FAKE_GBRAIN_REFRESH_MS ?? 60_000));
  record("start");
  await new Promise((r) => setTimeout(r, Number(env.FAKE_GBRAIN_WORK_MS ?? 0)));
  record("end");
  clearInterval(refresh);
  await release();
  await db.end();
  process.exit(Number(env.FAKE_GBRAIN_EXIT ?? 0));
} else {
  console.error(`fake gbrain: unknown command ${cmd}`);
  process.exit(2);
}
