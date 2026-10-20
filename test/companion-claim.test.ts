// C296 QA-C296-4 claim gate (L75: certify by output): EVERY companion declared in the manifest boots the same tb-exec the
// companion images run (services/tb-exec, installed from its own integrity-pinned lock) against a fake bridge and must
// complete its claim with a fresh service code: `service` = its id, `manifestDigest` = the manifest the bridge serves.
// A companion that cannot claim (wrong digest, wrong service, env or tb-exec break) fails here, before a release.
// Proof boundary: the companion's entrypoint/image layers are not run (no Docker in CI); the upstream is a stand-in.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeBridge, type FakeBridge } from "@opt2-tealbrick/conformance";
import { manifestDigest } from "@opt2-tealbrick/manifest";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(root, "tealbrick.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const services: { id: string }[] = manifest.runtime.services ?? [];

/** The tb-exec flags of a companion, from the ENTRYPOINT of its own Dockerfile (between cli.js and `--`): the image's
 *  real helper flags; /opt/knowledge/ (the image's copy of services/<id>/) maps to the repo folder. The image passes no
 *  --manifest, so its Dockerfile must copy the repo manifest to tb-exec's default path (the test then points
 *  --manifest at that same repo file). */
function execFlags(id: string, defaultManifest: string): string[] {
  const docker = readFileSync(join(root, "services", id, "Dockerfile"), "utf8");
  assert.match(docker, new RegExp(`^COPY\\s+tealbrick\\.manifest\\.json\\s+${defaultManifest.replaceAll(".", "\\.")}\\s*$`, "mu"), `services/${id}/Dockerfile copies the manifest to ${defaultManifest}`);
  const line = /^ENTRYPOINT\s+(\[.*\])\s*$/mu.exec(docker)?.[1];
  assert.ok(line, `services/${id}/Dockerfile has a JSON ENTRYPOINT`);
  const argv = JSON.parse(line) as string[];
  const from = argv.findIndex((a) => a.endsWith("/exec/cli.js"));
  const to = argv.indexOf("--", from);
  assert.ok(from >= 0 && to > from, `services/${id}: tb-exec cli.js ... -- in the ENTRYPOINT`);
  assert.ok(!argv.includes("--manifest"), `services/${id}: the ENTRYPOINT relies on the default manifest path`);
  return argv.slice(from + 1, to).map((a) => a.replaceAll("/opt/knowledge/", `${join(root, "services", id)}/`));
}

let tbExecDir = "";
let defaultManifest = "";
const tempDirs: string[] = [];
let bridge: FakeBridge;
const children: ChildProcess[] = [];

before(async () => {
  // the companion images' tb-exec, exactly as their Dockerfiles install it (npm ci --ignore-scripts from the lock)
  tbExecDir = mkdtempSync(join(tmpdir(), "kn-tbexec-"));
  tempDirs.push(tbExecDir);
  for (const f of ["package.json", "package-lock.json"]) copyFileSync(join(root, "services", "tb-exec", f), join(tbExecDir, f));
  const npm = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tbExecDir, encoding: "utf8" });
  assert.equal(npm.status, 0, `${npm.stdout}${npm.stderr}`);
  const args = (await import(pathToFileURL(join(tbExecDir, "node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/args.js")).href)) as { DEFAULT_MANIFEST_PATH: string };
  defaultManifest = args.DEFAULT_MANIFEST_PATH;
  assert.ok(defaultManifest, "tb-exec exports its default manifest path");
  const ignored = readFileSync(join(root, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(!ignored.some((l) => l && !l.startsWith("#") && "tealbrick.manifest.json".match(new RegExp(`^${l.replaceAll(".", "\\.").replaceAll("*", ".*")}$`, "u"))), "the build context keeps tealbrick.manifest.json");
  bridge = await createFakeBridge({ manifest });
});

after(async () => {
  for (const c of children) c.kill("SIGKILL");
  await bridge?.close();
  // only the folders this test made
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("companion claim gate (QA-C296-4)", () => {
  test("the manifest declares companions", () => assert.ok(services.length >= 2, services.map((s) => s.id).join(",")));

  for (const svc of services) {
    test(`${svc.id}: tb-exec claims with a fresh service code, its service id and the served manifest digest`, async () => {
      const before = bridge.claims.length;
      const code = bridge.issueEnrolCode(bridge.ids.ins, svc.id);
      const dataDir = mkdtempSync(join(tmpdir(), `kn-${svc.id}-`));
      tempDirs.push(dataDir);
      const log: string[] = [];
      const child = spawn(process.execPath, [join(tbExecDir, "node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js"), ...execFlags(svc.id, defaultManifest), "--manifest", manifestPath, "--", process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        env: {
          PATH: process.env.PATH ?? "",
          TB_INSTANCE_ID: bridge.ids.ins,
          TB_SERVICE: svc.id,
          TB_BRIDGE_URL: bridge.url,
          TB_ENROL_CODE: code,
          TB_DATA_DIR: dataDir,
          TB_DATA_EPHEMERAL: "1",
          TB_PORTAL_KEYS: JSON.stringify(bridge.portalJwks()),
          TB_KEK: randomBytes(32).toString("base64url"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stdout?.on("data", (d) => log.push(String(d)));
      child.stderr?.on("data", (d) => log.push(String(d)));
      const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
      const claimed = (async () => {
        for (let i = 0; i < 300 && bridge.claims.length === before; i++) await new Promise((r) => setTimeout(r, 50));
        return bridge.claims.length > before;
      })();
      const winner = await Promise.race([claimed.then((ok) => (ok ? "claimed" : "timeout")), exited.then(() => "exited")]);
      child.kill("SIGTERM");
      assert.equal(winner, "claimed", `no claim from ${svc.id}; tb-exec said:\n${log.join("").slice(-2000)}`);
      const claim = bridge.claims[before]?.request;
      assert.ok(claim);
      assert.equal(claim.service, svc.id);
      assert.equal(claim.manifestDigest, manifestDigest(manifest), "the companion claims for the deployed manifest");
      assert.equal(claim.version, manifest.version);
    });
  }
});
