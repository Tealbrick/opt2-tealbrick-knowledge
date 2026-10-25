// Shared helpers for the owner pages (Library, Recall, Research): error text, debounce, op calls, delete confirmation.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Notice, type Status as TagStatus } from "@opt2-tealbrick/ui";
import { type ReactNode, useEffect, useState } from "react";

export type Status = "draft" | "published" | "archived";
type Value = string | number | boolean | string[];

/** Drop undefined values so optional op inputs stay out of the request. */
export function input(fields: Record<string, Value | undefined>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}

export const run = <O,>(op: string, fields: Record<string, Value | undefined> = {}, create = false) =>
  callOp<O>(op, input(fields), create ? { idempotencyKey: crypto.randomUUID() } : undefined);

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export function isConflict(e: unknown): boolean {
  return e instanceof Error && (e as { code?: unknown }).code === "version_conflict";
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ErrorNotice({ error }: { error: string | null }) {
  return error ? (
    <Notice tone="needs-you" role="alert">
      {error}
    </Notice>
  ) : null;
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="tb-soft" role="status">
      Loading {what}.
    </p>
  );
}

// Dates in the one form of the approved mockups (C185 D5): British order, 24-hour clock, the same for every owner.
// A fixed month list, because Intl en-GB writes "Sept" where the mockups show "Sep".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toDate = (ms: number | string | null | undefined): Date | null => {
  if (!ms) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
};
const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "10 Oct" (a list hint). */
export const dayMonth = (ms: number | string | null | undefined) => {
  const d = toDate(ms);
  return d ? day(d) : "";
};

/** "13 Oct, 09:12" (a table cell). */
export const whenShort = (ms: number | string | null | undefined) => {
  const d = toDate(ms);
  return d ? `${day(d)}, ${clock(d)}` : "";
};

/** "14 Oct 2026, 10:00". */
export const when = (ms: number | string | null | undefined) => {
  const d = toDate(ms);
  return d ? `${day(d)} ${d.getFullYear()}, ${clock(d)}` : "";
};

/** Document status as a kit Tag status: published = live, draft = busy, archived = plain. */
export function statusTag(status: string): TagStatus {
  return status === "published" ? "live" : status === "draft" ? "busy" : "default";
}

/** Confirmation before any delete. `what` completes "This removes ...". */
export function ConfirmDelete({
  open,
  title,
  what,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  what: ReactNode;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      <p>This removes {what} from memory search. You can’t undo this here.</p>
    </Dialog>
  );
}

/** Untrusted text shown as preformatted, wrapping text. Never HTML. */
export function TextBlock({ text, label }: { text: string; label: string }) {
  return (
    <section aria-label={label}>
      <pre className="kn-text">{text}</pre>
    </section>
  );
}

/** Area picker used by Library, Recall and Research. */
export interface AreaOption {
  id: string;
  label: string;
  kind: "agent" | "shared";
  documents?: number;
  collections?: number;
  engineReady: boolean;
  researchReady: boolean;
}

/** QA F89: the memory engine's last known state; `attention` is set while the owner should act. */
export interface EngineState {
  state: "unknown" | "starting" | "ok" | "degraded" | "failing";
  attention: { code: string; reason: string } | null;
}

export function useOverview() {
  const [areas, setAreas] = useState<AreaOption[] | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    run<{ areas: AreaOption[]; engine?: EngineState }>("library_overview")
      .then((r) => {
        setAreas(r.areas);
        setEngine(r.engine ?? null);
      })
      .catch((e: unknown) => setError(errText(e)));
  }, []);
  return { areas, engine, error };
}

/** Page heading of the app's own pages (the standard pages draw the same one). */
export function PageHead({ title, lede }: { title: string; lede?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {lede ? <p className="tb-lede">{lede}</p> : null}
    </div>
  );
}
