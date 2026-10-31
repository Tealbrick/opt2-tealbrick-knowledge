// The filter of the long area lists (C382 batch 4): the area pickers on Library, Recall and Research, and the areas
// tables on Memory status and Settings. The areas load in full (no pages), so every filter here reads all of them and
// the bar says so. A filter always shows "Showing N of M" and Clear; a remembered filter shows again after a reload.
import { accessFilter, Field, type FilterNoun, ListFilter, Select, useAccessFilter } from "@opt2-tealbrick/ui";
import type { ReactNode } from "react";

/** A list shorter than this shows no filter bar, unless a remembered filter is on. */
export const FILTER_FROM = 8;

/** What this browser remembers is per app (the base path of the app) and per screen. */
export const filterKey = (page: string) => {
  try {
    return `tb-filter:${new URL(document.baseURI).pathname}:${page}`;
  } catch {
    return `tb-filter:${page}`;
  }
};

const AREAS: FilterNoun = { one: "memory area", many: "memory areas" };

/** Rows that pass a remembered text filter, and the bar that says a filter is on. `bar` is null for a short list. */
export function useRowFilter<T>(page: string, rows: readonly T[], textOf: (row: T) => string, label: string, noun: FilterNoun = AREAS): { shown: T[]; bar: ReactNode } {
  const [query, setQuery] = useAccessFilter(filterKey(page));
  const filter = accessFilter(query);
  const shown = rows.filter((r) => filter.test(textOf(r)));
  const on = query.trim() !== "";
  const bar =
    rows.length >= FILTER_FROM || on ? <ListFilter label={label} value={query} onChange={setQuery} filter={filter} noun={noun} shown={shown.length} total={rows.length} onClear={() => setQuery("")} /> : null;
  return { shown, bar };
}

type AreaChoice = { id: string; label: string };

/**
 * An area picker with a filter on the choices. The chosen area stays in the list even when the filter hides it, so the
 * choice never changes by typing. `extra` choices (such as "All areas") are always offered. Single choice: there is no
 * "select all" here.
 */
export function AreaPicker({
  page,
  label,
  areas,
  value,
  onChange,
  extra = [],
}: {
  /** the screen, for the remembered filter */
  page: string;
  label: string;
  areas: readonly AreaChoice[];
  value: string;
  onChange: (value: string) => void;
  extra?: { value: string; label: string }[];
}) {
  const { shown, bar } = useRowFilter(`${page}:area`, areas, (a) => a.label, `Filter the ${label.toLowerCase()}s`);
  const options = [...extra, ...areas.filter((a) => a.id === value || shown.includes(a)).map((a) => ({ value: a.id, label: a.label }))];
  return (
    <div className="tb-stack kn-areapick">
      {bar}
      <div className="kn-area">
        <Field label={label}>
          <Select options={options} value={value} onValueChange={onChange} />
        </Field>
      </div>
    </div>
  );
}
