import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_ACTION_NAMES, type AuditMetadataField } from "../../src/index.ts";

// The audit log is read by administrators who have no implicit access to a member's content, and its metadata is a closed object (doc 10 T7, doc 02
// section 10): an action carries names, identifiers and counts, never free-form content. This walks the whole catalog, so an action added later cannot
// declare a field in which a secret, an address, a URL or a title could travel.

/** Field names that suggest personal data, a credential or content of a member's. */
const SUGGESTIVE_NAME = /url|email|token|secret|password|title|href|body/i;

/** The longest a `text` field may be: a name is the most an event says, and the longest names the catalog holds have 100 characters (a member's display name). */
const LONGEST_TEXT = 100;

const fields = AUDIT_ACTION_NAMES.flatMap((action) =>
  Object.entries<AuditMetadataField>(AUDIT_ACTIONS[action].metadata).map(([name, field]) => ({ action, name, field, label: `${action} ${name}` })),
);

describe("the metadata the audit catalog declares", () => {
  it("walks every field of every action", () => {
    expect(fields.length).toBeGreaterThan(AUDIT_ACTION_NAMES.length);
  });

  it("names no field after a secret, an address, a URL or a title", () => {
    expect(fields.filter(({ name }) => SUGGESTIVE_NAME.test(name)).map(({ label }) => label)).toEqual([]);
  });

  it("holds no text field longer than 100 characters", () => {
    expect(fields.filter(({ field }) => field.type === "text" && field.maxLength > LONGEST_TEXT).map(({ label }) => label)).toEqual([]);
  });

  it("recognises the names it guards against and lets the names the catalog uses through", () => {
    for (const name of ["url", "email", "inviteeEmail", "token", "apiToken", "secret", "password", "title", "bookmarkTitle", "href", "body", "requestBody"]) {
      expect(SUGGESTIVE_NAME.test(name), name).toBe(true);
    }
    for (const name of ["name", "from", "to", "role", "count", "targetId", "targetName", "transferTo"]) {
      expect(SUGGESTIVE_NAME.test(name), name).toBe(false);
    }
  });
});
