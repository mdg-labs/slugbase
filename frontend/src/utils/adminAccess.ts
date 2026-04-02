import type { User } from '../contexts/AuthContext';

/**
 * Instance admin (`is_admin`) or cloud workspace admin (`workspace_admin` from GET /auth/me).
 * Self-hosted never sends `workspace_admin`; cloud does when the user is owner/admin of the session org.
 * We do not require VITE_SLUGBASE_MODE here so a misconfigured cloud build still respects the API.
 */
export function canAccessWorkspaceAdmin(user: User | null | undefined): boolean {
  if (!user) return false;
  return !!user.is_admin || !!user.workspace_admin;
}
