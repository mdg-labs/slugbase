import type { BookmarkRecord } from "../bookmarks/bookmark.types.js";

export interface SlugPreferenceRecord {
  id: string;
  workspaceId: string;
  userId: string;
  slug: string;
  bookmarkId: string;
  createdAt: Date;
}

export interface GoCandidate {
  id: string;
  title: string;
  url: string;
  ownerUserId: string;
}

export interface GoDisambiguationResult {
  kind: "disambiguation";
  slug: string;
  candidates: GoCandidate[];
}

export interface GoRedirectResult {
  kind: "redirect";
  url: string;
  bookmarkId: string;
}

export type GoResolveResult = GoRedirectResult | GoDisambiguationResult;

export interface UpsertSlugPreferenceData {
  workspaceId: string;
  userId: string;
  slug: string;
  bookmarkId: string;
}

export type AccessibleForwardingMatch = BookmarkRecord;
