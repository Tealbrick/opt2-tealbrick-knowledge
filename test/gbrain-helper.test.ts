// C390 (knowledge#38): the GBrain helper logs each `sources add` (labels + ms, never CLI output) and answers a failed
// CLI with 502 source_add_failed + details.cause (cli_exit_<n>, cli_timeout), never as an unreachable helper.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const HELPER = new URL("../services/gbrain/helper.ts", import.meta.url).pathname;
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGTERM");
});

/** Start helper.ts with a fake `bun` on PATH that runs `script`; resolves once it listens. */
async function startHelper(script: string): Promise<{ home: string; stderr: () => string; stop: () => Promise<void> }> {
  const bin = mkdtempSync(join(tmpdir(), "kn-helper-bin-"));
  writeFileSync(join(bin, "bun"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "bun"), 0o755);
  const child = spawn(process.execPath, [HELPER], { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GBRAIN_ROOT: "/nonexistent", GBRAIN_HOME: bin }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  let err = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => (err += c));
  for (let i = 0; i < 100 && !err.includes("helper_listening"); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(err.includes("helper_listening"), "helper did not start (port 3141 in use?)");
  return {
    home: bin,
    stderr: () => err,
    stop: () =>
      new Promise((ok) => {
        child.once("exit", () => ok());
        child.kill("SIGTERM");
      }),
  };
}

const add = (id: string) =>
  fetch("http://127.0.0.1:3141/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name: "company" }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

test("a CLI that exits 3: 502 source_add_failed with cause cli_exit_3; the log line has labels only, never the CLI output", async () => {
  const h = await startHelper(`echo "connect postgres://postgres:secretpw@db:5432/gbrain failed" >&2; exit 3`);
  try {
    const r = await add("ka-0123456789abcdef01234567");
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, { error: { code: "source_add_failed", message: "the engine could not create the source", details: { cause: "cli_exit_3" } } });
    const line = h.stderr().split("\n").find((l) => l.includes('"sources_add"'));
    assert.ok(line);
    const parsed = JSON.parse(line);
    assert.equal(parsed.outcome, "failed");
    assert.equal(parsed.cause, "cli_exit_3");
    assert.equal(typeof parsed.ms, "number");
    assert.ok(!h.stderr().includes("secretpw"), "CLI output never reaches the log");
  } finally {
    await h.stop();
  }
});

test("source_id_taken is 'exists' and a clean exit is 'created', each logged with its duration", async () => {
  const h = await startHelper(`case "$*" in *ka-aaaaaaaaaaaaaaaaaaaaaaaa*) echo source_id_taken >&2; exit 1;; *) exit 0;; esac`);
  try {
    assert.deepEqual(await add("ka-aaaaaaaaaaaaaaaaaaaaaaaa"), { status: 200, body: { status: "exists" } });
    assert.deepEqual(await add("ka-bbbbbbbbbbbbbbbbbbbbbbbb"), { status: 200, body: { status: "created" } });
    const outcomes = h
      .stderr()
      .split("\n")
      .filter((l) => l.includes('"sources_add"'))
      .map((l) => JSON.parse(l).outcome);
    assert.deepEqual(outcomes, ["exists", "created"]);
  } finally {
    await h.stop();
  }
});

// C392 R2: the owner's forget purges a document's engine page through upstream's trusted local CLI (MCP refuses purge).
const purge = (body: unknown) =>
  fetch("http://127.0.0.1:3141/purge-page", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

test("C392 R2 /purge-page: runs `gbrain delete knowledge-docs/<doc> --source-id <src> --purge`; page_not_found = absent; a failure is a label only", async () => {
  const doc = "kdoc_01HZXRSB6V0N7Q2M3K4J5P6W8Y";
  const h = await startHelper(
    `echo "$*" >> "$GBRAIN_HOME/args"; case "$*" in *kdoc_01hzxrsb6v0n7q2m3k4j5p6w8z*) echo '{"error":{"code":"page_not_found"}}'; exit 1;; *kdoc_01hzxrsb6v0n7q2m3k4j5p6w90*) echo "page text Dana Client postgres://u:secretpw@db" >&2; exit 2;; *) exit 0;; esac`,
  );
  try {
    assert.deepEqual(await purge({ source: "ka-0123456789abcdef01234567", document: doc }), { status: 200, body: { status: "purged" } });
    assert.deepEqual(await purge({ source: "ka-0123456789abcdef01234567", document: "kdoc_01HZXRSB6V0N7Q2M3K4J5P6W8Z" }), { status: 200, body: { status: "absent" } });
    assert.deepEqual(await purge({ source: "ka-0123456789abcdef01234567", document: "kdoc_01HZXRSB6V0N7Q2M3K4J5P6W90" }), {
      status: 502,
      body: { error: { code: "page_purge_failed", message: "the engine could not purge the page", details: { cause: "cli_exit_2" } } },
    });
    // only a Knowledge document page of a Knowledge source: anything else is refused before the CLI runs
    for (const bad of [{ source: "ka-0123456789abcdef01234567", document: "people/dana-client" }, { source: "default", document: doc }, { source: "ka-0123456789abcdef01234567", document: `${doc} --all` }, {}]) {
      assert.equal((await purge(bad)).status, 400, JSON.stringify(bad));
    }
    const runs = readFileSync(join(h.home, "args"), "utf8").trim().split("\n");
    assert.equal(runs.length, 3, "the refused requests never ran the CLI");
    assert.match(runs[0] as string, /^run \/nonexistent\/src\/cli\.ts delete knowledge-docs\/kdoc_01hzxrsb6v0n7q2m3k4j5p6w8y --source-id ka-0123456789abcdef01234567 --purge --force --request-id [0-9a-f-]{36} --json$/u);
    const lines = h.stderr().split("\n").filter((l) => l.includes('"page_purge"')).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.outcome, l.cause ?? null]), [["purged", null], ["absent", null], ["failed", "cli_exit_2"]]);
    assert.ok(!h.stderr().includes("secretpw") && !h.stderr().includes("Dana"), "CLI output never reaches the log");
  } finally {
    await h.stop();
  }
});
