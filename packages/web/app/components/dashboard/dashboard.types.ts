export type WorkspacePlan = "free" | "personal";

export interface DashboardBookmark {
  id: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
}

export interface DashboardFolder {
  id: string;
  name: string;
  icon: string | null;
  bookmarkCount: number;
}

export interface DashboardTag {
  id: string;
  name: string;
  color: string | null;
  bookmarkCount: number;
}

export interface DashboardWorkspace {
  id: string;
  name: string;
  plan: WorkspacePlan;
}

export interface DashboardCounts {
  bookmarks: number;
  folders: number;
  tags: number;
  sharedWithMe: number;
  sharedByMe: number;
}

export interface DashboardData {
  workspace: DashboardWorkspace;
  counts: DashboardCounts;
  quickAccess: DashboardBookmark[];
  pinned: DashboardBookmark[];
  recent: DashboardBookmark[];
  folders: DashboardFolder[];
  tags: DashboardTag[];
}

export type EntitlementBannerVariant = "approaching" | "at-cap";

export interface EntitlementBannerState {
  variant: EntitlementBannerVariant;
  used: number;
  cap: number;
  remaining: number;
}
