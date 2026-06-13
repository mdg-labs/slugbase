import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { assertSlugValid } from "../bookmarks/bookmark.validation.js";
import { BookmarksService } from "../bookmarks/bookmarks.service.js";
import { DbService } from "../db/db.service.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { SlugRepository } from "./slug.repository.js";
import type {
  AccessibleForwardingMatch,
  EnrichedSlugPreferenceRecord,
  GoCandidate,
  GoDisambiguationResult,
  GoRedirectResult,
  GoResolveResult,
  SlugPreferenceRecord,
} from "./slug.types.js";

/** True when the slug still resolves to two or more accessible forwarding matches. */
export function isSlugAmbiguous(matchCount: number): boolean {
  return matchCount >= 2;
}

/** Maps a stored preference to its enriched list shape, or null when the bookmark is stale. */
export function enrichSlugPreference(
  preference: SlugPreferenceRecord,
  matches: AccessibleForwardingMatch[],
): EnrichedSlugPreferenceRecord | null {
  const preferred = matches.find((match) => match.id === preference.bookmarkId);
  if (!preferred) {
    return null;
  }

  return {
    ...preference,
    bookmarkTitle: preferred.title,
    bookmarkUrl: preferred.url,
    ownerUserId: preferred.userId,
    isAmbiguous: isSlugAmbiguous(matches.length),
  };
}

