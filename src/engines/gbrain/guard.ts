// Argument guard applied before any upstream GBrain call; returns a refusal reason or null.
const RESERVED_PAGE_PREFIXES = ["knowledge-docs/"];
const PAGE_CONTENT_WRITES = new Set(["put_page", "delete_page", "restore_page", "edit_page", "revert_version", "capture", "put_raw_data", "append_page", "begin_page_upload"]);
const FORCE_WRITES = new Set(["put_page", "remember", "capture", "edit_page", "revert_version", "delete_page", "restore_page"]);

const reservedSlug = (slug: unknown) => typeof slug === "string" && RESERVED_PAGE_PREFIXES.some((prefix) => slug.toLowerCase().startsWith(prefix));

export function argumentRefusal(operation: string, args: Record<string, unknown>): string | null {
  const present = (key: string) => Object.hasOwn(args, key) && args[key] !== undefined && args[key] !== null;
  if (Object.hasOwn(args, "source_id") || Object.hasOwn(args, "source_ids")) return "source_id is selected by Knowledge from the area";
  // 0.60.424.0 (C336 M2): arguments that name engine sources directly
  if (Object.hasOwn(args, "prefer_source_id") || Object.hasOwn(args, "entity_refs")) return "engine sources are selected by Knowledge from the area; pass entity names instead";
  if (["remember", "extract_facts", "ontology_propose"].includes(operation) && args.visibility === "private") {
    return "private visibility is not available; memory in an area is shared by everyone who may read the area";
  }
  if (operation === "capture" && Object.hasOwn(args, "local_file")) return "local_file reads the engine host filesystem";
  if (operation === "extract_entities" && args.trusted_extraction === true) return "trusted_extraction bypasses upstream review";
  if (present("image_path")) return "image_path reads the engine host filesystem";
  if (present("local_dir")) return "local_dir reads the engine host filesystem";
  // SEC-10: the token's source binding is the first wall; these flags would ask upstream to look past it.
  if (present("all_sources") && args.all_sources !== false) return "all_sources would read other areas; Knowledge reads only the areas you may read";
  if (present("include_private") && args.include_private !== false) return "include_private is not available; private facts are never exposed";
  if (present("purge") && args.purge !== false) return "purge skips the soft delete; deletes stay recoverable";
  if (operation.startsWith("takes_") && present("holder") && args.holder !== "world") return "only the world holder is available";
  if (FORCE_WRITES.has(operation) && present("force") && args.force !== false) return "force bypasses revision checks";
  // SEC-10: the engine would fetch the URL from inside the private network (SSRF surface we cannot verify upstream).
  if (present("image_url")) return "image_url is not fetched; pass the image inline as image_data";
  if ((operation === "think" || operation === "synthesize") && present("model")) return "model selection belongs to the deployment settings";
  if (operation === "think" && ((present("save") && args.save !== false) || (present("take") && args.take !== false))) return "think may not persist takes or pages";
  if (operation === "get_calibration_profile" && present("holder")) return "only the default calibration holder is available";
  if (operation === "put_pages" && Array.isArray(args.pages) && args.pages.some((page) => reservedSlug((page as { slug?: unknown } | null)?.slug))) {
    return "pages under knowledge-docs/ mirror Knowledge documents; change the document instead";
  }
  if (PAGE_CONTENT_WRITES.has(operation) && typeof args.slug === "string" && RESERVED_PAGE_PREFIXES.some((prefix) => String(args.slug).toLowerCase().startsWith(prefix))) {
    return "pages under knowledge-docs/ mirror Knowledge documents; change the document instead";
  }
  return null;
}
