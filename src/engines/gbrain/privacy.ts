// Knowledge-side enforcement of GBrain privacy behaviour that unmodified upstream (seen at v0.60.57.0; kept as defence in depth at later pins) lacks.
// Applied to every result before it leaves Knowledge; each rule fails closed.
//   A1-A3  private facts are never written (refused by the argument guard), so supersession only touches world facts.
//   A4     sources are created without a local path, so forget's fence mirror never runs.
//   A6     pending_consolidation_count is withheld (it counts private facts too).
//   A7     every facts/takes privacy fence is stripped; nested, overlapping or unclosed fences drop all they could contain.
//   A9     rows naming another source are dropped.
//   A13    open_loops are withheld (evidence visibility is not provable).
const FENCE = /<!---\s*gbrain:(facts|takes):(begin|end)\s*-->/giu;
const WITHHELD_KEYS = new Set(["pending_consolidation_count", "open_loops"]);
const MAX_DEPTH = 64;

/** Remove every privacy fence region in one forward pass (A7). */
export function stripPrivacyFences(text: string): string {
  if (!/gbrain:/iu.test(text)) return text;
  let output = "";
  let depth = 0;
  let cursor = 0;
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(text); match; match = FENCE.exec(text)) {
    if (depth === 0) output += text.slice(cursor, match.index);
    if (match[2]?.toLowerCase() === "begin") depth++;
    else if (depth > 0) depth--;
    cursor = match.index + match[0].length;
  }
  // An unclosed fence hides everything after it.
  return depth === 0 ? output + text.slice(cursor) : output;
}

function foreignSource(value: Record<string, unknown>, sourceId: string): boolean {
  return Object.entries(value).some(([key, item]) => /(?:^|_)source_id$/u.test(key) && typeof item === "string" && item !== "__all__" && item !== sourceId);
}

/** Deep-sanitize a GBrain result for the caller's single source (A6, A7, A9, A13). */
export function sanitizeResult(data: unknown, sourceId: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof data === "string") return stripPrivacyFences(data);
  if (Array.isArray(data)) {
    return data
      .filter((item) => !(item && typeof item === "object" && !Array.isArray(item) && foreignSource(item as Record<string, unknown>, sourceId)))
      .map((item) => sanitizeResult(item, sourceId, depth + 1));
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    // A single object that names another source is withheld as a whole (v1 checked only list items).
    if (depth === 0 && foreignSource(record, sourceId)) return null;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !WITHHELD_KEYS.has(key))
        .map(([key, value]) => [key, sanitizeResult(value, sourceId, depth + 1)]),
    );
  }
  return data;
}

/** Canonical text is content, never GBrain structure: escape literal fence markers before projection. */
export function neutralizeFenceMarkers(markdown: string): string {
  return markdown.replace(/<!---(\s*gbrain:)/giu, "&lt;!---$1");
}
