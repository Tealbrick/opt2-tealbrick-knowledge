# Changelog

All notable changes to the Knowledge mini app. Versions are assigned at merge (C340); `package.json` and the manifest stay
at 0.1.26 on this branch.

## Unreleased

Proposed version 0.1.29, `upgradeFrom` ">=0.1.20 <=0.1.28". Needs Core with the manifest 0.1.32 pin (CORE-P5, core#67) and
bridge P-2 (0.2.11); until then Core skips this release. App database migration `0003_people.sql` (person memory, below;
expand only). Person and team memory needs Governance 0.3.0 or newer (its feed allows `knowledge`); with an older or no
Governance, Knowledge keeps today's access.

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

- Person and team memory (C373; Martin C312.4, C322(5)). Knowledge reads the Governance directory (companion `fleet`
  `directory_feed`, read; contract `fleet.directory_feed/1`, vendored in `src/contracts/`) at start, every 60 s, after an
  agent is added and when the owner opens Access, never inside an agent call. It keeps ids and flags only (no handles,
  no trust values). New area kinds `person-…` and `team-…` (created when a new directory is read, or on first use):
  - an agent whose owner is an active person reads and writes that person's area, and writes without `area` go there;
  - an agent reads the team area of every team it or its owner is in (a blocked agent reads no team);
  - no agent reads another person's, team's or agent's area unless the owner lets one of its teams read that person
    (`access_grant_set`, optionally only some tags; `access_grant_remove`); grant changes are logged (append-only);
  - no directory (Governance missing, before 0.3.0, refusing, or no good read for 10 minutes) or no owner: today's
    access (own agent area + company area). Rules narrowing still applies on top; app callers never see these areas.
- Access page: people (directory id + their agents' names) and their memory, teams with members and grants, add and
  remove a grant, agents with no owner, the change log, and the directory state in plain words ("Update Governance to
  0.3.0"). Person ops `access_overview`, `access_grant_set`, `access_grant_remove`.
- `areas_list` names `defaultArea`, why each area is readable (`via`: owner, team, grant), `onlyTags` for a tag-limited
  grant, and `directory` (owner_known, no_owner, unavailable).

### Changed

- The legacy provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) are optional fallbacks. A
  missing key no longer holds the memory engine (`memory_engine_key_missing` is removed).
- Manifest order: `document_create` now precedes `remember`, so the conformance A12 app-caller rows run a document write (the app
  caller allow-list no longer includes `remember`). `tealbrick-conformance.json` `inputsAs.app` follows.
- Conformance start module applies `TBCONF_LEVEL_CRUD` (A21 rows, conformance 0.1.30) and lists the stub tools in the catalog (A20).
- Pins: miniapp-sdk 0.1.41, manifest 0.1.32, spec 0.1.78, conformance 0.1.30; `tb-exec` miniapp-sdk 0.1.41.

- Agents and scopes shows agent and company areas only; person and team memory is set on the Access page.
- Area descriptions in the manifest name the default area (the owner's personal memory, else the own agent area).

### Fixed

- Ported from 0.1.28 (hotfix/0.1.27): a memory engine that is still starting (502/503, refused, reset, timeout) is not a
  failure; attention `memory_engine_starting`; the engine is re-probed after 1 s, doubling to 60 s.

## 0.1.28 (hotfix/0.1.27)

- A starting memory engine is not a failure; quick engine re-probe. Engine-call failure log (0.1.28-dev.1).

## 0.1.27

- Node 24.22.1 base image (image-only patch).

## 0.1.26

- cite, batch remember, GBrain 0.60.424, hot tools (C336).
