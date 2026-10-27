# Changelog

All notable changes to the Knowledge mini app. Versions are assigned at merge (C340); `package.json` and the manifest stay
at 0.1.26 on this branch.

## Unreleased

Proposed version 0.1.29, `upgradeFrom` ">=0.1.20 <=0.1.28". Needs Core with the manifest 0.1.32 pin (CORE-P5, core#67) and
bridge P-2 (0.2.11); until then Core skips this release. No app database migration (`kn_state` only).

### Added

- Model roles `embeddings` and `reasoning` (manifest `settings.modelRoles`, both optional). The owner binds them on the bridge
  Keys and models page; `tb-exec` passes them to GBrain (`KN_EMBEDDINGS_*`, `KN_REASONING_*`); the GBrain boot wrapper plans
  the engine models from them (`services/gbrain/models.ts`) and reports them at helper path `/models`.
- Owner attention `model_role_optional` (a role is not set, recall is keyword-only or ask cannot answer) and
  `embeddings_changed` (the binding differs from the model the index was built with; the index keeps its model).
- `ask` answers 409 `reasoning_model_missing` when no reasoning model is usable.
- Settings page: the two roles as bound, not bound or degraded, with a notice in plain words. The old provider keys sit under
  "Older provider keys".
- App writers (Observer): `areas_list`, `document_create`, `document_update` as an app caller, company area only. The document
  page names the app ("Observer"). Any other op from an app is `scope_denied`.

- Access level `contribute` ("Read, add and edit": read, create, update, no delete) for area scopes, offered on the Agents and
  scopes page. It also lets the conformance row A21.owner_row_narrowed_level (SDK 0.1.41) narrow a level into a valid manifest.

### Changed

- The legacy provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) are optional fallbacks. A
  missing key no longer holds the memory engine (`memory_engine_key_missing` is removed).
- Manifest order: `document_create` now precedes `remember`, so the conformance A12 app-caller rows run a document write (the app
  caller allow-list no longer includes `remember`). `tealbrick-conformance.json` `inputsAs.app` follows.
- Conformance start module applies `TBCONF_LEVEL_CRUD` (A21 rows, conformance 0.1.30) and lists the stub tools in the catalog (A20).
- Pins: miniapp-sdk 0.1.41, manifest 0.1.32, spec 0.1.78, conformance 0.1.30; `tb-exec` miniapp-sdk 0.1.41.

### Fixed

- QA of knowledge#24 (KN24-1, KN24-2, KN24-3, KN24-4, KN24-7, KN24-10):
  - Engine health comes first: `memory_engine_key_rejected`, `memory_engine_failing` and `memory_engine_starting` are no longer
    hidden by `model_role_optional` (an embeddings-only install). The model notice shows when the engine answers.
  - An app caller is refused on every dynamic `engine` tool (it only lists areas and writes documents in the company area), and the
    engine fan-out keeps only areas an app may see.
  - The GBrain boot removes the previous `knowledge-models.json` at start (the helper answers 503 until the new boot wrote its own).
    After a model-role or key change Knowledge re-reads `/models` at +30 s, +90 s and +3 min until the answer changes, and `ask`
    re-reads it before it refuses with `reasoning_model_missing`.
  - Boot: a `config.json` that names no embedding model (and not `embedding_disabled`) leaves the brain as it is (no
    `embeddings enable`); a corrupt file no longer crashes the boot (status `unreadable`, Settings notice).
  - `areas_list` shows `contribute` for the contribute level. A write by an app that is no longer listed (`Caller.listed` false) is
    allowed, as conformance A12.caller_name requires, and logged as a warning.
  - Settings notes "this provider uses its fixed address" when a base URL is bound for together, mistral, deepseek or voyage.

- Ported from 0.1.28 (hotfix/0.1.27): a memory engine that is still starting (502/503, refused, reset, timeout) is not a
  failure; attention `memory_engine_starting`; the engine is re-probed after 1 s, doubling to 60 s.

## 0.1.28 (hotfix/0.1.27)

- A starting memory engine is not a failure; quick engine re-probe. Engine-call failure log (0.1.28-dev.1).

## 0.1.27

- Node 24.22.1 base image (image-only patch).

## 0.1.26

- cite, batch remember, GBrain 0.60.424, hot tools (C336).
