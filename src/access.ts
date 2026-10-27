// Owner (person) operations behind the Access page (C373): people → their memory area, teams → members and grants, and
// the owner's grants "team T may read person P's area". Plain words; ids only for people (the Governance feed carries no
// person names), agent names from Knowledge's own agent areas, team names from the feed. Never handles or trust (C88).
import type { HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { type CallApp, type DirectoryStatus, directoryState, refreshIfStale } from "./directory-feed.ts";
import type { Services } from "./knowledge.ts";
import { accessLog, GrantError, listGrants, personAreaId, removeGrant, setGrant, teamAreaId } from "./people.ts";

type In = Record<string, any>;

export interface AccessDeps {
  services(ctx: OpContext): Services;
  wrap<T>(fn: () => Promise<T>): Promise<T>;
  fail(code: string, message: string, status: number): Error;
}

/** What the Access page says about the directory, in plain words (C373: Knowledge needs Governance 0.3.0 or newer). */
export const DIRECTORY_NOTES: Record<DirectoryStatus, string> = {
  ready: "Knowledge follows the Governance directory: each person's agents share that person's memory, and team members' agents read their team's memory.",
  never: "Knowledge has not read the Governance directory yet. Until it does, each agent has only its own memory and the company memory.",
  needs_update: "Governance refuses to share its directory with Knowledge. Update Governance to 0.3.0. Until then, each agent has only its own memory and the company memory.",
  not_connected: "Governance is not installed or not connected to Knowledge. Each agent has only its own memory and the company memory.",
  refused: "Governance sent a directory that Knowledge cannot read safely. Each agent has only its own memory and the company memory until a good read.",
  unreachable: "Knowledge cannot reach Governance now. It keeps the last directory for 10 minutes; after that each agent has only its own memory and the company memory.",
};

const AGENT_SUFFIX = / \(own memory\)$/u;

export function createAccessHandlers(d: AccessDeps): Record<string, HandlerSpec<In, Json>> {
  const { services, wrap, fail } = d;
  const grantFail = (error: unknown) => {
    if (error instanceof GrantError) throw fail(error.code, error.message, error.httpStatus);
    throw error;
  };

  return {
    access_overview: {
      run: (_input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          // the owner's page may read Governance (a person op, never an agent call); bounded wait
          await refreshIfStale(ctx.db, ((product, op, input) => ctx.callApp(product, op, input)) as CallApp).catch(() => undefined);
          const state = directoryState(ctx.db);
          const model = state.model;
          const agentNames = new Map(s.areas.list().flatMap((a) => (a.kind === "agent" && a.agentId ? [[a.agentId, a.label.replace(AGENT_SUFFIX, "")] as const] : [])));
          const counts = new Map(ctx.db.prepare("SELECT area_id, count(*) AS n FROM kn_documents WHERE deleted_at IS NULL GROUP BY area_id").all().map((r) => [String(r.area_id), Number(r.n)]));
          const agentRef = (id: string) => ({ id, name: agentNames.get(id) ?? "Agent not connected to Knowledge" });
          const grants = listGrants(ctx.db);
          const teamName = new Map((model?.teams ?? []).map((t) => [t.id, t.name]));
          const people = (model?.people ?? []).map((p) => {
            const area = personAreaId(p.id);
            return {
              id: p.id,
              active: p.active,
              area,
              areaExists: s.areas.get(area) !== null,
              documents: counts.get(area) ?? 0,
              agents: (model?.agents ?? []).filter((a) => a.owner === p.id).map((a) => agentRef(a.id)),
              readBy: grants.filter((g) => g.person === p.id).map((g) => ({ team: g.team, teamName: teamName.get(g.team) ?? g.team, tags: g.tags })),
            };
          });
          const teams = (model?.teams ?? []).map((t) => {
            const area = teamAreaId(t.id);
            return {
              id: t.id,
              name: t.name,
              area,
              areaExists: s.areas.get(area) !== null,
              documents: counts.get(area) ?? 0,
              people: t.people,
              agents: t.agents.map(agentRef),
              grants: grants.filter((g) => g.team === t.id).map((g) => ({ person: g.person, tags: g.tags })),
            };
          });
          const owned = new Set((model?.agents ?? []).filter((a) => a.owner).map((a) => a.id));
          return {
            directory: { status: state.status, available: state.available, note: DIRECTORY_NOTES[state.status], revision: state.revision, syncedAt: state.syncedAt, checkedAt: state.checkedAt },
            people,
            teams,
            agentsWithoutOwner: [...agentNames.keys()].filter((id) => !owned.has(id)).map(agentRef),
            grants: grants.map((g) => ({ ...g, teamName: teamName.get(g.team) ?? g.team })),
            log: accessLog(ctx.db),
          } as unknown as Json;
        }),
    },

    access_grant_set: {
      redact: (input) => `team ${String(input.team).slice(0, 40)} may read person ${String(input.person).slice(0, 40)}${Array.isArray(input.tags) && input.tags.length ? ` (tags: ${input.tags.join(", ").slice(0, 80)})` : ""}`,
      run: (input, ctx) =>
        wrap(async () => {
          try {
            const { grant, changed } = setGrant(ctx.db, { team: String(input.team), person: String(input.person), tags: Array.isArray(input.tags) ? input.tags.map(String) : null, actor: ctx.caller.id });
            return { team: grant.team, person: grant.person, tags: grant.tags, changed } as unknown as Json;
          } catch (error) {
            return grantFail(error);
          }
        }),
    },

    access_grant_remove: {
      redact: (input) => `team ${String(input.team).slice(0, 40)} no longer reads person ${String(input.person).slice(0, 40)}`,
      run: (input, ctx) =>
        wrap(async () => {
          const removed = removeGrant(ctx.db, { team: String(input.team), person: String(input.person), actor: ctx.caller.id });
          return { team: String(input.team), person: String(input.person), removed };
        }),
    },
  };
}
