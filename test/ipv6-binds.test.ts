// INC-20261104-01 (0.1.35): every companion listener that another service reaches over the Railway private network must
// accept IPv6. A Railway project with an IPv6-only private network (legacy environments) refused Open Notebook's
// connection to notebook-db ("Connect call failed ('fd12:…', 8000) [Errno 111]") because SurrealDB bound 0.0.0.0, and the
// same class of bind broke the GBrain helper before miniapp-sdk 0.1.48 (knowledge#38).
// Evidence (2026-11-06, the pinned SurrealDB v2.6.5 image): `--bind 0.0.0.0:8000` → ::1 ECONNREFUSED; `--bind [::]:8000`
// → 127.0.0.1 and ::1 both connect (dual-stack, so the backup dump on 127.0.0.1 keeps working). uvicorn on "::" is IPv6
// only (asyncio sets IPV6_V6ONLY), which failed Railway's IPv4 health check in 0.1.35: the API keeps its IPv4 bind and
// services/notebook/ipv6-forward.ts adds the IPv6 listener (0.1.36).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../services/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
/** non-comment lines of a Dockerfile or shell script */
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/u.test(l))
    .join("\n");

test("INC-20261104-01: no companion Dockerfile or entrypoint binds a network listener to 0.0.0.0 (IPv4 only)", () => {
  const offenders: string[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === "tb-exec") continue;
    for (const file of readdirSync(new URL(`${dir.name}/`, root))) {
      if (!/^(Dockerfile|.*\.sh)$/u.test(file)) continue;
      if (/0\.0\.0\.0/u.test(code(read(`${dir.name}/${file}`)))) offenders.push(`${dir.name}/${file}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("INC-20261104-01: notebook-db (SurrealDB) binds [::]:8000; the backup dump still targets 127.0.0.1:8000", () => {
  assert.match(code(read("notebook-db/Dockerfile")), /--bind \[::\]:8000/u);
  assert.match(read("notebook-db/notebook-db-dump"), /--endpoint "http:\/\/127\.0\.0\.1:8000"/u);
});

test("INC-20261104-01 (0.1.36): the Open Notebook API keeps upstream's IPv4 bind (Railway's IPv4 health check) and gets an IPv6 forwarder", () => {
  const docker = code(read("notebook/Dockerfile"));
  // 0.1.35 set API_HOST=:: : uvicorn then listens on IPv6 only and Railway's IPv4 health check failed the deploy
  assert.doesNotMatch(docker, /API_HOST/u);
  assert.match(docker, /COPY services\/notebook\/entrypoint\.sh services\/notebook\/ipv6-forward\.ts \/opt\/knowledge\//u);
  const entry = code(read("notebook/entrypoint.sh"));
  assert.match(entry, /node \/opt\/knowledge\/ipv6-forward\.ts \|\| true/u);
  // crash loop → the container stops (Coordinator condition 2), and the forwarder starts before the upstream exec
  assert.match(entry, /if \[ "\$n" -gt 5 \]; then[\s\S]*kill -KILL "\$main"/u);
  assert.match(entry, /\) &\nexec \/app\/scripts\/docker-entrypoint\.sh "\$@"\n?$/u);
});

test("INC-20261104-01: gbrain serve binds :: by default (boot.ts)", () => {
  assert.match(read("gbrain/boot.ts"), /env\.GBRAIN_BIND \?\? "::"/u);
});
