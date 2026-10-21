import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INVITATION_TTL_SECONDS,
  addInstanceAdminMembership,
  createInstanceWorkspace,
  hashCredentialToken,
  listInstanceWorkspaces,
  reissueInstanceWorkspaceOwnerInvitation,
  requestInstanceWorkspaceDeletion,
  type InstanceMembershipRequest,
  type InstanceMembershipResult,
  type InstanceOwnerInvitationReissue,
  type InstanceOwnerInvitationReissueResult,
  type InstanceWorkspaceCreation,
  type InstanceWorkspaceCreationResult,
  type InstanceWorkspaceStore,
} from "../../src/index.ts";

interface Recorded {
  readonly creations: { request: InstanceWorkspaceCreation; eventId: string; ipPrefix: string | null }[];
  readonly deletions: { workspaceId: string; eventId: string; ipPrefix: string | null }[];
  readonly lists: { eventId: string; ipPrefix: string | null }[];
  readonly memberships: { request: InstanceMembershipRequest; ipPrefix: string | null }[];
  readonly reissues: { request: InstanceOwnerInvitationReissue; eventId: string; ipPrefix: string | null }[];
}

function stubStore(
  options: { creation?: InstanceWorkspaceCreationResult; marked?: boolean; membership?: InstanceMembershipResult; reissue?: InstanceOwnerInvitationReissueResult } = {},
): { store: InstanceWorkspaceStore; recorded: Recorded } {
  const recorded: Recorded = { creations: [], deletions: [], lists: [], memberships: [], reissues: [] };
  const store: InstanceWorkspaceStore = {
    listWorkspaces: (eventId, ipPrefix) => {
      recorded.lists.push({ eventId, ipPrefix });
      return Promise.resolve([]);
    },
    createWorkspace: (request, eventId, ipPrefix) => {
      recorded.creations.push({ request, eventId, ipPrefix });
      return Promise.resolve(options.creation ?? { kind: "created", invitationExpiresAt: request.owner.kind === "invitation" ? new Date("2026-10-27T00:00:00Z") : null });
    },
    reissueOwnerInvitation: (request, eventId, ipPrefix) => {
      recorded.reissues.push({ request, eventId, ipPrefix });
      return Promise.resolve(options.reissue ?? { kind: "issued", email: request.email ?? "previous@example.test", expiresAt: new Date("2026-10-27T00:00:00Z") });
    },
    markWorkspaceDeleting: (workspaceId, eventId, ipPrefix) => {
      recorded.deletions.push({ workspaceId, eventId, ipPrefix });
      return Promise.resolve(options.marked ?? true);
    },
    addMembership: (request, ipPrefix) => {
      recorded.memberships.push({ request, ipPrefix });
      return Promise.resolve(options.membership ?? { kind: "added" });
    },
  };
  return { store, recorded };
}

let counter = 0;
const newId = (): string => {
  counter += 1;
  return `0192f3a0-bbbb-7000-8000-${counter.toString(16).padStart(12, "0")}`;
};

const OWNER = "0192f3a0-bbbb-7000-8000-0000000000aa";

describe("listInstanceWorkspaces", () => {
  it("asks the store under a fresh event id and the network prefix of the request", async () => {
    const { store, recorded } = stubStore();
    await listInstanceWorkspaces({ store, newId }, { ipPrefix: "203.0.0.0/16" });
    expect(recorded.lists).toHaveLength(1);
    expect(recorded.lists[0]?.ipPrefix).toBe("203.0.0.0/16");
  });
});

