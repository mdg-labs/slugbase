import { RegistrationAcknowledgementSchema } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CREATION_PATHS,
  DOMAIN_EVENTS,
  DOMAIN_EVENT_NAMES,
  DomainEventPayloadError,
  MEMBER_CONTENT_CHOICES,
  isDomainEventName,
  parseDomainEventPayload,
  type DomainEventField,
  type DomainEventPayload,
} from "../../src/index.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";

describe("the domain event catalog", () => {
  it("announces account.created with the account and how it came to exist", () => {
    expect(DOMAIN_EVENT_NAMES).toEqual([
      "account.created",
      "account.deleted",
      "account.email_changed",
      "workspace.created",
      "workspace.deleted",
      "member.left",
      "member.joined",
      "bookmark.created",
    ]);
    expect(Object.keys(DOMAIN_EVENTS["account.created"])).toEqual(["accountId", "path", "acknowledgements"]);
    expect(ACCOUNT_CREATION_PATHS).toEqual(["self-registration", "invitation", "oidc", "setup"]);
  });

  it("announces account.deleted with the account and nothing else", () => {
    expect(Object.keys(DOMAIN_EVENTS["account.deleted"])).toEqual(["accountId"]);
    expect(parseDomainEventPayload("account.deleted", { accountId: ACCOUNT })).toEqual({ accountId: ACCOUNT });
    for (const bad of [{}, { accountId: ACCOUNT, email: "ada@example.test" }, { accountId: "someone" }]) {
      expect(() => parseDomainEventPayload("account.deleted", bad)).toThrow(DomainEventPayloadError);
    }
  });

  it("announces account.email_changed with the account and nothing else, so no address travels in it", () => {
    expect(Object.keys(DOMAIN_EVENTS["account.email_changed"])).toEqual(["accountId"]);
    expect(parseDomainEventPayload("account.email_changed", { accountId: ACCOUNT })).toEqual({ accountId: ACCOUNT });
    for (const bad of [{}, { accountId: ACCOUNT, email: "ada@example.test" }, { accountId: ACCOUNT, previousEmail: "ada@example.test" }, { accountId: "someone" }]) {
      expect(() => parseDomainEventPayload("account.email_changed", bad)).toThrow(DomainEventPayloadError);
    }
  });

  it("announces workspace.created with the workspace and the account it was created for", () => {
    expect(Object.keys(DOMAIN_EVENTS["workspace.created"])).toEqual(["workspaceId", "accountId"]);
    expect(parseDomainEventPayload("workspace.created", { workspaceId: ACCOUNT, accountId: ACCOUNT })).toEqual({ workspaceId: ACCOUNT, accountId: ACCOUNT });
    expect(() => parseDomainEventPayload("workspace.created", { workspaceId: ACCOUNT, accountId: ACCOUNT, name: "Ada's workspace" })).toThrow(DomainEventPayloadError);
    expect(() => parseDomainEventPayload("workspace.created", { workspaceId: ACCOUNT })).toThrow(DomainEventPayloadError);
  });

  it("announces workspace.deleted with the workspace and nothing else", () => {
    expect(Object.keys(DOMAIN_EVENTS["workspace.deleted"])).toEqual(["workspaceId"]);
    expect(parseDomainEventPayload("workspace.deleted", { workspaceId: ACCOUNT })).toEqual({ workspaceId: ACCOUNT });
    for (const bad of [{}, { workspaceId: ACCOUNT, name: "Ada's workspace" }, { workspaceId: "someone" }]) {
      expect(() => parseDomainEventPayload("workspace.deleted", bad)).toThrow(DomainEventPayloadError);
    }
  });

  it("announces member.joined with the workspace, the account and the role it was given, and nothing else", () => {
    const ids = { workspaceId: "0192f3a0-cccc-7000-8000-000000000001", accountId: ACCOUNT };
    expect(Object.keys(DOMAIN_EVENTS["member.joined"])).toEqual(["workspaceId", "accountId", "role"]);
    for (const role of ["owner", "admin", "member"]) {
      expect(parseDomainEventPayload("member.joined", { ...ids, role })).toEqual({ ...ids, role });
    }
    for (const bad of [{}, ids, { ...ids, role: "superuser" }, { ...ids, role: "member", email: "ada@example.test" }, { workspaceId: "w", accountId: ACCOUNT, role: "member" }]) {
      expect(() => parseDomainEventPayload("member.joined", bad)).toThrow(DomainEventPayloadError);
    }
  });

  it("announces member.left with the workspace, the member, the content choice and the recipient, and nothing else", () => {
    const ids = { workspaceId: ACCOUNT, accountId: ACCOUNT, transferTo: ACCOUNT };
    expect(Object.keys(DOMAIN_EVENTS["member.left"])).toEqual(["workspaceId", "accountId", "content", "transferTo"]);
    for (const content of MEMBER_CONTENT_CHOICES) {
      expect(parseDomainEventPayload("member.left", { ...ids, content })).toEqual({ ...ids, content });
    }
    expect(MEMBER_CONTENT_CHOICES).toEqual(["transfer", "delete"]);
    for (const bad of [{ ...ids, content: "keep" }, { ...ids }, { ...ids, content: "delete", email: "a@example.test" }, { ...ids, content: "delete", transferTo: "someone" }]) {
      expect(() => parseDomainEventPayload("member.left", bad)).toThrow(DomainEventPayloadError);
    }
  });

  it("announces bookmark.created with the workspace, the bookmark and the member who owns it, and nothing else", () => {
    const ids = { workspaceId: "0192f3a0-cccc-7000-8000-000000000001", bookmarkId: "0192f3a0-cccc-7000-8000-000000000002", accountId: ACCOUNT };
    expect(Object.keys(DOMAIN_EVENTS["bookmark.created"])).toEqual(["workspaceId", "bookmarkId", "accountId"]);
    expect(parseDomainEventPayload("bookmark.created", ids)).toEqual(ids);
    for (const bad of [{}, { workspaceId: ids.workspaceId, bookmarkId: ids.bookmarkId }, { ...ids, url: "https://example.test/" }, { ...ids, title: "Ada's notes" }, { ...ids, bookmarkId: "a-bookmark" }]) {
      expect(() => parseDomainEventPayload("bookmark.created", bad)).toThrow(DomainEventPayloadError);
    }
  });

  it("holds no field that could carry personal data", () => {
    for (const fields of Object.values<Readonly<Record<string, DomainEventField>>>(DOMAIN_EVENTS)) {
      for (const field of Object.values(fields)) {
        expect(["uuid", "enum", "acknowledgements"]).toContain(field.type);
      }
    }
  });

  it("knows its event names", () => {
    expect(isDomainEventName("account.created")).toBe(true);
    for (const other of ["account.updated", "toString", "constructor", "", 7, null, undefined]) {
      expect(isDomainEventName(other)).toBe(false);
    }
  });
});

