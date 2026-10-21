import { InMemoryMail } from "@slugbase/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantTx } from "@slugbase/db";
import type { ModuleContext } from "../../src/create-server.ts";
import { invitationSendJob } from "../../src/worker/jobs/invitation-mail.ts";
import { adapters, recordingLogger } from "../support.ts";

// The roles the invitation.send job mails (doc 02 sections 3.4 and 11.1). The owner role is mailed for the invitation an
// instance admin issued and for no other: the table refuses an owner invitation that is not instance-issued, so the
// repository is replaced here to show what the job does with a row the table would not hold.

vi.mock("@slugbase/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slugbase/db")>();
  return { ...actual, invitationRepository: vi.fn(), accountProfileRepository: vi.fn() };
});

const { invitationRepository, accountProfileRepository } = await import("@slugbase/db");

const PAYLOAD = {
  invitationId: "0192f3a0-bbbb-7000-8000-0000000000a1",
  workspaceId: "0192f3a0-bbbb-7000-8000-0000000000a2",
  accountId: "0192f3a0-bbbb-7000-8000-0000000000a3",
  locale: "de",
  mailTicket: "0192f3a0-bbbb-7000-8000-0000000000a1",
};

const inbox = new InMemoryMail();

function run(issued: { role: "owner" | "admin" | "member"; instanceIssued: boolean }) {
  const issueToken = vi.fn().mockResolvedValue({ email: "first.owner@example.test", workspaceName: "Acme", expiresAt: new Date("2026-10-28T00:00:00Z"), ...issued });
  vi.mocked(invitationRepository).mockReturnValue({ issueToken } as unknown as ReturnType<typeof invitationRepository>);
  vi.mocked(accountProfileRepository).mockReturnValue({ profile: () => Promise.resolve({ displayName: "Ada Admin" }) } as unknown as ReturnType<typeof accountProfileRepository>);
  const logger = recordingLogger();
  const tx = { accountId: PAYLOAD.accountId, workspaceId: PAYLOAD.workspaceId, requestId: "invitation.send" } satisfies TenantTx;
  const context = { logger, adapters: { ...adapters(), mail: inbox }, withTenant: (_context: unknown, work: (tx: TenantTx) => Promise<unknown>) => work(tx) } as unknown as ModuleContext;
  return { done: invitationSendJob.handle(PAYLOAD, context), issueToken, logger };
}

beforeEach(() => {
  inbox.clear();
});

describe("the invitation.send job and the owner role", () => {
  it("mails the owner invitation an instance admin issued, in the language of the job, naming the role and the admin", async () => {
    const { done, issueToken } = run({ role: "owner", instanceIssued: true });

    await done;

    expect(issueToken).toHaveBeenCalledWith(PAYLOAD.invitationId, PAYLOAD.mailTicket, expect.any(Buffer));
    expect(inbox.sent).toHaveLength(1);
    expect(inbox.sent[0]).toMatchObject({
      template: "invitation",
      to: "first.owner@example.test",
      locale: "de",
      data: { workspaceName: "Acme", inviterName: "Ada Admin", role: "owner" },
    });
  });

  it("mails nothing for an owner invitation that no instance admin issued, and says so in the log", async () => {
    const { done, logger } = run({ role: "owner", instanceIssued: false });

    await done;

    expect(inbox.sent).toEqual([]);
    expect(JSON.stringify(logger.entries)).toContain("grants a role this email does not carry");
  });

  it.each(["admin", "member"] as const)("still mails a %s invitation", async (role) => {
    const { done } = run({ role, instanceIssued: false });

    await done;

    expect(inbox.sent[0]).toMatchObject({ data: { role } });
  });
});
