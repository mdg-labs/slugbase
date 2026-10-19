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
    expect(DOMAIN_EVENT_NAMES).toEqual(["account.created", "workspace.created", "member.left"]);
    expect(Object.keys(DOMAIN_EVENTS["account.created"])).toEqual(["accountId", "path"]);
    expect(ACCOUNT_CREATION_PATHS).toEqual(["self-registration", "invitation", "oidc", "setup"]);
  });

  it("announces workspace.created with the workspace and the account it was created for", () => {
    expect(Object.keys(DOMAIN_EVENTS["workspace.created"])).toEqual(["workspaceId", "accountId"]);
    expect(parseDomainEventPayload("workspace.created", { workspaceId: ACCOUNT, accountId: ACCOUNT })).toEqual({ workspaceId: ACCOUNT, accountId: ACCOUNT });
    expect(() => parseDomainEventPayload("workspace.created", { workspaceId: ACCOUNT, accountId: ACCOUNT, name: "Ada's workspace" })).toThrow(DomainEventPayloadError);
    expect(() => parseDomainEventPayload("workspace.created", { workspaceId: ACCOUNT })).toThrow(DomainEventPayloadError);
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

  it("holds no field that could carry personal data", () => {
    for (const fields of Object.values<Readonly<Record<string, DomainEventField>>>(DOMAIN_EVENTS)) {
      for (const field of Object.values(fields)) {
        expect(["uuid", "enum"]).toContain(field.type);
      }
    }
  });

  it("knows its event names", () => {
    expect(isDomainEventName("account.created")).toBe(true);
    for (const other of ["account.deleted", "toString", "constructor", "", 7, null, undefined]) {
      expect(isDomainEventName(other)).toBe(false);
    }
  });
});

describe("parseDomainEventPayload", () => {
  it("accepts the payload of each path", () => {
    for (const path of ACCOUNT_CREATION_PATHS) {
      const payload = { accountId: ACCOUNT, path } satisfies DomainEventPayload<"account.created">;
      expect(parseDomainEventPayload("account.created", payload)).toEqual({ accountId: ACCOUNT, path });
    }
  });

  it("refuses a field the catalog does not declare, such as an email address", () => {
    expect(() => parseDomainEventPayload("account.created", { accountId: ACCOUNT, path: "setup", email: "a@example.test" })).toThrow(
      DomainEventPayloadError,
    );
  });

  it("refuses a missing field, an identifier that is not a UUID and a path outside the list", () => {
    const bad: unknown[] = [
      { path: "setup" },
      { accountId: ACCOUNT },
      { accountId: "not-a-uuid", path: "setup" },
      { accountId: ACCOUNT, path: "register" },
      { accountId: 7, path: "setup" },
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
      parseDomainEventPayload("account.created", { accountId: "a@example.test", path: "setup" });
      throw new Error("expected a DomainEventPayloadError");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainEventPayloadError);
      expect((error as Error).message).toContain("accountId");
      expect((error as Error).message).not.toContain("a@example.test");
    }
  });
});