describe("parseDomainEventPayload", () => {
  it("accepts the payload of each path", () => {
    for (const path of ACCOUNT_CREATION_PATHS) {
      const payload = { accountId: ACCOUNT, path, acknowledgements: [] } satisfies DomainEventPayload<"account.created">;
      expect(parseDomainEventPayload("account.created", payload)).toEqual({ accountId: ACCOUNT, path, acknowledgements: [] });
    }
  });

  it("refuses a field the catalog does not declare, such as an email address", () => {
    expect(() => parseDomainEventPayload("account.created", { accountId: ACCOUNT, path: "setup", acknowledgements: [], email: "a@example.test" })).toThrow(
      DomainEventPayloadError,
    );
  });

  it("refuses a missing field, an identifier that is not a UUID and a path outside the list", () => {
    const bad: unknown[] = [
      { path: "setup", acknowledgements: [] },
      { accountId: ACCOUNT, acknowledgements: [] },
      { accountId: ACCOUNT, path: "setup" },
      { accountId: "not-a-uuid", path: "setup", acknowledgements: [] },
      { accountId: ACCOUNT, path: "register", acknowledgements: [] },
      { accountId: 7, path: "setup", acknowledgements: [] },
      "account",
      null,
      [],
    ];
    for (const payload of bad) {
      expect(() => parseDomainEventPayload("account.created", payload)).toThrow(DomainEventPayloadError);
    }
  });

  it("names the field in its error and never the value", () => {
    try {
      parseDomainEventPayload("account.created", { accountId: "a@example.test", path: "setup", acknowledgements: [] });
      throw new Error("expected a DomainEventPayloadError");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainEventPayloadError);
      expect((error as Error).message).toContain("accountId");
      expect((error as Error).message).not.toContain("a@example.test");
    }
  });
});

describe("the acknowledgements of account.created", () => {
  const parse = (acknowledgements: unknown) => parseDomainEventPayload("account.created", { accountId: ACCOUNT, path: "self-registration", acknowledgements });

  it("accepts a list within the bounds, up to 8 entries", () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ id: `doc-${String(index)}`, version: "v".repeat(32) }));
    expect(parse([{ id: "terms", version: "2026-01" }]).acknowledgements).toEqual([{ id: "terms", version: "2026-01" }]);
    expect(parse(eight).acknowledgements).toHaveLength(8);
    expect(parse([{ id: "a_b-9".padEnd(32, "x"), version: "1" }]).acknowledgements).toHaveLength(1);
  });

  it("counts a version in code points, as the contract's schema does", () => {
    for (const version of ["\u{1F680}".repeat(32), "\uD800".repeat(32), "a\u{1F680}".repeat(16)]) {
      expect(RegistrationAcknowledgementSchema.safeParse({ id: "terms", version }).success).toBe(true);
      expect(parse([{ id: "terms", version }]).acknowledgements).toEqual([{ id: "terms", version }]);
    }
    for (const version of ["\u{1F680}".repeat(33), "\uD800".repeat(33)]) {
      expect(RegistrationAcknowledgementSchema.safeParse({ id: "terms", version }).success).toBe(false);
      expect(() => parse([{ id: "terms", version }])).toThrow(DomainEventPayloadError);
    }
  });

  it("refuses a list that breaks a bound, naming the field and never a value", () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({ id: `doc-${String(index)}`, version: "1" }));
    const bad: unknown[] = [
      nine,
      [{ id: "Terms", version: "1" }],
      [{ id: "", version: "1" }],
      [{ id: "x".repeat(33), version: "1" }],
      [{ id: "terms", version: "" }],
      [{ id: "terms", version: "v".repeat(33) }],
      [{ id: "terms", version: "1\u0007" }],
      [{ id: "terms", version: "1\n2" }],
      [{ id: "terms", version: "1" }, { id: "terms", version: "2" }],
      [{ id: "terms", version: "1", note: "x" }],
      [{ id: "terms" }],
      [{ id: "terms", version: 1 }],
      ["terms"],
      [null],
      "terms",
      null,
      {},
    ];
    for (const list of bad) {
      expect(() => parse(list)).toThrow(DomainEventPayloadError);
    }
    expect(() => parse([{ id: "secret-id", version: "" }])).toThrow(/acknowledgements/);
    try {
      parse([{ id: "secret-id", version: "" }]);
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-id");
    }
  });
});
