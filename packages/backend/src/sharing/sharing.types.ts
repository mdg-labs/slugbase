export type ShareGrantKind = "user" | "team";

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
