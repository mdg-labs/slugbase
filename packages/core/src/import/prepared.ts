import {
  BOOKMARK_DESCRIPTION_MAX_LENGTH,
  BOOKMARK_TITLE_MAX_LENGTH,
  BOOKMARK_URL_MAX_LENGTH,
  FOLDER_COLOR_MAX,
  FOLDER_COLOR_MIN,
  FOLDER_NAME_MAX_LENGTH,
  IMPORT_MAX_BOOKMARKS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_DISTINCT_NAMES,
  IMPORT_NAME_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
} from "@slugbase/contracts";
import type { ImportBookmark, ImportRefusal, PreparedChoices, PreparedImport, PreparedNames } from "./preview.ts";

// The check of a `PreparedImport` that comes from another thread (doc 10 T13). The import is prepared in a worker thread from the user's file, and what it sends back is data derived from that file, so the thread that
// writes to the database does not trust its shape or its size: every member is checked here, every count and length against the bound the contract and the stored limits give, and anything else is no prepared import. The
// distinct folder and tag spellings are counted again against `IMPORT_MAX_DISTINCT_NAMES` (the bound of the file's names, which the preparation answers as `too_many_distinct_names` first), so a prepared import that is over it is
// refused here and nothing of it reaches the database. A string is cut by code points, so it may be up to twice its limit in UTF-16 units.

type Plain = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: Plain, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, maxCodePoints: number, { empty = true } = {}): value is string {
  return typeof value === "string" && value.length <= maxCodePoints * 2 && (empty || value !== "");
}

function names(value: unknown, maxCodePoints: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= IMPORT_MAX_BYTES && value.every((name) => text(name, maxCodePoints, { empty: false }));
}

function position(value: unknown, expected: number): boolean {
  return value === expected;
}

function isRefusal(value: Plain): boolean {
  return hasOnly(value, ["position", "title", "url", "reason"]) && (value["reason"] === "url_not_allowed" || value["reason"] === "url_invalid") && text(value["title"], BOOKMARK_TITLE_MAX_LENGTH) && text(value["url"], BOOKMARK_URL_MAX_LENGTH);
}

function isSlug(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value["kind"] === "none") {
    return hasOnly(value, ["kind"]);
  }
  if (value["kind"] === "valid") {
    return hasOnly(value, ["kind", "slug"]) && text(value["slug"], BOOKMARK_URL_MAX_LENGTH, { empty: false });
  }
  return value["kind"] === "invalid" && hasOnly(value, ["kind", "text"]) && text(value["text"], BOOKMARK_URL_MAX_LENGTH);
}

function isBookmark(value: Plain): boolean {
  return (
    hasOnly(value, ["position", "url", "canonical", "host", "title", "description", "pinned", "slug", "forwarding", "folders", "tags"]) &&
    text(value["url"], BOOKMARK_URL_MAX_LENGTH / 2, { empty: false }) &&
    text(value["canonical"], BOOKMARK_URL_MAX_LENGTH / 2, { empty: false }) &&
    text(value["host"], BOOKMARK_URL_MAX_LENGTH / 2, { empty: false }) &&
    text(value["title"], BOOKMARK_TITLE_MAX_LENGTH) &&
    (value["description"] === null || text(value["description"], BOOKMARK_DESCRIPTION_MAX_LENGTH)) &&
    typeof value["pinned"] === "boolean" &&
    typeof value["forwarding"] === "boolean" &&
    isSlug(value["slug"]) &&
    names(value["folders"], FOLDER_NAME_MAX_LENGTH) &&
    names(value["tags"], TAG_NAME_MAX_LENGTH)
  );
}

function readReads(value: unknown): (ImportBookmark | ImportRefusal)[] | undefined {
  if (!Array.isArray(value) || value.length > IMPORT_MAX_BOOKMARKS) {
    return undefined;
  }
  const reads: unknown[] = value;
  const ok = reads.every((read, index) => isRecord(read) && position(read["position"], index + 1) && ("reason" in read ? isRefusal(read) : isBookmark(read)));
  return ok ? (reads as (ImportBookmark | ImportRefusal)[]) : undefined;
}