@Injectable()
export class GoService {
  private readonly repo: SlugRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(BookmarksService) private readonly bookmarks: BookmarksService,
  ) {
    this.repo = new SlugRepository(db.getOrm());
  }

  validateSlugForGo(slug: string): void {
    try {
      assertSlugValid(slug);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid slug",
      );
    }
  }

  async resolveSlug(
    workspace: WorkspaceRecord,
    userId: string,
    slug: string,
  ): Promise<GoResolveResult> {
    this.validateSlugForGo(slug);

    const matches = await this.repo.findAccessibleForwardingMatches(
      workspace.id,
      userId,
      slug,
    );

    if (matches.length === 0) {
      throw new NotFoundException(`No forwarding bookmark found for slug "${slug}"`);
    }

    const preference = await this.repo.findSlugPreference(workspace.id, userId, slug);
    if (preference) {
      const preferred = matches.find((match) => match.id === preference.bookmarkId);
      if (preferred) {
        if (matches.length <= 1) {
          await this.repo.deleteSlugPreference(
            workspace.id,
            userId,
            preference.id,
          );
        }
        return this.toRedirect(preferred);
      }
      await this.repo.deleteSlugPreference(workspace.id, userId, preference.id);
    }

    if (matches.length === 1) {
      const match = matches[0];
      if (!match) {
        throw new NotFoundException(`No forwarding bookmark found for slug "${slug}"`);
      }
      return this.toRedirect(match);
    }

    return this.toDisambiguation(slug, matches);
  }

  /**
   * Re-evaluates one user's preference for a slug (spec §8.3, epic #382).
   * Prunes when ≤1 accessible match remains or the preferred bookmark is stale.
   */
  async reEvaluateSlugPreference(
    workspaceId: string,
    userId: string,
    slug: string,
  ): Promise<void> {
    const preference = await this.repo.findSlugPreference(workspaceId, userId, slug);
    if (!preference) return;

    const matches = await this.repo.findAccessibleForwardingMatches(
      workspaceId,
      userId,
      slug,
    );

    const preferredStillMatches = matches.some(
      (match) => match.id === preference.bookmarkId,
    );
    const shouldPrune = matches.length <= 1 || !preferredStillMatches;
    if (shouldPrune) {
      await this.repo.deleteSlugPreference(workspaceId, userId, preference.id);
    }
  }

  /** Re-evaluates every stored preference for a slug after bookmark mutations. */
  async reEvaluateSlugPreferencesForSlug(
    workspaceId: string,
    slug: string,
  ): Promise<void> {
    const preferences = await this.repo.listSlugPreferencesForSlug(workspaceId, slug);
    await Promise.all(
      preferences.map((preference) =>
        this.reEvaluateSlugPreference(workspaceId, preference.userId, slug),
      ),
    );
  }

  /** Re-evaluates preferences on affected slugs after a bookmark update or delete. */
  async reEvaluateAfterBookmarkMutation(
    workspaceId: string,
    previousSlug: string | null,
    nextSlug: string | null,
  ): Promise<void> {
    const slugs = new Set<string>();
    if (previousSlug) slugs.add(previousSlug);
    if (nextSlug) slugs.add(nextSlug);
    await Promise.all(
      [...slugs].map((slug) => this.reEvaluateSlugPreferencesForSlug(workspaceId, slug)),
    );
  }

  /** Re-evaluates a recipient's preference after share access is revoked. */
  async reEvaluateAfterShareRevoke(
    workspaceId: string,
    recipientUserId: string,
    slug: string | null,
  ): Promise<void> {
    if (!slug) return;
    await this.reEvaluateSlugPreference(workspaceId, recipientUserId, slug);
  }

  async chooseSlugTarget(
    workspace: WorkspaceRecord,
    userId: string,
    slug: string,
    bookmarkId: string,
    remember: boolean,
  ): Promise<GoRedirectResult> {
    this.validateSlugForGo(slug);

    const matches = await this.repo.findAccessibleForwardingMatches(
      workspace.id,
      userId,
      slug,
    );
    if (matches.length === 0) {
      throw new NotFoundException(`No forwarding bookmark found for slug "${slug}"`);
    }

    const selected = matches.find((match) => match.id === bookmarkId);
    if (!selected) {
      throw new NotFoundException("Selected bookmark is not a valid match for this slug");
    }

    if (remember) {
      await this.repo.upsertSlugPreference({
        workspaceId: workspace.id,
        userId,
        slug,
        bookmarkId: selected.id,
      });
    }

    return this.toRedirect(selected);
  }

  recordRedirectAccess(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
  ): void {
    this.bookmarks.recordAccess(workspace, userId, bookmarkId);
  }

  async listPreferences(
    workspace: WorkspaceRecord,
    userId: string,
  ): Promise<EnrichedSlugPreferenceRecord[]> {
    const preferences = await this.repo.listSlugPreferences(workspace.id, userId);
    const items: EnrichedSlugPreferenceRecord[] = [];

    for (const preference of preferences) {
      const matches = await this.repo.findAccessibleForwardingMatches(
        workspace.id,
        userId,
        preference.slug,
      );
      const enriched = enrichSlugPreference(preference, matches);
      if (!enriched) {
        await this.repo.deleteSlugPreference(workspace.id, userId, preference.id);
        continue;
      }
      items.push(enriched);
    }

    return items;
  }

  async removePreference(
    workspace: WorkspaceRecord,
    userId: string,
    preferenceId: string,
  ): Promise<void> {
    const removed = await this.repo.deleteSlugPreference(
      workspace.id,
      userId,
      preferenceId,
    );
    if (!removed) {
      throw new NotFoundException("Slug preference not found");
    }
  }

  /** Exposed for integration tests when sharing is not yet available. */
  getRepository(): SlugRepository {
    return this.repo;
  }

  private toRedirect(match: AccessibleForwardingMatch): GoRedirectResult {
    return {
      kind: "redirect",
      url: match.url,
      bookmarkId: match.id,
    };
  }

  private toDisambiguation(
    slug: string,
    matches: AccessibleForwardingMatch[],
  ): GoDisambiguationResult {
    const candidates: GoCandidate[] = matches.map((match) => ({
      id: match.id,
      title: match.title,
      url: match.url,
      ownerUserId: match.userId,
    }));
    return {
      kind: "disambiguation",
      slug,
      candidates,
    };
  }
}
