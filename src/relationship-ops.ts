// Relationship operations (C392 R1) over the store in src/relationships.ts.
// Agent ops (relationships_list, relationship_get, relationship_propose): the operator is the calling agent's owner in the
// Governance directory copy; nothing names an operator in the input, so an agent can never reach another operator's people.
// Person ops (relationships_overview, relationship_confirm, relationship_set): the workspace owner, naming the operator.
// The agent ops declare scopeType `area` like every other Knowledge agent op (mirrors `remember`) with no target instance:
// the SDK checks the agent's best area access, so an agent the owner left without write access anywhere cannot propose.
// Receipts (`redact`) carry ids, field names and counts only: never an identity value, a label, a stance or history text.
// R1 hardening (C392): outputs carry `effectiveTrust` + `trustBasis` (F5) and every agent- or third-party-supplied text under
// `observed: {untrusted: true}` (F4); the agent ops refuse a tag narrowing (F6, NARROWING_POLICY `unsupported`).
// C392 R2: `relationship_forget_scan` (read) and `relationship_forget` (destructive), owner only (src/forget.ts).
import { readFileSync } from "node:fs";
import type { Db, HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { documentTitle, forgetPerson, forgetScan, personOf, requireKnownOperator } from "./forget.ts";
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

const fieldsOf = (input: In) => ["type", "identities", "label", "stance", "trust", "verifyIdentities"].filter((k) => input[k] !== undefined);

/** S3-5: at most this many engine pages are purged inside the forget call; the rest stay queued for the drain timer. */
export const INLINE_PURGE_LIMIT = 10;
/** The SDK refuses a hold view over 16 000 characters (hold_view_too_large); the document list is cut well before. */
const CONFIRM_MAX = 15_000;

/**
 * S2: the owner-facing confirmation of a forget: NAMES the person (label, id, operator), states that the delete is
 * permanent, LISTS the documents to delete (area, title, id), the ids that would be refused, and what is not possible
 * yet. Shown to the owner only (the scan answer, a hold view): receipts, the log and the stored forget report keep ids
 * and counts. Plain text; reads only.
 */
export function forgetConfirmation(db: Db, operator: string, person: string, purgeDocuments: readonly string[], done?: ReturnType<typeof forgetScan>): string {
  const p = personOf(db, operator, person);
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE person_id = ? AND operator = ?`).get(person, operator)?.n ?? 0);
  const scan = done ?? forgetScan(db, operator, person);
  const picked = [...new Set(purgeDocuments)];
  const purge = picked.filter((id) => scan.found.has(id));
  const kept = picked.filter((id) => !scan.found.has(id));
  const head = [
    `Forget "${p.label}" (${person}) in the relationships of operator ${operator}.`,
    "This delete is permanent. It cannot be undone, and Knowledge cannot restore it.",
    `Deleted from Relationships: the person, ${count("kn_rel_identities")} identities, ${count("kn_rel_proposals")} proposals, ${count("kn_rel_history")} history items. One log row with counts stays.`,
    "",
    `Documents deleted for good, with every revision, comment and link, and their memory engine pages (${purge.length}):`,
  ];
  const lines: string[] = [];
  let size = head.join("\n").length;
  for (const [i, id] of purge.entries()) {
    const m = scan.found.get(id);
    const line = `- ${m?.area ?? "?"}: "${documentTitle(db, id)}" (${id})${m?.deleted ? ", already deleted in the Library" : ""}`;
    if (size + line.length > CONFIRM_MAX - 2_000) {
      lines.push(`- and ${purge.length - i} more`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (!purge.length) lines.push("- none");
  const tail = [
    ...(kept.length ? ["", `Kept (this forget's scan does not match them, so they are not deleted): ${kept.slice(0, 100).join(", ")}`] : []),
    "",
    `Other documents that name the person and stay: ${scan.found.size - purge.length}.`,
    "",
    "Not possible yet:",
    ...NOT_POSSIBLE_YET.map((n) => `- ${n.store}: ${n.reason}`),
  ];
  return [...head, ...lines, ...tail].join("\n").slice(0, CONFIRM_MAX);
}

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
      redact: (input, output) => {
        const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
        const out = output as { decided?: { state?: string }[]; conflicts?: unknown[] } | undefined;
        const who = `relationship proposals of ${String(input.operator).slice(0, 40)}`;
        if (!Array.isArray(out?.decided)) return `${who}: ${n(input.accept)} to accept, ${n(input.reject)} to reject`;
        const accepted = out.decided.filter((d) => d.state === "accepted").length;
        return `${who}: ${accepted} accepted, ${out.decided.length - accepted} rejected, ${n(out.conflicts)} conflicts`;
      },
      run: (input, ctx) =>
        run(() => {
          ownerOnly(ctx);
          const operator = String(input.operator);
          requireListedOperator(ctx.db, operator);
          const { decided, conflicts } = decideProposals(ctx.db, operator, ctx.caller.id, { accept: input.accept, reject: input.reject });
          return { operator, decided, conflicts };
        }),
    },

    relationship_set: {
      redact: (input) => `relationship of ${String(input.operator).slice(0, 40)} with person ${String(input.person).slice(0, 40)}: set ${fieldsOf(input).join(", ") || "nothing"}`,
      run: (input, ctx) =>
        run(() => {
          ownerOnly(ctx);
          const operator = String(input.operator);
          requireListedOperator(ctx.db, operator);
          const { relationship, changed } = setRelationship(ctx.db, operator, ctx.caller.id, { person: String(input.person), type: input.type, stance: input.stance, trust: input.trust, label: input.label, verifyIdentities: input.verifyIdentities });
          return { operator, relationship, changed };
        }),
    },

    relationship_forget_scan: {
      run: (input, ctx) =>
        run(() => {
          ownerOnly(ctx);
          const operator = String(input.operator);
          requireKnownOperator(ctx.db, operator);
          const person = String(input.person);
          const scan = forgetScan(ctx.db, operator, person);
          const picked = Array.isArray(input.purgeDocuments) ? input.purgeDocuments.map(String) : [];
          return {
            operator,
            person,
            scan: { terms: scan.terms, skippedShort: scan.skippedShort, truncated: scan.truncated },
            matched: scan.matched,
            // the text the owner confirms before relationship_forget (person ops are never held by the SDK: the page shows it)
            confirmation: forgetConfirmation(ctx.db, operator, person, picked, scan),
            notPossibleYet: NOT_POSSIBLE_YET,
          };
        }),
    },

    relationship_forget: {
      redact: (input, output) => {
        const out = output as { documents?: { purged?: unknown[]; pending?: unknown[]; refused?: unknown[] } } | undefined;
        const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
        const who = `person ${String(input.person).slice(0, 40)} of ${String(input.operator).slice(0, 40)}`;
        // no output = the hold summary (the SDK calls redact(input) for a hold): ids and counts only, like the receipt
        if (!out?.documents) return `forget ${who}: ${n(input.purgeDocuments)} documents to delete for good`;
        return `forgot ${who}: ${n(out.documents.purged)} documents purged, ${n(out.documents.pending)} engine pages pending, ${n(out.documents.refused)} refused`;
      },
      // S2: if the SDK holds this call, the owner sees the person's name, the documents and that it is permanent. The handler
      // spec gets the input only, so the view reads the database the app is bound to (synchronous node:sqlite); unbound or
      // unreadable → the ids and the same warning. SDK 0.1.48 never holds a person op (handlePersonOp runs it at once), so
      // today the same text reaches the owner as `confirmation` of relationship_forget_scan, before the page calls forget.
      holdView: (input) => {
        const operator = String(input.operator);
        const person = String(input.person);
        const picked = Array.isArray(input.purgeDocuments) ? input.purgeDocuments.map(String) : [];
        try {
          const db = knowledge.current()?.db;
          if (db) return forgetConfirmation(db, operator, person, picked);
        } catch {
          // fall through to the id-only view
        }
        return [`Forget person ${person} in the relationships of operator ${operator}.`, "This delete is permanent. It cannot be undone.", `Documents to delete for good: ${picked.length ? picked.join(", ") : "none"}.`].join("\n");
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
          // The engine pages of the purged documents: purge them now through the helper; what does not answer, and every page
          // over the inline limit, stays queued (kn_forget_queue, drained by the projection timer) and is reported `engine_pending`.
          // S3-5: at most INLINE_PURGE_LIMIT pages inline (a helper call can take 25 s each); the rest wait for the timer
          const queued = core.purged
            .filter((p) => p.queued)
            .map((p) => p.documentId)
            .slice(0, INLINE_PURGE_LIMIT);
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
