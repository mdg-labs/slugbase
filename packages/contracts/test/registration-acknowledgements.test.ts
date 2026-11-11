import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { RegisterRequestSchema } from "../src/operations/auth.ts";
import { operations } from "../src/operations/index.ts";
import { AcceptInvitationRequestSchema } from "../src/operations/invitations.ts";
import { RegistrationAcknowledgementsSchema } from "../src/operations/acknowledgements.ts";

type Obj = Record<string, unknown>;

const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
const schemas = (document["components"] as { schemas: Record<string, Obj> }).schemas;

const register = { displayName: "Ada", email: "ada@example.test", password: "a long enough password" };
const form = { token: "a-token", displayName: "Ada", password: "a long enough password" };
const ok = { id: "terms", version: "2026-01" };

function many(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `doc-${String(index)}`, version: "1" }));
}

const violations: readonly (readonly [string, unknown])[] = [
  ["more than 8 entries", many(9)],
  ["an id with an upper-case letter", [{ ...ok, id: "Terms" }]],
  ["an id with a space", [{ ...ok, id: "the terms" }]],
  ["an empty id", [{ ...ok, id: "" }]],
  ["an id of 33 characters", [{ ...ok, id: "x".repeat(33) }]],
  ["a repeated id", [ok, { id: "terms", version: "2" }]],
  ["an empty version", [{ ...ok, version: "" }]],
  ["a version of 33 characters", [{ ...ok, version: "v".repeat(33) }]],
  ["a version with a control character", [{ ...ok, version: "1\u0007" }]],
  ["a version with a newline", [{ ...ok, version: "1\n2" }]],
  ["a version with NUL", [{ ...ok, version: "1\u0000" }]],
  ["an unknown key inside an entry", [{ ...ok, note: "x" }]],
  ["an entry with no version", [{ id: "terms" }]],
  ["an entry that is not an object", ["terms"]],
  ["a value that is not a list", ok],
];

describe("RegistrationAcknowledgementsSchema", () => {
  it("accepts the empty list, 8 entries and the bounds of an entry", () => {
    expect(RegistrationAcknowledgementsSchema.safeParse([]).success).toBe(true);
    expect(RegistrationAcknowledgementsSchema.safeParse(many(8)).success).toBe(true);
    expect(RegistrationAcknowledgementsSchema.safeParse([{ id: "a_b-9".padEnd(32, "x"), version: "v".repeat(32) }]).success).toBe(true);
    expect(RegistrationAcknowledgementsSchema.safeParse([{ id: "x", version: "1" }]).success).toBe(true);
  });

  it("is published as a component with the bounds in the document", () => {
    const list = schemas["RegistrationAcknowledgements"] as { type: string; maxItems: number };
    expect(list.type).toBe("array");
    expect(list.maxItems).toBe(8);
    const entry = schemas["RegistrationAcknowledgement"] as { additionalProperties: unknown; required: string[]; properties: Record<string, Obj> };
    expect(entry.additionalProperties).toBe(false);
    expect([...entry.required].sort()).toEqual(["id", "version"]);
    expect(entry.properties["version"]).toMatchObject({ minLength: 1, maxLength: 32 });
  });

  it("names the entry that repeats an id", () => {
    const result = RegistrationAcknowledgementsSchema.safeParse([ok, { id: "other", version: "1" }, { id: "terms", version: "2" }]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([2, "id"]);
  });
});

describe("the request bodies that carry acknowledgements", () => {
  it("lists the field as optional on both bodies", () => {
    for (const name of ["RegisterRequest", "AcceptInvitationRequest"]) {
      const body = schemas[name] as { properties: Obj; required?: string[] };
      expect(Object.keys(body.properties)).toContain("acknowledgements");
      expect(body.required ?? []).not.toContain("acknowledgements");
    }
  });

  it("registers with no field, an empty list or a list within the bounds", () => {
    expect(RegisterRequestSchema.safeParse(register).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...register, acknowledgements: [] }).success).toBe(true);
    expect(RegisterRequestSchema.parse({ ...register, acknowledgements: [ok] }).acknowledgements).toEqual([ok]);
    expect(RegisterRequestSchema.safeParse({ ...register, acknowledgements: many(8) }).success).toBe(true);
  });

  it("accepts an invitation with the form alone, the form with a list and the token alone", () => {
    expect(AcceptInvitationRequestSchema.safeParse(form).success).toBe(true);
    expect(AcceptInvitationRequestSchema.safeParse({ ...form, acknowledgements: [] }).success).toBe(true);
    expect(AcceptInvitationRequestSchema.parse({ ...form, acknowledgements: [ok] }).acknowledgements).toEqual([ok]);
    expect(AcceptInvitationRequestSchema.safeParse({ token: "a-token" }).success).toBe(true);
  });

  it.each(violations)("refuses %s on registration", (_name, acknowledgements) => {
    expect(RegisterRequestSchema.safeParse({ ...register, acknowledgements }).success).toBe(false);
  });

  it.each(violations)("refuses %s on the form of an invitation", (_name, acknowledgements) => {
    expect(AcceptInvitationRequestSchema.safeParse({ ...form, acknowledgements }).success).toBe(false);
  });

  it("refuses the field on the token-alone form of an invitation, empty or not", () => {
    for (const acknowledgements of [[ok], []]) {
      const result = AcceptInvitationRequestSchema.safeParse({ token: "a-token", acknowledgements });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["acknowledgements"]);
    }
  });
});
