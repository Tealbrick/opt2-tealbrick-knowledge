// Regenerates the pinned GBrain operation surface (src/engines/gbrain/surface-<version>.json) from an upstream checkout.
// It reads upstream's generated, handler-free registry (src/core/operation-manifest.generated.ts, upstream >= 0.60.3xx) as
// data: no upstream code runs. Usage:
//   node scripts/gbrain-surface.ts <upstream checkout at the tag> <tag> <commit>
// exposure.ts then decides, per operation, exposed or excluded; the build fails on an unmapped upstream write.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface UpstreamMeta {
  name: string;
  scope?: string;
  mutating?: boolean;
  localOnly?: boolean;
  cliOnly?: unknown;
  publishGateKey?: string;
  requiredScopes?: string[];
  area?: string;
  params?: Record<string, unknown>;
}

const [root, tag, commit] = process.argv.slice(2);
if (!root || !tag || !/^v\d+\.\d+\.\d+\.\d+$/u.test(tag) || !commit || !/^[0-9a-f]{40}$/u.test(commit)) {
  console.error("usage: node scripts/gbrain-surface.ts <upstream checkout> <vX.Y.Z.W> <40-hex commit>");
  process.exit(2);
}
const version = readFileSync(join(root, "VERSION"), "utf8").trim();
if (`v${version}` !== tag) {
  console.error(`checkout VERSION ${version} does not match ${tag}`);
  process.exit(1);
}
const source = readFileSync(join(root, "src/core/operation-manifest.generated.ts"), "utf8");
const marker = "OPERATION_MANIFEST: OperationMeta[] = ";
const start = source.indexOf(marker);
const end = source.lastIndexOf("];");
if (start < 0 || end < start) {
  console.error("operation-manifest.generated.ts: OPERATION_MANIFEST array not found");
  process.exit(1);
}
const metas = JSON.parse(source.slice(start + marker.length, end + 1)) as UpstreamMeta[];
const operations = metas.map((op) => ({
  name: op.name,
  scope: op.scope ?? "read",
  mutating: op.mutating === true,
  localOnly: op.localOnly === true,
  cliOnly: op.cliOnly !== undefined,
  publishGateKey: op.publishGateKey ?? null,
  requiredScopes: op.requiredScopes ?? null,
  area: op.area ?? null,
  params: Object.keys(op.params ?? {}),
}));
const surface = {
  engine: "gbrain",
  provenance: {
    repo: "https://github.com/garrytan/gbrain",
    license: "MIT",
    tag,
    commit,
    method: "generated registry (src/core/operation-manifest.generated.ts) at the tag: name, scope, transport gates, area, params",
  },
  operationCount: operations.length,
  operations,
};
const out = new URL(`../src/engines/gbrain/surface-${version}.json`, import.meta.url);
writeFileSync(out, `${JSON.stringify(surface, null, 2)}\n`);
console.log(`${operations.length} operations → ${out.pathname}`);
