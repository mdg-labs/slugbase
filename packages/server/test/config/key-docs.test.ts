import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  OIDC_OPTIONAL_FIELDS,
  OIDC_REQUIRED_FIELDS,
  PROCESS_TYPES,
  declaredKeys,
  envSchemas,
  type ProcessType,
} from "../../src/config/index.ts";
import { KEY_DOCS, KEY_GROUPS, oidcKeyDocs, type KeyDoc } from "../../src/config/key-docs.ts";

function fieldOf(type: ProcessType, key: string) {
  const shape: Readonly<Record<string, z.ZodType | undefined>> = envSchemas[type].object.shape;
  const field = shape[key];
  if (field === undefined) {
    throw new Error(`${type} declares no ${key}`);
  }
  return field;
}

function readers(key: string): ProcessType[] {
  return PROCESS_TYPES.filter((type) => envSchemas[type].keys.includes(key));
}

/** Whether every process that reads `key` accepts `value` for it. */
function accepted(key: string, value: string): boolean {
  return readers(key).every((type) => fieldOf(type, key).safeParse(value).success);
}

const entries = Object.entries(KEY_DOCS);

describe("the documentation of the environment keys", () => {
  it("has an entry for every key a process schema declares, and no other", () => {
    expect(Object.keys(KEY_DOCS).sort()).toEqual([...declaredKeys()]);
  });

  it("puts every key in a known group, and every group has a key", () => {
    for (const [key, doc] of entries) {
      expect(KEY_GROUPS, key).toContain(doc.group);
    }
    for (const group of KEY_GROUPS) {
      expect(entries.some(([, doc]) => doc.group === group), group).toBe(true);
    }
  });

  it("describes a key in one line of Markdown that holds no raw angle bracket, brace or pipe outside a code span", () => {
    for (const [key, doc] of entries) {
      expect(doc.description, key).not.toMatch(/\n/);
      expect(doc.description, key).toMatch(/\.$/);
      const outsideCode = doc.description.replace(/`[^`]*`/g, "");
      expect(outsideCode, key).not.toMatch(/[<>{}|]/);
    }
  });

  it("gives no secret a default or an example value", () => {
    const secretName = /(?:KEY|SECRET|PASS|PASSWORD|TOKEN|DSN)$/;
    for (const [key, doc] of entries) {
      if (!secretName.test(key)) {
        continue;
      }
      expect(doc.defaultText, key).toBeUndefined();
      for (const [, span] of doc.description.matchAll(/`([^`]*)`/g)) {
        // A code span of a secret's description is a placeholder, a key name or a fixed word.
        expect(span, key).toMatch(/^(?:<[^<>]+>(?::<[^<>]+>)?|[A-Za-z_./:@ -]{1,40}|\/v1|\/chat\/completions)$/);
      }
    }
  });

  describe("types", () => {
    const ofKind = (kind: KeyDoc["type"]["kind"]) => entries.filter(([, doc]) => doc.type.kind === kind);

    it.each(ofKind("boolean"))("%s is parsed as a boolean", (key) => {
      for (const value of ["true", "false", "1", "0"]) {
        expect(accepted(key, value), `${key}=${value}`).toBe(true);
      }
      for (const value of ["yes", "False", "2"]) {
        expect(accepted(key, value), `${key}=${value}`).toBe(false);
      }
    });

    it.each(ofKind("integer"))("%s is a whole number within its bounds", (key, doc) => {
      if (doc.type.kind !== "integer") {
        throw new Error("not an integer");
      }
      const { min, max } = doc.type;
      expect(accepted(key, String(min))).toBe(true);
      expect(accepted(key, String(max))).toBe(true);
      expect(accepted(key, String(max + 1))).toBe(false);
      if (min > 0) {
        expect(accepted(key, String(min - 1))).toBe(false);
      }
      expect(accepted(key, "1.5")).toBe(false);
    });

    it.each(ofKind("enum"))("%s accepts exactly its options", (key, doc) => {
      if (doc.type.kind !== "enum") {
        throw new Error("not an enum");
      }
      for (const option of doc.type.options) {
        expect(accepted(key, option), option).toBe(true);
      }
      expect(accepted(key, "not-an-option")).toBe(false);
    });

    it.each(ofKind("rate"))("%s is a count and a period", (key) => {
      expect(accepted(key, "5/hour")).toBe(true);
      expect(accepted(key, "0/min")).toBe(false);
      expect(accepted(key, "5/day")).toBe(false);
    });
  });

  describe("required", () => {
    it("gives a requiredWhen note only to a key that is optional in some process", () => {
      for (const [key, doc] of entries) {
        if (doc.requiredWhen === undefined) {
          continue;
        }
        const optional = readers(key).some((type) => fieldOf(type, key).safeParse(undefined).success);
        expect(optional, `${key} is required in every process, so it needs no requiredWhen`).toBe(true);
      }
    });
  });

  it("documents every OIDC_<SLUG>_* field, the required ones first", () => {
    const docs = oidcKeyDocs();
    expect(docs.map((doc) => doc.field)).toEqual([...OIDC_REQUIRED_FIELDS, ...OIDC_OPTIONAL_FIELDS]);
    expect(docs.filter((doc) => doc.required).map((doc) => doc.field)).toEqual([...OIDC_REQUIRED_FIELDS]);
    for (const doc of docs) {
      expect(doc.defaultText === undefined, doc.field).toBe(doc.required);
      expect(doc.description, doc.field).not.toMatch(/\n/);
    }
  });
});
