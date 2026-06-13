export type SharingScope = "all" | "mine" | "shared-with-me" | "shared-by-me";

export type SharingScopeOption = {
  id: SharingScope;
  labelKey: string;
  icon: string;
};

export const SHARING_SCOPE_OPTIONS: SharingScopeOption[] = [
  { id: "all", labelKey: "sharing.scope.all", icon: "layers" },
  { id: "mine", labelKey: "sharing.scope.mine", icon: "user" },
  {
    id: "shared-with-me",
    labelKey: "sharing.scope.shared_with_me",
    icon: "users",
  },
  {
    id: "shared-by-me",
    labelKey: "sharing.scope.shared_by_me",
    icon: "share-2",
  },
];

export type ShareResourceKind = "bookmark" | "folder";

export type ShareGrant = {
  id: string;
  kind: "user" | "team";
  targetId: string;
  targetName: string;
  createdAt: string;
};

export type ShareTargetMember = {
  userId: string;
  name: string;
  email: string;
};

export type ShareTargetTeam = {
  id: string;
  name: string;
  memberCount: number;
};

export type ShareTargets = {
  members: ShareTargetMember[];
  teams: ShareTargetTeam[];
};

export type WorkspacePlan = "free" | "personal" | "team";

export type EntitlementCapability = "team-sharing";
