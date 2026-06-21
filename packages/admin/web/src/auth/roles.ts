const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  operator: 1,
  platform_admin: 2,
};

export function hasMinimumRole(role: string, minimum: string): boolean {
  const roleRank = ROLE_RANK[role] ?? -1;
  const minimumRank = ROLE_RANK[minimum] ?? Number.MAX_SAFE_INTEGER;
  return roleRank >= minimumRank;
}

export const ADMIN_ROLES = ["viewer", "operator", "platform_admin"] as const;
