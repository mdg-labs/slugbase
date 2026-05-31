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
  GoCandidate,
  GoDisambiguationResult,
  GoRedirectResult,
  GoResolveResult,
  SlugPreferenceRecord,
} from "./slug.types.js";

@Injectable()
export class GoService {
  private readonly repo: SlugRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(BookmarksService) private readonly bookmarks: BookmarksService,
  ) {
    this.repo = new SlugRepository(db.getOrm(), db.dialect);
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
        return this.toRedirect(preferred);
      }
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
  ): Promise<SlugPreferenceRecord[]> {
    return this.repo.listSlugPreferences(workspace.id, userId);
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
