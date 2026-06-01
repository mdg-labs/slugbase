import "reflect-metadata";

import { ForbiddenException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BillingApplicationService } from "../src/billing/billing-application.service.js";
import { DowngradeService } from "../src/billing/downgrade/downgrade.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { BookmarkRepository } from "../src/bookmarks/bookmark.repository.js";
import { DbService } from "../src/db/db.service.js";
import { FREE_BOOKMARK_CAP } from "../src/entitlements/entitlements.service.js";
import { GoService } from "../src/slugs/go.service.js";
import { SearchService } from "../src/search/search.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

const PERIOD_END = new Date("2026-06-01T00:00:00.000Z");

function personalSubscriptionPayload(workspaceId: string) {
  return {
    id: "evt_downgrade_reupgrade",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_personal_downgrade",
        object: "subscription",
        status: "active",
        current_period_end: Math.floor(PERIOD_END.getTime() / 1000) + 86_400 * 30,
        customer: "cus_downgrade",
        metadata: { workspace_id: workspaceId, plan: "personal" },
      },
    },
  };
}

describe("Downgrade overflow (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let billingApp: BillingApplicationService;
  let downgradeService: DowngradeService;
  let bookmarksService: BookmarksService;
  let bookmarkRepo: BookmarkRepository;
  let workspacesService: WorkspacesService;
  let goService: GoService;
  let searchService: SearchService;

  let ownerUserId: string;
  let workspaceId: string;
  let workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  const bookmarkIds: string[] = [];
  let archivedSlugBookmarkId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_downgrade_integration",
      STRIPE_WEBHOOK_SECRET: "whsec_test_downgrade_integration",
      DOWNGRADE_GRACE_PERIOD_DAYS: "7",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    billingApp = moduleRef.get(BillingApplicationService);
    downgradeService = moduleRef.get(DowngradeService);
    bookmarksService = moduleRef.get(BookmarksService);
    workspacesService = moduleRef.get(WorkspacesService);
    goService = moduleRef.get(GoService);
    searchService = moduleRef.get(SearchService);

    const db = moduleRef.get(DbService);
    bookmarkRepo = new BookmarkRepository(db.getOrm());

    const accountsService = moduleRef.get(AccountsService);
    const owner = await accountsService.registerAccount({
      email: "downgrade-owner@example.com",
      name: "Downgrade Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Downgrade WS", slug: "downgrade-ws" },
      ownerUserId,
    );
    workspaceId = ws.id;
    workspace = ws;

    await billingApp.applyBillingEvent({
      eventId: "evt_downgrade_upgrade_personal",
      payload: personalSubscriptionPayload(workspaceId),
    });
    workspace = await workspacesService.getWorkspace(workspaceId);
    expect(workspace.plan).toBe("personal");

    const overflowCount = FREE_BOOKMARK_CAP + 5;
    for (let i = 0; i < overflowCount; i += 1) {
      const created = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: `Downgrade BM ${String(i).padStart(2, "0")}`,
        url: `https://downgrade.example.com/${String(i)}`,
        slug: i === 0 ? "downgrade-archived-slug" : undefined,
        forwardingEnabled: i === 0,
      });
      bookmarkIds.push(created.id);
      if (i === 0) {
        archivedSlugBookmarkId = created.id;
      }
      await bookmarkRepo.incrementAccessCount(
        workspaceId,
        created.id,
        Date.UTC(2026, 0, 1) + i * 86_400_000,
      );
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  async function markWorkspaceFreeAtPeriodEnd(): Promise<void> {
    await workspacesService.updateWorkspace(
      workspaceId,
      {
        plan: "free",
        billingSubscriptionId: null,
        billingStatus: "cancelled",
        billingPeriodEnd: PERIOD_END,
      },
      ownerUserId,
    );
    workspace = await workspacesService.getWorkspace(workspaceId);
  }

  it("does not archive overflow before grace period elapses", async () => {
    await markWorkspaceFreeAtPeriodEnd();

    const graceNotElapsed = new Date(PERIOD_END.getTime() + 6 * 86_400_000);
    const result = await downgradeService.processWorkspaceDowngrade(
      workspaceId,
      graceNotElapsed,
    );
    expect(result.archivedCount).toBe(0);

    const activeCount = await bookmarkRepo.countActiveInWorkspace(workspaceId);
    expect(activeCount).toBe(FREE_BOOKMARK_CAP + 5);
  });

  it("archives the lowest-priority overflow bookmarks after grace", async () => {
    const graceElapsed = new Date(PERIOD_END.getTime() + 7 * 86_400_000);
    const result = await downgradeService.processWorkspaceDowngrade(
      workspaceId,
      graceElapsed,
    );
    expect(result.archivedCount).toBe(5);

    workspace = await workspacesService.getWorkspace(workspaceId);
    const activeCount = await bookmarkRepo.countActiveInWorkspace(workspaceId);
    expect(activeCount).toBe(FREE_BOOKMARK_CAP);

    const archived = await bookmarkRepo.listPlanArchivedInWorkspaceOrdered(workspaceId);
    expect(archived).toHaveLength(5);
    expect(archived.map((b) => b.id).sort()).toEqual(
      bookmarkIds.slice(0, 5).sort(),
    );
  });

  it("excludes plan-archived bookmarks from list, search, slug resolution, and creation cap", async () => {
    workspace = await workspacesService.getWorkspace(workspaceId);

    const list = await bookmarksService.listBookmarks(workspace, ownerUserId, {
      pageSize: 100,
    });
    expect(list.total).toBe(FREE_BOOKMARK_CAP);
    expect(list.items.some((b) => bookmarkIds.slice(0, 5).includes(b.id))).toBe(false);

    const search = await searchService.search(workspace, ownerUserId, {
      q: "Downgrade BM",
      bookmarkLimit: 100,
    });
    expect(search.bookmarks.total).toBe(FREE_BOOKMARK_CAP);
    expect(
      search.bookmarks.items.some((b) => bookmarkIds.slice(0, 5).includes(b.id)),
    ).toBe(false);

    await expect(
      goService.resolveSlug(workspace, ownerUserId, "downgrade-archived-slug"),
    ).rejects.toThrow(/No forwarding bookmark found/);

    await expect(
      bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Blocked At Cap",
        url: "https://blocked.example.com",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("restores archived bookmarks on re-upgrade up to the new cap", async () => {
    await billingApp.applyBillingEvent({
      eventId: "evt_downgrade_reupgrade_once",
      payload: personalSubscriptionPayload(workspaceId),
    });
    workspace = await workspacesService.getWorkspace(workspaceId);
    expect(workspace.plan).toBe("personal");

    const activeCount = await bookmarkRepo.countActiveInWorkspace(workspaceId);
    expect(activeCount).toBe(FREE_BOOKMARK_CAP + 5);

    const archived = await bookmarkRepo.listPlanArchivedInWorkspaceOrdered(workspaceId);
    expect(archived).toHaveLength(0);

    const resolved = await goService.resolveSlug(
      workspace,
      ownerUserId,
      "downgrade-archived-slug",
    );
    expect(resolved.kind).toBe("redirect");
    expect(resolved.bookmarkId).toBe(archivedSlugBookmarkId);
  });
});
