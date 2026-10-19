import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  AuditMetadataError,
  createAuditWriter,
  isAuditAction,
  parseAuditMetadata,
  prepareAuditRecord,
  type AuditEventInput,
  type AuditRecord,
  type AuditStore,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-000000000001";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const TOKEN = "0192f3a0-dddd-7000-8000-000000000001";

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-eeee-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

function created(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    action: "workspace.created",
    workspaceId: WORKSPACE,
    actor: { type: "account", accountId: ACCOUNT, label: "Ada" },
    entity: { type: "workspace", id: WORKSPACE },
    metadata: { name: "Ada's workspace" },
    ipPrefix: "203.0.0.0/16",
    ...overrides,
  };
}

function memoryStore(): { store: AuditStore; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    store: {
      insert: (record) => {
        records.push(record);
        return Promise.resolve();
      },
    },
  };
}

describe("the audit catalog", () => {
  it("groups the recorded actions by category and declares the metadata of each", () => {
    expect(AUDIT_ACTION_NAMES).toEqual(["workspace.created", "workspace.renamed", "workspace.settings_changed", "workspace.deletion_requested", "workspace.ownership_transferred", "member.role_changed", "member.removed", "member.left", "member.joined", "invitation.created", "invitation.resent", "invitation.link_created", "invitation.revoked"]);
    for (const name of AUDIT_ACTION_NAMES) {
      expect(AUDIT_ACTIONS[name].category).toBe(name.split(".")[0]);
    }
    expect(Object.keys(AUDIT_ACTIONS["workspace.created"].metadata)).toEqual(["name"]);
    expect(Object.keys(AUDIT_ACTIONS["workspace.renamed"].metadata)).toEqual(["from", "to"]);
    expect(Object.keys(AUDIT_ACTIONS["workspace.settings_changed"].metadata)).toEqual(["setting", "from", "to"]);
    expect(Object.keys(AUDIT_ACTIONS["workspace.deletion_requested"].metadata)).toEqual([]);
    expect(Object.keys(AUDIT_ACTIONS["workspace.ownership_transferred"].metadata)).toEqual(["demoteSelf"]);
    expect(Object.keys(AUDIT_ACTIONS["member.role_changed"].metadata)).toEqual(["from", "to"]);
    expect(Object.keys(AUDIT_ACTIONS["member.removed"].metadata)).toEqual(["content", "transferTo"]);
    expect(Object.keys(AUDIT_ACTIONS["member.left"].metadata)).toEqual(["content", "transferTo"]);
    expect(Object.keys(AUDIT_ACTIONS["member.joined"].metadata)).toEqual(["role"]);
    expect(Object.keys(AUDIT_ACTIONS["invitation.created"].metadata)).toEqual(["role"]);
    expect(Object.keys(AUDIT_ACTIONS["invitation.resent"].metadata)).toEqual(["role"]);
    expect(Object.keys(AUDIT_ACTIONS["invitation.link_created"].metadata)).toEqual(["role"]);
    expect(Object.keys(AUDIT_ACTIONS["invitation.revoked"].metadata)).toEqual(["role"]);
  });

  it("knows its action names", () => {
    expect(isAuditAction("workspace.created")).toBe(true);
    for (const other of ["workspace.deleted", "toString", "constructor", "", 7, null, undefined]) {
      expect(isAuditAction(other)).toBe(false);
    }
  });
});