describe("createInstanceWorkspace", () => {
  it("makes an account the owner and announces workspace.created for it, with no token and no invitation", async () => {
    const { store, recorded } = stubStore();

    const outcome = await createInstanceWorkspace({ store, newId }, { name: "Acme", ownerAccountId: OWNER, ipPrefix: null });

    expect(outcome.kind).toBe("created");
    const request = recorded.creations[0]?.request;
    expect(request).toMatchObject({ name: "Acme", owner: { kind: "account", accountId: OWNER } });
    expect(request?.events).toEqual([{ eventId: expect.any(String) as string, name: "workspace.created", payload: { workspaceId: request?.workspaceId, accountId: OWNER } }]);
    expect(outcome).toEqual({ kind: "created", workspaceId: request?.workspaceId });
  });

  it("invites the address as first owner, hands the token to the outcome only, and stores nothing but its hash", async () => {
    const { store, recorded } = stubStore();

    const outcome = await createInstanceWorkspace({ store, newId }, { name: "Acme", ownerEmail: "  First.Owner@Example.test ", ipPrefix: null });

    if (outcome.kind !== "created" || outcome.invitation?.delivery !== "link") {
      throw new Error("the workspace was not created with an invitation whose link the outcome hands over");
    }
    const request = recorded.creations[0]?.request;
    if (request?.owner.kind !== "invitation") {
      throw new Error("the store was not asked for an invitation");
    }
    expect(request.owner.email).toBe("First.Owner@Example.test");
    expect(request.owner.ttlSeconds).toBe(INVITATION_TTL_SECONDS);
    expect(request.events).toEqual([]);
    expect(outcome.invitation).toMatchObject({ id: request.owner.invitationId, email: "First.Owner@Example.test", expiresAt: new Date("2026-10-27T00:00:00Z") });
    expect(request.owner.tokenHash.equals(hashCredentialToken(outcome.invitation.token) ?? Buffer.alloc(0))).toBe(true);
    expect(JSON.stringify(request)).not.toContain(outcome.invitation.token);
    expect(createHash("sha256").update(Buffer.from(outcome.invitation.token, "base64url")).digest().equals(request.owner.tokenHash)).toBe(true);
  });

  it("uses a different token for every invitation", async () => {
    const { store } = stubStore();
    const tokens = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const outcome = await createInstanceWorkspace({ store, newId }, { name: "Acme", ownerEmail: "owner@example.test", ipPrefix: null });
      if (outcome.kind === "created" && outcome.invitation?.delivery === "link") {
        tokens.add(outcome.invitation.token);
      }
    }
    expect(tokens.size).toBe(5);
  });

  it("asks the store to mail the owner invitation when the composition can, and hands over no token", async () => {
    const { store, recorded } = stubStore();

    const outcome = await createInstanceWorkspace({ store, newId }, { name: "Acme", ownerEmail: "first.owner@example.test", mailLocale: "de", ipPrefix: null });

    const request = recorded.creations[0]?.request;
    if (request?.owner.kind !== "invitation" || outcome.kind !== "created") {
      throw new Error("the workspace was not created with an invitation");
    }
    expect(request.owner.mailLocale).toBe("de");
    expect(outcome.invitation).toEqual({ id: request.owner.invitationId, email: "first.owner@example.test", expiresAt: new Date("2026-10-27T00:00:00Z"), delivery: "mail" });
    expect(JSON.stringify(outcome)).not.toContain("token");
  });

  it("asks for no mail when the composition cannot send it", async () => {
    const { store, recorded } = stubStore();
    await createInstanceWorkspace({ store, newId }, { name: "Acme", ownerEmail: "first.owner@example.test", ipPrefix: null });
    const request = recorded.creations[0]?.request;
    expect(request?.owner.kind === "invitation" && request.owner.mailLocale === undefined).toBe(true);
  });

  it("reports an owner account the store does not know, and creates no invitation", async () => {
    const { store } = stubStore({ creation: { kind: "unknown_account" } });
    expect(await createInstanceWorkspace({ store, newId }, { name: "Acme", ownerAccountId: OWNER, ipPrefix: null })).toEqual({ kind: "unknown_account" });
  });

  it("refuses a name outside 1 to 64 characters and a request for both owners or neither, before the store is asked", async () => {
    const { store, recorded } = stubStore();
    await expect(createInstanceWorkspace({ store, newId }, { name: "", ownerAccountId: OWNER, ipPrefix: null })).rejects.toThrow(RangeError);
    await expect(createInstanceWorkspace({ store, newId }, { name: "n".repeat(65), ownerAccountId: OWNER, ipPrefix: null })).rejects.toThrow(RangeError);
    await expect(createInstanceWorkspace({ store, newId }, { name: "Acme", ipPrefix: null })).rejects.toThrow(RangeError);
    await expect(createInstanceWorkspace({ store, newId }, { name: "Acme", ownerAccountId: OWNER, ownerEmail: "a@example.test", ipPrefix: null })).rejects.toThrow(RangeError);
    expect(recorded.creations).toEqual([]);
  });

  it("counts a name by code points, as the database does", async () => {
    const { store } = stubStore();
    const outcome = await createInstanceWorkspace({ store, newId }, { name: "🔖".repeat(64), ownerAccountId: OWNER, ipPrefix: null });
    expect(outcome.kind).toBe("created");
  });
});

