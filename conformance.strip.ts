// C380: the guarded companion ops (`listing: "workflow"`, no_access for everyone but the listed Governance app) are not
// driveable by the suite (conformance <= 0.1.30 does not filter `listing`: A12.companion_inbound, A12.caller_unverified_refused
// and A14.hold_retry_once pick them as the first agent op and fail on the guard). The harness serves the shipped manifest
// WITHOUT them; the guard has its own unit tests (test/tb-access.test.ts). Remove this file when conformance filters
// `listing: "workflow"` from agentOps.
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

export const GUARDED_OPS: readonly string[] = ["access_list", "access_revoke"];

/** tealbrick.manifest.json minus the guarded ops (a copy). */
export function conformanceManifest(m: Manifest): Manifest {
  return { ...m, operations: m.operations.filter((o) => !GUARDED_OPS.includes(o.id)) };
}
