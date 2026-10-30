# Provenance of the contract files in this folder

These files are byte copies. Do not edit them. To update, copy the files from a newer spec tag and change this header in
the same commit. `test/directory-feed.test.ts` fails when a file no longer matches the sha256 below.

- Source repo: `Tealbrick/opt2-tealbrick-specs` (private)
- Tag: `spec-v0.1.42` (annotated tag object `0e1b92c2c962b728588e1aeccd1bd721cfe7e726`, commit `e2e05cdf9eb49bdaf726b6180779964d3cb3e506`)
- Contract: `fleet.directory_feed/1` (producer: Governance, product id `fleet`, op `directory_feed`; consumers: Rules & Approvals and, from Governance 0.3.0, this app). Decisions C230, C373.
- Copied from the vendored copy in `opt2-tealbrick-fleet/test/contracts/` at fleet `origin/main` `fcd3272` (same bytes, same sha256 as the copy Rules vendors).

| File here | Path in the source repo (at the tag) | sha256 |
|---|---|---|
| `fleet.directory_feed.1.schema.json` | `packages/spec/schemas/contracts/fleet.directory_feed.1.schema.json` | `18d49f48f1196af77223acb38ea9b95f5786c587019b4688cd9417f5708df724` |
| `fleet.directory_feed.1.json` | `packages/spec/examples/contracts/fleet.directory_feed.1.json` | `339d4b8c9377b0c035fd8937518565aac368bc4a3e8a3bb468559aedc7b4db71` |
| `../../src/contracts/fleet.directory_feed.1.schema.json` (runtime copy: the image has no `test/`) | same as the schema above | `18d49f48f1196af77223acb38ea9b95f5786c587019b4688cd9417f5708df724` |

How this app uses them: `src/directory-feed.ts` validates EVERY `directory_feed` answer against the schema with the JSON
Schema 2020-12 validator that `@opt2-tealbrick/manifest` exports (`validateAgainstSchema`) and applies the extra reader rule
`normalizeHandle(h) === h` for every handle. A mismatch is a refusal (the error is recorded, the copy is cleared, nothing
of the answer is read). Knowledge keeps no handle and no trust value: only ids, the person/outside-agent kind, the
active/departed status, an agent's owner and whether it is blocked, and team names and members (C88). The fixtures
`valid`, `invalid` and `invalidByNormalizeHandle` run through the same reader in `test/directory-feed.test.ts`.

## tb.access/1 (C380, spec 0.1.89, docs/ACCESS.md)

Same rules: byte copies, do not edit. `test/tb-access-contract.test.ts` fails when a file no longer matches, or when the
manifest no longer embeds the schemas. Consumer: Governance (product id `fleet`). Knowledge serves `access_list` and `access_revoke`.

- Tag `spec-v0.1.89` (commit `074f1a90b77db38176b8a1eae2e7c1159db493c9`, specs#68). First copied from the PR branch at `d543905`; compared with the tag: every file is byte-identical.

| File here | Path in the source repo | sha256 |
|---|---|---|
| `access.list_in.1.schema.json` | `packages/spec/schemas/contracts/access.list_in.1.schema.json` | `83f1c2f7c2c399d8e11a93418e469d01c777af5f6c8bfe7cd2643539f3a04fe5` |
| `access.list_out.1.schema.json` | `packages/spec/schemas/contracts/access.list_out.1.schema.json` | `571feb6b833d392f8eec3212b21d53aa7e529dfb65a34f8a54b89d07160c7f48` |
| `access.revoke_in.1.schema.json` | `packages/spec/schemas/contracts/access.revoke_in.1.schema.json` | `edbe7c6b94ffb74e4dff0c3f986ccaa29e83d8d6fd1fa9f1e2986d2802e60c51` |
| `access.revoke_out.1.schema.json` | `packages/spec/schemas/contracts/access.revoke_out.1.schema.json` | `b36b1c6474fc858daf93e2a4d9605067113937b984e8b26833fa13eae314d919` |
| `access.list_in.1.json` | `packages/spec/examples/contracts/access.list_in.1.json` | `dc1745d9a0bd6d83fdd672fbc14e119f9637b19537162e77455b246676535c85` |
| `access.list_out.1.json` | `packages/spec/examples/contracts/access.list_out.1.json` | `efc7e1389eb7a7eac55e3149c2ac111959a5664ebaccf630a0155668c70b5c49` |
| `access.revoke_in.1.json` | `packages/spec/examples/contracts/access.revoke_in.1.json` | `5cab7e5c4b15ddf172aac5a4dab0f55a1028eeaa4ac491a712c4b88f6221783d` |
| `access.revoke_out.1.json` | `packages/spec/examples/contracts/access.revoke_out.1.json` | `76ed608d69f86c43d217ce18516ffe7b233d20f5971a962e862184a62b296281` |
| `access.digest.1.json` | `packages/spec/examples/contracts/access.digest.1.json` | `e4db19dd894802348b9e87c2251d85383fb2e4f47e90b26dde76c42e17b42daa` |
| `access.caller_vector.1.json` | `packages/spec/examples/contracts/access.caller_vector.1.json` | `faf832b1a3fa7e122f252677e9a946be11668cacd23ce0f765fcaa57ebe5cd49` |

How this app uses them: the manifest embeds the schemas as the input and output of `access_list` and `access_revoke` (the SDK
validates every call and answer). The fixtures run through the same validator, the digest fixture checks `digestOf`, and the
caller vector checks the guard (`src/tb-access.ts`).
