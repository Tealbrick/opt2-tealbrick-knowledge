// Area access of one call (C373): the SDK scope rows for agent and company areas (unchanged) plus the person and team
// areas Knowledge governs from the Governance directory copy (src/people.ts). Every handler asks this object, never
// ctx.scope directly, so the two sources cannot drift apart.
import type { CrudAction } from "@opt2-tealbrick/spec/manifest";
import type { OpContext } from "@opt2-tealbrick/spec/sdk";
import { AREA_SCOPE, type Areas } from "./areas.ts";
import { agentAreaId } from "./ids.ts";
import { type AgentView, type GovernedArea, isGovernedArea, personAreaId, viewFor } from "./people.ts";

export interface AreaAccess {
  /** may the caller do `crud` in the area (a tag-limited grant counts as read; item ops apply the limit) */
  can(area: string, crud: CrudAction): Promise<boolean>;
  /** areas the caller may read; `items` = the op filters item by item, so tag-limited grant areas are included */
  readable(items: boolean): Promise<string[]>;
  /** tag limit of a granted person area (null = none): a memory needs at least one of these tags */
  limit(area: string): string[] | null;
  /** where a write without `area` goes: the owner's person area when the agent has an owner, else its own agent area */
  defaultArea(): string | null;
  /** the governed part (agents only; null for person and app callers) */
  view: AgentView | null;
  governed(area: string): GovernedArea | null;
}

export function areaAccess(ctx: OpContext, areas: Areas): AreaAccess {
  const caller = ctx.caller;
  const sdkReadable = async () => (await ctx.scope.readable(AREA_SCOPE)).filter((id) => !isGovernedArea(id));
  if (caller.type === "person") {
    // the workspace owner reads and curates every area (as before C373)
    return {
      can: (area, crud) => ctx.scope.can(AREA_SCOPE, area, crud),
      readable: async () => areas.list().map((a) => a.id),
      limit: () => null,
      defaultArea: () => null,
      view: null,
      governed: () => null,
    };
  }
  if (caller.type !== "agent") {
    // a companion app: SDK rows only; person and team memory is never shared with an app
    return {
      can: async (area, crud) => !isGovernedArea(area) && ctx.scope.can(AREA_SCOPE, area, crud),
      readable: sdkReadable,
      limit: () => null,
      defaultArea: () => null,
      view: null,
      governed: () => null,
    };
  }
  const view = viewFor(ctx.db, areas, caller.id);
  const byArea = new Map(view.areas.map((a) => [a.area, a]));
  return {
    async can(area, crud) {
      if (!isGovernedArea(area)) return ctx.scope.can(AREA_SCOPE, area, crud);
      const g = byArea.get(area);
      if (!g) return false;
      return crud === "read" || g.access === "read_write";
    },
    async readable(items) {
      const governed = view.areas.filter((g) => (items || g.tags === null) && areas.get(g.area) !== null).map((g) => g.area);
      return [...new Set([...(await sdkReadable()), ...governed])];
    },
    limit: (area) => byArea.get(area)?.tags ?? null,
    defaultArea: () => (view.owner ? personAreaId(view.owner) : agentAreaId(caller.id)),
    view,
    governed: (area) => byArea.get(area) ?? null,
  };
}
