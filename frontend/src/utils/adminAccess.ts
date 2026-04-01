import type { User } from '../contexts/AuthContext';

const isCloudBuild = import.meta.env.VITE_SLUGBASE_MODE === 'cloud';

/** Self-hosted: instance admin only. Cloud: instance admin or org owner/admin for current session org. */
export function canAccessWorkspaceAdmin(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return isCloudBuild && !!user.workspace_admin;
}
