/** Canonical audit action identifiers (spec §10.1). */
export const AuditActions = {
  team: {
    created: "team.created",
    updated: "team.updated",
    deleted: "team.deleted",
    memberAdded: "team.member.added",
    memberRemoved: "team.member.removed",
    membersReplaced: "team.members.replaced",
  },
  bookmark: {
    created: "bookmark.created",
    updated: "bookmark.updated",
    deleted: "bookmark.deleted",
  },
} as const;