describe("reissueInstanceWorkspaceOwnerInvitation", () => {
  const ask = { workspaceId: "0192f3a0-bbbb-7000-8000-0000000000cc", ipPrefix: "203.0.0.0/16" };

  it("asks the store for a new invitation under fresh identifiers and hands the token to the outcome only", async () => {
    const { store, recorded } = stubStore();

    const outcome = await reissueInstanceWorkspaceOwnerInvitation({ store, newId }, { ...ask, ownerEmail: "  New.Owner@Example.test " });

    const call = recorded.reissues[0];
    if (call === undefined || outcome.kind !== "issued" || outcome.invitation.delivery !== "link") {
      throw new Error("the invitation was not issued with a link");
    }
    expect(call.request).toMatchObject({ workspaceId: ask.workspaceId, email: "New.Owner@Example.test", ttlSeconds: INVITATION_TTL_SECONDS });
    expect(call.request).not.toHaveProperty("mailLocale");
    expect(call.ipPrefix).toBe("203.0.0.0/16");
    expect(call.eventId).not.toBe(call.request.invitationId);
    expect(outcome.invitation).toMatchObject({ id: call.request.invitationId, email: "New.Owner@Example.test", expiresAt: new Date("2026-10-27T00:00:00Z") });
    expect(call.request.tokenHash.equals(hashCredentialToken(outcome.invitation.token) ?? Buffer.alloc(0))).toBe(true);
    expect(JSON.stringify(call.request)).not.toContain(outcome.invitation.token);
  });

  it("leaves the address to the store when none is given and reports the address the store took", async () => {
    const { store, recorded } = stubStore({ reissue: { kind: "issued", email: "previous@example.test", expiresAt: new Date("2026-10-27T00:00:00Z") } });

    const outcome = await reissueInstanceWorkspaceOwnerInvitation({ store, newId }, ask);

    expect(recorded.reissues[0]?.request).not.toHaveProperty("email");
    expect(outcome).toMatchObject({ kind: "issued", invitation: { email: "previous@example.test" } });
  });

  it("asks for the mail and hands over no token when the composition can mail", async () => {
    const { store, recorded } = stubStore();

    const outcome = await reissueInstanceWorkspaceOwnerInvitation({ store, newId }, { ...ask, ownerEmail: "o@example.test", mailLocale: "de" });

    expect(recorded.reissues[0]?.request.mailLocale).toBe("de");
    expect(outcome).toMatchObject({ kind: "issued", invitation: { delivery: "mail" } });
    expect(JSON.stringify(outcome)).not.toContain("token");
  });

  it.each(["unknown_workspace", "has_owner", "email_required"] as const)("passes the refusal %s on and hands over no invitation", async (kind) => {
    const { store } = stubStore({ reissue: { kind } });
    expect(await reissueInstanceWorkspaceOwnerInvitation({ store, newId }, ask)).toEqual({ kind });
  });
});

describe("requestInstanceWorkspaceDeletion", () => {
  const ask = { workspaceId: "0192f3a0-bbbb-7000-8000-0000000000bb", ipPrefix: null };

  it("marks the workspace after the guard allowed it, once", async () => {
    const { store, recorded } = stubStore();
    const asked: string[] = [];

    const outcome = await requestInstanceWorkspaceDeletion(
      {
        store,
        newId,
        guard: (input) => {
          asked.push(input.workspaceId);
          return Promise.resolve({ outcome: "allow" });
        },
      },
      ask,
    );

    expect(outcome).toEqual({ kind: "requested" });
    expect(asked).toEqual([ask.workspaceId]);
    expect(recorded.deletions).toHaveLength(1);
  });

  it("writes and marks nothing when the guard refuses, and answers its code", async () => {
    const { store, recorded } = stubStore();
    const outcome = await requestInstanceWorkspaceDeletion({ store, newId, guard: () => Promise.resolve({ outcome: "refuse", code: "billing_active" }) }, ask);
    expect(outcome).toEqual({ kind: "refused", code: "billing_active" });
    expect(recorded.deletions).toEqual([]);
  });

  it("lets a guard that cannot answer reject the request before anything is marked", async () => {
    const { store, recorded } = stubStore();
    await expect(requestInstanceWorkspaceDeletion({ store, newId, guard: () => Promise.reject(new Error("no answer")) }, ask)).rejects.toThrow("no answer");
    expect(recorded.deletions).toEqual([]);
  });

  it("answers unavailable for a workspace the store cannot mark", async () => {
    const { store } = stubStore({ marked: false });
    expect(await requestInstanceWorkspaceDeletion({ store, newId, guard: () => Promise.resolve({ outcome: "allow" }) }, ask)).toEqual({ kind: "unavailable" });
  });
});

describe("addInstanceAdminMembership", () => {
  const ask = { workspaceId: "0192f3a0-bbbb-7000-8000-0000000000bb", accountId: OWNER, ipPrefix: "203.0.0.0/16" };

  it("asks the store for the member role of the caller in the workspace, under a distinct identifier for each of the two logs", async () => {
    const { store, recorded } = stubStore();

    const outcome = await addInstanceAdminMembership({ store, newId }, ask);

    expect(outcome).toEqual({ kind: "added" });
    expect(recorded.memberships).toHaveLength(1);
    const { request, ipPrefix } = recorded.memberships[0] ?? {};
    expect(ipPrefix).toBe("203.0.0.0/16");
    expect(request?.workspaceId).toBe(ask.workspaceId);
    expect(request?.eventIds.workspace).not.toBe(request?.eventIds.instance);
  });

  it("announces member.joined for the caller with the member role, and for nobody else", async () => {
    const { store, recorded } = stubStore();

    await addInstanceAdminMembership({ store, newId }, ask);

    expect(recorded.memberships[0]?.request.events).toEqual([
      { eventId: expect.any(String) as string, name: "member.joined", payload: { workspaceId: ask.workspaceId, accountId: OWNER, role: "member" } },
    ]);
    expect(recorded.memberships[0]?.request.events[0]?.eventId).not.toBe(recorded.memberships[0]?.request.eventIds.workspace);
  });

  it.each([{ kind: "unknown_workspace" }, { kind: "already_member" }] as const)("passes the refusal %j on as the outcome", async (membership) => {
    const { store } = stubStore({ membership });
    expect(await addInstanceAdminMembership({ store, newId }, ask)).toEqual(membership);
  });
});