function readNames(value: unknown): PreparedNames | undefined {
  if (!isRecord(value) || !hasOnly(value, ["listedFolders", "listedTags", "folders", "tags"])) {
    return undefined;
  }
  const { listedFolders, listedTags, folders, tags } = value;
  if (
    !Array.isArray(listedFolders) ||
    listedFolders.length > IMPORT_MAX_DISTINCT_NAMES ||
    !listedFolders.every(
      (folder: unknown) =>
        isRecord(folder) &&
        hasOnly(folder, ["name", "icon", "color"]) &&
        text(folder["name"], FOLDER_NAME_MAX_LENGTH, { empty: false }) &&
        text(folder["icon"], IMPORT_NAME_MAX_LENGTH) &&
        typeof folder["color"] === "number" &&
        Number.isInteger(folder["color"]) &&
        folder["color"] >= FOLDER_COLOR_MIN &&
        folder["color"] <= FOLDER_COLOR_MAX,
    ) ||
    !names(listedTags, TAG_NAME_MAX_LENGTH) ||
    !names(folders, FOLDER_NAME_MAX_LENGTH) ||
    !names(tags, TAG_NAME_MAX_LENGTH)
  ) {
    return undefined;
  }
  const listed = listedFolders as PreparedNames["listedFolders"];
  const distinct = new Set([...listed.map((folder) => folder.name), ...folders]).size + new Set([...listedTags, ...tags]).size;
  return distinct > IMPORT_MAX_DISTINCT_NAMES ? undefined : { listedFolders: listed, listedTags, folders, tags };
}

function readChoices(value: unknown): PreparedChoices | undefined {
  if (!isRecord(value) || !hasOnly(value, ["refs", "preferences"])) {
    return undefined;
  }
  const { refs, preferences } = value;
  if (
    !Array.isArray(refs) ||
    refs.length > IMPORT_MAX_BOOKMARKS ||
    !refs.every((ref: unknown) => isRecord(ref) && hasOnly(ref, ["ref", "place"]) && text(ref["ref"], IMPORT_NAME_MAX_LENGTH / 2) && (ref["place"] === null || (Number.isInteger(ref["place"]) && (ref["place"] as number) >= 1 && (ref["place"] as number) <= IMPORT_MAX_BOOKMARKS))) ||
    !Array.isArray(preferences) ||
    preferences.length > IMPORT_MAX_BOOKMARKS ||
    !preferences.every((preference: unknown) => isRecord(preference) && hasOnly(preference, ["slug", "bookmarkRef"]) && text(preference["slug"], IMPORT_NAME_MAX_LENGTH / 2) && text(preference["bookmarkRef"], IMPORT_NAME_MAX_LENGTH / 2))
  ) {
    return undefined;
  }
  return { refs: refs as PreparedChoices["refs"], preferences: preferences as PreparedChoices["preferences"] };
}

/** The prepared import `value` is, or undefined when it is none: not of the shape `prepareImport` makes, or over a bound of the contract. Nothing in `value` is changed or trusted before this answers. */
export function readPreparedImport(value: unknown): PreparedImport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["kind"] === "too_many_distinct_names") {
    const count = value["names"];
    return hasOnly(value, ["kind", "names"]) && typeof count === "number" && Number.isInteger(count) && count > IMPORT_MAX_DISTINCT_NAMES ? { kind: "too_many_distinct_names", names: count } : undefined;
  }
  if (value["kind"] !== "ready" || !hasOnly(value, ["kind", "reads", "names", "choices"])) {
    return undefined;
  }
  const reads = readReads(value["reads"]);
  const fileNames = readNames(value["names"]);
  const choices = readChoices(value["choices"]);
  return reads === undefined || fileNames === undefined || choices === undefined ? undefined : { kind: "ready", reads, names: fileNames, choices };
}
