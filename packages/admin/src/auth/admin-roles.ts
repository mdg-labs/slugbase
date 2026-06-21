export const ADMIN_ROLES = ["viewer", "operator", "platform_admin"] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

const ROLE_RANK: Record<AdminRole, number> = {
  viewer: 0,
  operator: 1,
  platform_admin: 2,
};

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Returns true when `role` meets or exceeds `minimum`. */
export function hasMinimumRole(role: AdminRole, minimum: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
