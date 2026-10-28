import { describe, expect, it } from "vitest";
import {
  createAuditWriter,
  createTeam,
  deleteTeam,
  listTeams,
  normalizeTeamDescription,
  normalizeTeamName,
  parseAuditMetadata,
  readTeam,
  replaceTeamMembers,
  updateTeam,
  AuditMetadataError,
  type AuditActor,
  type AuditRecord,
  type TeamDetail,
  type TeamStore,
  type TeamUpdateRequest,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const TEAM = "0192f3a0-aaaa-7000-8000-000000000001";
const MEMBER = "0192f3a0-bbbb-7000-8000-000000000001";
const ACTOR: AuditActor = { type: "account", accountId: "0192f3a0-bbbb-7000-8000-0000000000ad", label: "Ada Admin" };
const NOW = new Date("2026-10-28T05:00:00.000Z");

function detailOf(name: string, description = "", id = TEAM): TeamDetail {
  return { id, name, description, memberCount: 0, version: 1, createdAt: NOW, updatedAt: NOW, members: [] };
}

function auditor() {
  const records: AuditRecord[] = [];
  let next = 0;
  return {
    records,
    audit: createAuditWriter({
      store: {
        insert: (record) => {
          records.push(record);
          return Promise.resolve();
        },
      },
      newId: () => `0192f3a0-cccc-7000-8000-${String((next += 1)).padStart(12, "0")}`,
    }),
  };
}

/** A store that records what it is asked and answers what the test says. */
function store(answers: Partial<TeamStore> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const record = <T>(method: string, request: unknown, answer: T): Promise<T> => {
    calls.push({ method, request });
    return Promise.resolve(answer);
  };
  const dependencies: TeamStore = {
    create: answers.create ?? ((team) => record("create", team, { kind: "created", team: detailOf(team.name, team.description, team.id) } as const)),
    list: answers.list ?? ((request) => record("list", request, [])),
    find: answers.find ?? ((teamId) => record("find", teamId, detailOf("Found") as TeamDetail | undefined)),
    update: answers.update ?? ((request: TeamUpdateRequest) => record("update", request, { kind: "updated", team: detailOf(request.changes.name ?? "Same"), previousName: "Before" } as const)),
    remove: answers.remove ?? ((teamId) => record<string | undefined>("remove", teamId, "Removed")),
    replaceMembers: answers.replaceMembers ?? ((request) => record("replaceMembers", request, { kind: "replaced", team: detailOf("Replaced"), added: 1, removed: 0 } as const)),
  };
  return { calls, store: dependencies };
}

const ask = { workspaceId: WORKSPACE, actor: ACTOR, ipPrefix: "203.0.0.0/16" };

describe("normalizeTeamName", () => {
  it("keeps the case as entered and removes the whitespace around the name", () => {
    expect(normalizeTeamName("  Design Team ")).toEqual({ name: "Design Team" });
  });

  it("refuses an empty name and one that is blank once trimmed", () => {
    expect(normalizeTeamName("")).toEqual({ refusal: "empty" });
    expect(normalizeTeamName(" \t\n ")).toEqual({ refusal: "empty" });
  });

  it("allows 64 characters and refuses 65, counting a character outside the BMP once", () => {
    expect(normalizeTeamName("x".repeat(64))).toEqual({ name: "x".repeat(64) });
    expect(normalizeTeamName("x".repeat(65))).toEqual({ refusal: "too_long" });
    expect(normalizeTeamName("😀".repeat(64))).toEqual({ name: "😀".repeat(64) });
    expect(normalizeTeamName("😀".repeat(65))).toEqual({ refusal: "too_long" });
  });
});

describe("normalizeTeamDescription", () => {
  it("allows an empty description, trims it, and allows 280 characters and refuses 281", () => {
    expect(normalizeTeamDescription("")).toEqual({ description: "" });
    expect(normalizeTeamDescription("  Who we are \n")).toEqual({ description: "Who we are" });
    expect(normalizeTeamDescription("d".repeat(280))).toEqual({ description: "d".repeat(280) });
    expect(normalizeTeamDescription("d".repeat(281))).toEqual({ refusal: "too_long" });
    expect(normalizeTeamDescription("😀".repeat(280))).toEqual({ description: "😀".repeat(280) });
  });
});

describe("createTeam", () => {
  it("hands the store the trimmed name, an empty description by default and a generated identifier, and records team.created with the name only", async () => {
    const { calls, store: teams } = store();
    const { audit, records } = auditor();

    const outcome = await createTeam({ store: teams, audit, newId: () => TEAM }, { ...ask, name: "  Design ", description: undefined });

    expect(outcome).toMatchObject({ kind: "created", team: { id: TEAM, name: "Design", description: "" } });
    expect(calls).toEqual([{ method: "create", request: { id: TEAM, name: "Design", description: "" } }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: "team.created", workspaceId: WORKSPACE, entityType: "team", entityId: TEAM, metadata: { name: "Design" }, actorLabel: "Ada Admin", ipPrefix: "203.0.0.0/16" });
  });

  it("refuses a name or a description outside the limits before the store is asked, and records nothing", async () => {
    const { calls, store: teams } = store();
    const { audit, records } = auditor();
    const dependencies = { store: teams, audit, newId: () => TEAM };

    expect(await createTeam(dependencies, { ...ask, name: "  ", description: undefined })).toEqual({ kind: "invalid", field: "name", reason: "empty" });
    expect(await createTeam(dependencies, { ...ask, name: "x".repeat(65), description: undefined })).toEqual({ kind: "invalid", field: "name", reason: "too_long" });
    expect(await createTeam(dependencies, { ...ask, name: "ok", description: "d".repeat(281) })).toEqual({ kind: "invalid", field: "description", reason: "too_long" });
    expect(calls).toEqual([]);
    expect(records).toEqual([]);
  });

  it("records nothing for a name that is taken", async () => {
    const { store: teams } = store({ create: () => Promise.resolve({ kind: "name_taken" }) });
    const { audit, records } = auditor();
    expect(await createTeam({ store: teams, audit, newId: () => TEAM }, { ...ask, name: "Design", description: undefined })).toEqual({ kind: "name_taken" });
    expect(records).toEqual([]);
  });

  it("fails when the audit event cannot be written, so the caller's transaction ends with no team", async () => {
    const { store: teams } = store();
    const audit = createAuditWriter({ store: { insert: () => Promise.reject(new Error("the audit store failed")) }, newId: () => "0192f3a0-cccc-7000-8000-000000000001" });
    await expect(createTeam({ store: teams, audit, newId: () => TEAM }, { ...ask, name: "Design", description: undefined })).rejects.toThrow("the audit store failed");
  });
});

describe("listTeams and readTeam", () => {
  it("hand the store's answers back unchanged", async () => {
    const { calls, store: teams } = store();
    expect(await listTeams({ store: teams }, { after: { name: "a", id: TEAM }, limit: 7 })).toEqual([]);
    expect(await readTeam({ store: teams }, { teamId: TEAM })).toMatchObject({ name: "Found" });
    expect(calls).toEqual([
      { method: "list", request: { after: { name: "a", id: TEAM }, limit: 7 } },
      { method: "find", request: TEAM },
    ]);
  });
});

describe("updateTeam", () => {
  it("hands the store only the fields the patch names, trimmed, with the accepted versions, and records team.updated with both names", async () => {
    const { calls, store: teams } = store();
    const { audit, records } = auditor();

    const outcome = await updateTeam({ store: teams, audit }, { ...ask, teamId: TEAM, patch: { name: " Renamed ", description: " About us " }, expectedVersions: [3] });

    expect(outcome).toMatchObject({ kind: "updated", previousName: "Before", team: { name: "Renamed" } });
    expect(calls).toEqual([{ method: "update", request: { teamId: TEAM, changes: { name: "Renamed", description: "About us" }, expectedVersions: [3] } }]);
    expect(records[0]).toMatchObject({ action: "team.updated", entityId: TEAM, metadata: { from: "Before", to: "Renamed" } });
  });

  it("leaves a field out of the change when the patch leaves it out", async () => {
    const { calls, store: teams } = store();
    const { audit } = auditor();
    await updateTeam({ store: teams, audit }, { ...ask, teamId: TEAM, patch: { description: "" }, expectedVersions: undefined });
    expect(calls[0]?.request).toEqual({ teamId: TEAM, changes: { description: "" }, expectedVersions: undefined });
  });

  it("refuses a name or a description outside the limits before the store is asked", async () => {
    const { calls, store: teams } = store();
    const { audit, records } = auditor();
    expect(await updateTeam({ store: teams, audit }, { ...ask, teamId: TEAM, patch: { name: "" }, expectedVersions: undefined })).toEqual({ kind: "invalid", field: "name", reason: "empty" });
    expect(await updateTeam({ store: teams, audit }, { ...ask, teamId: TEAM, patch: { description: "d".repeat(281) }, expectedVersions: undefined })).toEqual({ kind: "invalid", field: "description", reason: "too_long" });
    expect(calls).toEqual([]);
    expect(records).toEqual([]);
  });

  it("records nothing for a patch that changes nothing, a stale version, a name that is taken or a team that is not there", async () => {
    const { audit, records } = auditor();
    for (const answer of [{ kind: "unchanged", team: detailOf("Same") }, { kind: "stale" }, { kind: "name_taken" }, { kind: "not_found" }] as const) {
      const { store: teams } = store({ update: () => Promise.resolve(answer) });
      expect(await updateTeam({ store: teams, audit }, { ...ask, teamId: TEAM, patch: { name: "Same" }, expectedVersions: undefined })).toEqual(answer);
    }
    expect(records).toEqual([]);
  });
});

describe("deleteTeam", () => {
  it("records team.deleted with the name the team had", async () => {
    const { calls, store: teams } = store();
    const { audit, records } = auditor();
    expect(await deleteTeam({ store: teams, audit }, { ...ask, teamId: TEAM })).toBe(true);
    expect(calls).toEqual([{ method: "remove", request: TEAM }]);
    expect(records[0]).toMatchObject({ action: "team.deleted", entityType: "team", entityId: TEAM, metadata: { name: "Removed" } });
  });

  it("answers false and records nothing for a team that is not there", async () => {
    const { store: teams } = store({ remove: () => Promise.resolve(undefined) });
    const { audit, records } = auditor();
    expect(await deleteTeam({ store: teams, audit }, { ...ask, teamId: TEAM })).toBe(false);
    expect(records).toEqual([]);
  });
});

describe("replaceTeamMembers", () => {
  it("hands the store the accounts and records team.members_changed with the team's name and nothing about the members", async () => {
    const { calls, store: teams } = store();
    const { audit, records } = auditor();

    const outcome = await replaceTeamMembers({ store: teams, audit }, { ...ask, teamId: TEAM, accountIds: [MEMBER] });

    expect(outcome).toMatchObject({ kind: "replaced", added: 1 });
    expect(calls).toEqual([{ method: "replaceMembers", request: { teamId: TEAM, accountIds: [MEMBER] } }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: "team.members_changed", entityId: TEAM, metadata: { name: "Replaced" } });
    expect(JSON.stringify(records[0]?.metadata)).not.toContain(MEMBER);
  });

  it("records nothing for a set the team has, an account that is no member, or a team that is not there", async () => {
    const { audit, records } = auditor();
    for (const answer of [{ kind: "unchanged", team: detailOf("Same") }, { kind: "unknown_members" }, { kind: "not_found" }] as const) {
      const { store: teams } = store({ replaceMembers: () => Promise.resolve(answer) });
      expect(await replaceTeamMembers({ store: teams, audit }, { ...ask, teamId: TEAM, accountIds: [MEMBER] })).toEqual(answer);
    }
    expect(records).toEqual([]);
  });
});

describe("the audit events of a team", () => {
  it("carry names only: a member, an address or a description has no field", () => {
    expect(parseAuditMetadata("team.updated", { from: "Old", to: "New" })).toEqual({ from: "Old", to: "New" });
    expect(() => parseAuditMetadata("team.created", { name: "Design", description: "About us" })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("team.members_changed", { name: "Design", accountIds: MEMBER })).toThrow(AuditMetadataError);
    expect(() => parseAuditMetadata("team.deleted", { name: "x".repeat(65) })).toThrow(AuditMetadataError);
  });
});
