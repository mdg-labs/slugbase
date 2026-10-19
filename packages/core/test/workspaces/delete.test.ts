import { describe, expect, it } from "vitest";
import {
  createAuditWriter,
  requestWorkspaceDeletion,
  type AuditRecord,
  type AuditStore,
  type WorkspaceDeletionAsk,
  type WorkspaceDeletionGuardInput,
  type WorkspaceDeletionGuardResult,
  type WorkspaceDeletionStore,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const ACTOR = { type: "account", accountId: OWNER, label: "Ada" } as const;

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

interface WorldOptions {
  /** What the guard answers; a function that throws stands for a guard that cannot answer. */
  guard?: (input: WorkspaceDeletionGuardInput) => Promise<WorkspaceDeletionGuardResult<"billing_active">>;
  /** Whether the workspace could be marked. */
  marks?: boolean;
  auditFails?: boolean;
}

/** The store, the audit store and the guard of one request: what they were asked, in order. */
function world({ guard = () => Promise.resolve({ outcome: "allow" }), marks = true, auditFails = false }: WorldOptions = {}) {
  const log: string[] = [];
  const guarded: WorkspaceDeletionGuardInput[] = [];
  const audits: AuditRecord[] = [];
  const store: WorkspaceDeletionStore = {
    markDeleting() {
      log.push("mark");
      return Promise.resolve(marks);
    },
  };
  const auditStore: AuditStore = {
    insert(record) {
      log.push("audit");
      if (auditFails) {
        return Promise.reject(new Error("the database refused"));
      }
      audits.push(record);
      return Promise.resolve();
    },
  };
  return {
    log,
    guarded,
    audits,
    dependencies: {
      store,
      audit: createAuditWriter({ store: auditStore, newId: ids() }),
      guard: (input: WorkspaceDeletionGuardInput) => {
        log.push("guard");
        guarded.push(input);
        return guard(input);
      },
    },
  };
}

function ask(overrides: Partial<WorkspaceDeletionAsk> = {}): WorkspaceDeletionAsk {
  return { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: "203.0.0.0/16", ...overrides };
}

describe("requestWorkspaceDeletion", () => {
  it("asks the guard first, then marks the workspace, then records the request, and the guard hears the workspace and the account", async () => {
    const { dependencies, log, guarded, audits } = world();

    const outcome = await requestWorkspaceDeletion(dependencies, ask());

    expect(outcome).toEqual({ kind: "requested" });
    expect(log).toEqual(["guard", "mark", "audit"]);
    expect(guarded).toEqual([{ workspaceId: WORKSPACE, accountId: OWNER }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: OWNER,
      actorLabel: "Ada",
      action: "workspace.deletion_requested",
      entityType: "workspace",
      entityId: WORKSPACE,
      metadata: {},
      ipPrefix: "203.0.0.0/16",
    });
  });

  it("changes nothing and writes no audit event when the guard refuses, and hands the code of the refusal back", async () => {
    const { dependencies, log, audits } = world({ guard: () => Promise.resolve({ outcome: "refuse", code: "billing_active" }) });

    const outcome = await requestWorkspaceDeletion(dependencies, ask());

    expect(outcome).toEqual({ kind: "refused", code: "billing_active" });
    expect(log).toEqual(["guard"]);
    expect(audits).toEqual([]);
  });

  it("changes nothing and writes no audit event when the guard cannot answer, and passes the failure on", async () => {
    const { dependencies, log, audits } = world({ guard: () => Promise.reject(new Error("the guard timed out")) });

    await expect(requestWorkspaceDeletion(dependencies, ask())).rejects.toThrow("the guard timed out");

    expect(log).toEqual(["guard"]);
    expect(audits).toEqual([]);
  });

  it("writes no audit event when the workspace cannot be marked", async () => {
    const { dependencies, log, audits } = world({ marks: false });

    expect(await requestWorkspaceDeletion(dependencies, ask())).toEqual({ kind: "unavailable" });
    expect(log).toEqual(["guard", "mark"]);
    expect(audits).toEqual([]);
  });

  it("rejects when the audit write fails, so the caller's transaction does not commit the mark", async () => {
    const { dependencies } = world({ auditFails: true });

    await expect(requestWorkspaceDeletion(dependencies, ask())).rejects.toThrow("the database refused");
  });
});