describe("parseAuditMetadata", () => {
  it("accepts the metadata the catalog declares", () => {
    expect(parseAuditMetadata("workspace.created", { name: "Ada's workspace" })).toEqual({ name: "Ada's workspace" });
    expect(parseAuditMetadata("workspace.created", { name: "x".repeat(64) })).toEqual({ name: "x".repeat(64) });
  });

  it("accepts the metadata of a rename and of a settings change, and refuses a key or a value outside them", () => {
    expect(parseAuditMetadata("workspace.renamed", { from: "Old", to: "New" })).toEqual({ from: "Old", to: "New" });
    expect(parseAuditMetadata("workspace.settings_changed", { setting: "aiEnabled", from: "true", to: "false" })).toEqual({
      setting: "aiEnabled",
      from: "true",
      to: "false",
    });
    expect(() => parseAuditMetadata("workspace.renamed", { from: "Old" })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("workspace.renamed", { from: "Old", to: "x".repeat(65) })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("workspace.renamed", { from: "Old", to: "New", email: "ada@example.test" })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("workspace.settings_changed", { setting: "aiEnabled", from: true, to: false })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("workspace.settings_changed", { setting: "aiEnabled", from: "true", to: "false", token: "x" })).toThrow(AuditMetadataError);
  });

  it("refuses a key the catalog does not declare, so a secret has no place to go", () => {
    for (const extra of [{ password: "hunter2" }, { token: "slb_secret" }, { email: "ada@example.test" }, { secret: "s" }]) {
      expect(() => parseAuditMetadata("workspace.created", { name: "Ada", ...extra })).toThrow(AuditMetadataError);
    }
  });

  it("refuses a missing field, a field of the wrong kind and a text outside its length", () => {
    const bad: unknown[] = [{}, { name: 7 }, { name: null }, { name: "" }, { name: "x".repeat(65) }, "name", null, [], undefined];
    for (const metadata of bad) {
      expect(() => parseAuditMetadata("workspace.created", metadata)).toThrow(AuditMetadataError);
    }
  });

  it("names fields in its message and never quotes a value", () => {
    try {
      parseAuditMetadata("workspace.created", { name: "Ada", password: "correct horse battery" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuditMetadataError);
      expect((error as Error).message).toContain("password");
      expect((error as Error).message).not.toContain("correct horse battery");
    }
  });
});

describe("prepareAuditRecord", () => {
  it("builds the row doc 05 section 2.9 describes, with the identifier it is given", () => {
    const record = prepareAuditRecord(created(), ids());

    expect(record).toEqual({
      id: "0192f3a0-eeee-7000-8000-000000000001",
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: ACCOUNT,
      actorLabel: "Ada",
      actorTokenId: null,
      action: "workspace.created",
      entityType: "workspace",
      entityId: WORKSPACE,
      metadata: { name: "Ada's workspace" },
      ipPrefix: "203.0.0.0/16",
    });
  });

  it("records an API token as the actor with the account it acts for", () => {
    const record = prepareAuditRecord(created({ actor: { type: "api_token", accountId: ACCOUNT, tokenId: TOKEN, label: "Ada" } }), ids());

    expect(record.actorType).toBe("api_token");
    expect(record.actorAccountId).toBe(ACCOUNT);
    expect(record.actorTokenId).toBe(TOKEN);
  });

  it("records the system as the actor with no account", () => {
    const record = prepareAuditRecord(created({ actor: { type: "system", label: "SlugBase" } }), ids());

    expect(record.actorType).toBe("system");
    expect(record.actorAccountId).toBeNull();
    expect(record.actorTokenId).toBeNull();
  });

  it("refuses metadata the catalog does not accept before any record exists", () => {
    const event = { ...created(), metadata: { name: "Ada", password: "hunter2" } } as unknown as AuditEventInput;
    expect(() => prepareAuditRecord(event, ids())).toThrow(AuditMetadataError);
  });

  it("refuses an action outside the catalog, an identifier that is not a UUID and a blank actor label", () => {
    const unknown = { ...created(), action: "bookmark.deleted" } as unknown as AuditEventInput;
    expect(() => prepareAuditRecord(unknown, ids())).toThrow(AuditMetadataError);
    expect(() => prepareAuditRecord(created({ workspaceId: "not-a-uuid" }), ids())).toThrow(AuditMetadataError);
    expect(() => prepareAuditRecord(created({ actor: { type: "account", accountId: ACCOUNT, label: "  " } }), ids())).toThrow(AuditMetadataError);
    expect(() => prepareAuditRecord(created({ entity: { type: "workspace", id: "x" } }), ids())).toThrow(AuditMetadataError);
  });

  it("copies the metadata, so a later change to the input does not reach the record", () => {
    const metadata = { name: "Ada's workspace" };
    const record = prepareAuditRecord(created({ metadata }), ids());
    metadata.name = "changed";

    expect(record.metadata).toEqual({ name: "Ada's workspace" });
  });
});

describe("createAuditWriter", () => {
  it("hands the prepared record to the store it is bound to", async () => {
    const { store, records } = memoryStore();

    await createAuditWriter({ store, newId: ids() }).write(created());

    expect(records).toHaveLength(1);
    expect(records[0]?.action).toBe("workspace.created");
    expect(records[0]?.id).toBe("0192f3a0-eeee-7000-8000-000000000001");
  });

  it("writes nothing when the metadata is refused", async () => {
    const { store, records } = memoryStore();
    const event = { ...created(), metadata: { token: "slb_secret" } } as unknown as AuditEventInput;

    await expect(createAuditWriter({ store, newId: ids() }).write(event)).rejects.toBeInstanceOf(AuditMetadataError);
    expect(records).toEqual([]);
  });

  it("lets the store's failure reach the caller, so the transaction around it does not commit", async () => {
    const failing: AuditStore = { insert: () => Promise.reject(new Error("the database refused")) };

    await expect(createAuditWriter({ store: failing, newId: ids() }).write(created())).rejects.toThrow("the database refused");
  });
});
