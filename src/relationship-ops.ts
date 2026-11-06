// Relationship operations (C392 R1) over the store in src/relationships.ts.
// Agent ops (relationships_list, relationship_get, relationship_propose): the operator is the calling agent's owner in the
// Governance directory copy; nothing names an operator in the input, so an agent can never reach another operator's people.
// Person ops (relationships_overview, relationship_confirm, relationship_set): the workspace owner, naming the operator.
// The agent ops declare scopeType `area` like every other Knowledge agent op (mirrors `remember`) with no target instance:
// the SDK checks the agent's best area access, so an agent the owner left without write access anywhere cannot propose.
// Receipts (`redact`) carry ids, field names and counts only: never an identity value, a label, a stance or history text.
import type { HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { decideProposals, getRelationship, listRelationships, operatorForAgent, propose, RelationshipError, type RelType, relationshipsOverview, requireListedOperator, setRelationship } from "./relationships.ts";

type In = Record<string, any>;

export interface RelationshipDeps {
  wrap<T>(fn: () => Promise<T>): Promise<T>;
  fail(code: string, message: string, status: number): Error;
}

export const RELATIONSHIP_OPS = ["relationships_list", "relationship_get", "relationship_propose", "relationships_overview", "relationship_confirm", "relationship_set"] as const;

const fieldsOf = (input: In) => ["type", "identities", "label", "stance", "trust"].filter((k) => input[k] !== undefined);

export function createRelationshipHandlers(d: RelationshipDeps): Record<string, HandlerSpec<In, Json>> {
  const { wrap, fail } = d;
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
  };
}
