// Relationship operations (C392 R1) over the store in src/relationships.ts.
// Agent ops (relationships_list, relationship_get, relationship_propose): the operator is the calling agent's owner in the
// Governance directory copy; nothing names an operator in the input, so an agent can never reach another operator's people.
// Person ops (relationships_overview, relationship_confirm, relationship_set): the workspace owner, naming the operator.
// The agent ops declare scopeType `area` like every other Knowledge agent op (mirrors `remember`) with no target instance:
// the SDK checks the agent's best area access, so an agent the owner left without write access anywhere cannot propose.
// Receipts (`redact`) carry ids, field names and counts only: never an identity value, a label, a stance or history text.
// C392 R2: `relationship_forget_scan` (read) and `relationship_forget` (destructive), owner only (src/forget.ts).
import { readFileSync } from "node:fs";
import type { HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { forgetPerson, forgetScan, requireKnownOperator } from "./forget.ts";
import type { Knowledge, Services } from "./knowledge.ts";
import { decideProposals, getRelationship, listRelationships, operatorForAgent, propose, RelationshipError, type RelType, relationshipsOverview, requireListedOperator, setRelationship } from "./relationships.ts";

type In = Record<string, any>;

export interface RelationshipDeps {
  wrap<T>(fn: () => Promise<T>): Promise<T>;
  fail(code: string, message: string, status: number): Error;
  /** R2 forget: the bound services (database, engine, projector) and the app (engine page purge) */
  services(ctx: OpContext): Services;
  knowledge: Knowledge;
}

export const RELATIONSHIP_OPS = [
  "relationships_list",
  "relationship_get",
  "relationship_propose",
  "relationships_overview",
  "relationship_confirm",
  "relationship_set",
  "relationship_forget_scan",
  "relationship_forget",
] as const;

/** The manifest backup policy, named in the forget report (backups taken before a forget keep the person). */
const BACKUPS = (() => {
  const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as { backups?: { schedule?: string; retain?: number } };
  return { schedule: manifest.backups?.schedule ?? "none", retain: manifest.backups?.retain ?? 0 };
})();

/**
 * C393 (Q3): what a Knowledge forget cannot reach yet, in every report. GBrain lines from the pinned upstream (ARCHITECTURE.md
 * "Forget a person"): a page purge leaves text-free tombstones, and deleted rows stay in database pages until reused.
 */
export const NOT_POSSIBLE_YET: readonly { store: string; reason: string }[] = [
  { store: "foundry", reason: "Deep knowledge (Foundry) has no dataset delete until F2. Ask the owner to wipe the deep volume and feed it again." },
  { store: "lcm-x", reason: "LCM-X is a local store on the agent machine. LCM-X forget only hides rows, and purge works per session." },
  {
    store: "backups",
    reason: `Backups taken before now keep the person until they age out. Knowledge keeps the last ${BACKUPS.retain} scheduled backups (schedule "${BACKUPS.schedule}", once a day), each with the GBrain and research databases, and any pre-update snapshot.`,
  },
  { store: "research", reason: "Research notebook sources are not scanned in R2. Use research_source_delete for each source that names the person." },
  { store: "gbrain_unprojected", reason: "GBrain pages not created from a Knowledge document (agent gb_* writes, engine-made entity pages) are not scanned." },
  {
    store: "gbrain_tombstones",
    reason: "A purged GBrain page leaves text-free tombstones: the page slug with content hashes, and for each purged fact a hash and its entity slug, which can contain the person's name.",
  },
  { store: "relationships_other", reason: "History and proposals of other people in Relationships are not scanned for this person's name or identities." },
  { store: "deleted_rows", reason: "Deleted rows can stay in free database pages and write-ahead logs (Knowledge SQLite, GBrain Postgres) until the database reuses or vacuums them." },
];

const fieldsOf = (input: In) => ["type", "identities", "label", "stance", "trust"].filter((k) => input[k] !== undefined);

export function createRelationshipHandlers(d: RelationshipDeps): Record<string, HandlerSpec<In, Json>> {
  const { wrap, fail, knowledge } = d;
  const run = <T>(fn: () => T) =>
    wrap(async () => {
      try {
        return fn() as unknown as Json;
      } catch (error) {
        if (error instanceof RelationshipError) throw fail(error.code, error.message, error.httpStatus);
        throw error;
      }
    });
  /** The calling agent's operator (fail closed); a person or app caller has none. */
  const operatorOf = (ctx: OpContext) => {
    if (ctx.caller.type !== "agent") throw fail("scope_denied", "relationships are kept by agents for their owner; this caller is not an agent", 403);
    return operatorForAgent(ctx.db, ctx.caller.id);
  };
  /** no area instance: the SDK checks the caller's best area access (as `anyScope` in handlers.ts) */
  const scope = () => null;
  const ownerOnly = (ctx: OpContext) => {
    if (ctx.caller.type !== "person") throw fail("scope_denied", "only the owner decides relationships", 403);
  };

  return {
    relationships_list: {
      scope,
      run: (input, ctx) => run(() => ({ people: listRelationships(ctx.db, operatorOf(ctx), { type: input.type as RelType | undefined, query: input.query, limit: input.limit }) })),
    },

    relationship_get: {
      scope,
      run: (input, ctx) => run(() => getRelationship(ctx.db, operatorOf(ctx), { person: input.person, identity: input.identity })),
    },

    relationship_propose: {
      scope,
      redact: (input, output) => {
        const out = output as In | undefined;
        const who = out?.person ? `${out.created ? "new person " : "person "}${String(out.person)}` : input.person ? `person ${String(input.person).slice(0, 40)}` : "a new person";
        const fields = fieldsOf(input);
        const history = Array.isArray(input.history) ? input.history.length : 0;
        return `relationship proposal for ${who}: ${fields.length ? fields.join(", ") : "no field"}; ${history} history item${history === 1 ? "" : "s"}`;
      },
      run: (input, ctx) => run(() => propose(ctx.db, operatorOf(ctx), ctx.caller.id, input as never)),
    },

    relationships_overview: {
      run: (input, ctx) =>
        run(() => {
          ownerOnly(ctx);
          return relationshipsOverview(ctx.db, typeof input.operator === "string" ? input.operator : null);
        }),
    },

    relationship_confirm: {
      redact: (input) => {
        const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
        return `relationship proposals of ${String(input.operator).slice(0, 40)}: ${n(input.accept)} accepted, ${n(input.reject)} rejected`;
      },
      run: (input, ctx) =>
        run(() => {
          ownerOnly(ctx);
          const operator = String(input.operator);
          requireListedOperator(ctx.db, operator);
          return { operator, decided: decideProposals(ctx.db, operator, ctx.caller.id, { accept: input.accept, reject: input.reject }) };
        }),
    },

    relationship_set: {
      redact: (input) => `relationship of ${String(input.operator).slice(0, 40)} with person ${String(input.person).slice(0, 40)}: set ${fieldsOf(input).join(", ") || "nothing"}`,
      run: (input, ctx) =>
        run(() => {
          ownerOnly(ctx);
          const operator = String(input.operator);
          requireListedOperator(ctx.db, operator);
          const { relationship, changed } = setRelationship(ctx.db, operator, ctx.caller.id, { person: String(input.person), type: input.type, stance: input.stance, trust: input.trust, label: input.label });
          return { operator, relationship, changed };
        }),
    },

    relationship_forget_scan: {
      run: (input, ctx) =>
        run(() => {
          ownerOnly(ctx);
          const operator = String(input.operator);
          requireKnownOperator(ctx.db, operator);
          const scan = forgetScan(ctx.db, operator, String(input.person));
          return { operator, person: String(input.person), scan: { terms: scan.terms, skippedShort: scan.skippedShort, truncated: scan.truncated }, matched: scan.matched, notPossibleYet: NOT_POSSIBLE_YET };
        }),
    },

    relationship_forget: {
      redact: (input, output) => {
        const out = output as { documents?: { purged?: unknown[]; pending?: unknown[]; refused?: unknown[] } } | undefined;
        const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
        const docs = out?.documents ? `: ${n(out.documents.purged)} documents purged, ${n(out.documents.pending)} engine pages pending, ${n(out.documents.refused)} refused` : "";
        return `forgot person ${String(input.person).slice(0, 40)} of ${String(input.operator).slice(0, 40)}${docs}`;
      },
      run: (input, ctx) =>
        wrap(async () => {
          ownerOnly(ctx);
          const operator = String(input.operator);
          const s = d.services(ctx);
          let core: ReturnType<typeof forgetPerson>;
          try {
            requireKnownOperator(ctx.db, operator);
            const picked = Array.isArray(input.purgeDocuments) ? input.purgeDocuments.map(String) : [];
            core = forgetPerson(ctx.db, operator, ctx.caller.id, { person: String(input.person), purgeDocuments: picked }, { queueEngine: s.engine !== null });
          } catch (error) {
            if (error instanceof RelationshipError) throw fail(error.code, error.message, error.httpStatus);
            throw error;
          }
          // The engine pages of the purged documents: purge them now through the helper; what does not answer stays queued
          // (kn_forget_queue, drained by the projection timer) and is reported `engine_pending`.
          const queued = core.purged.filter((p) => p.queued).map((p) => p.documentId);
          const drained = queued.length ? await knowledge.drainForget(s, ctx, queued).catch(() => null) : null;
          const done = new Set(drained?.done ?? []);
          return {
            person: core.person,
            operator: core.operator,
            deleted: core.deleted,
            scan: core.scan,
            documents: {
              matched: core.matched,
              purged: core.purged.map((p) => ({ documentId: p.documentId, area: p.area, engine: !p.queued ? "none" : done.has(p.documentId) ? "purged" : "pending" })),
              pending: core.purged.filter((p) => p.queued && !done.has(p.documentId)).map((p) => ({ documentId: p.documentId, area: p.area, reason: "engine_pending" })),
              refused: core.refused,
            },
            notPossibleYet: NOT_POSSIBLE_YET,
          } as unknown as Json;
        }),
    },
  };
}
