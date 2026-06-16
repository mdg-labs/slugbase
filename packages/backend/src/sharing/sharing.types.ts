export type ShareGrantKind = "user" | "team";

export interface ShareRecipient {
  kind: ShareGrantKind;
  targetId: string;
  targetName: string;
}

export type BookmarkSharingScope = "mine" | "shared-by-me" | "shared-with-me";

export interface BookmarkSharingAccessPath {
  kind: "direct" | "team" | "folder";
  ownerName: string;
  teamName?: string;
  folderName?: string;
}

export interface BookmarkViaFolderShare {
  folderId: string;
  folderName: string;
  recipients: ShareRecipient[];
}

export interface BookmarkSharingSummary {
  scope: BookmarkSharingScope;
  directRecipients: ShareRecipient[];
  viaFolders: BookmarkViaFolderShare[];
  accessPath?: BookmarkSharingAccessPath;
}

export type FolderSharingScope = BookmarkSharingScope;

export interface FolderSharingAccessPath {
  kind: "direct" | "team";
  ownerName: string;
  teamName?: string;
}

export interface FolderSharingSummary {
  scope: FolderSharingScope;
  directRecipients: ShareRecipient[];
  accessPath?: FolderSharingAccessPath;
}

export interface ShareGrantRecord {
  id: string;
  kind: ShareGrantKind;
  targetId: string;
  targetName: string;
  createdAt: Date;
}

export interface ShareTargetMemberRecord {
  userId: string;
  name: string;
  email: string;
}

export interface ShareTargetTeamRecord {
  id: string;
  name: string;
  memberCount: number;
}

export interface ShareTargetsRecord {
  members: ShareTargetMemberRecord[];
  teams: ShareTargetTeamRecord[];
}

export interface GrantShareData {
  kind: ShareGrantKind;
  targetId: string;
}

export type ShareResourceKind = "bookmark" | "folder";
