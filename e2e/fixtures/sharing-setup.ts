import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { getWorkerCredentials } from './auth.js';
import { loginWorkerApi, resolveE2eApiUrl, type ApiSession } from '../helpers/api-login.js';

const WORKER_COUNT = 8;
const DISAMBIGUATION_SLUG = 'mail';

export interface SharedSlugDisambiguationSetup {
  slug: string;
  workspaceId: string;
  userASession: Pick<ApiSession, 'sessionCookie' | 'csrfToken' | 'email'>;
  userBSession: ApiSession;
  userABookmarkId: string;
  userBBookmarkId: string;
  userATargetUrl: string;
  userBTargetUrl: string;
  userATitle: string;
  userBTitle: string;
}

function apiHeaders(session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>) {
  return {
    Cookie: session.sessionCookie,
    'x-csrf-token': session.csrfToken,
    'Content-Type': 'application/json',
  };
}

async function lookupUserId(email: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for sharing e2e setup');
  }

  const sql = postgres(databaseUrl);
  try {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM user_accounts WHERE email = ${email} LIMIT 1
    `;
    expect(rows.length, `User account missing for ${email}`).toBe(1);
    return rows[0]!.id;
  } finally {
    await sql.end();
  }
}

async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: 'MEMBER' | 'ADMIN' = 'MEMBER',
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for sharing e2e setup');
  }

  const sql = postgres(databaseUrl);
  try {
    await sql`
      INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
      VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${role}, ${Date.now()})
      ON CONFLICT DO NOTHING
    `;
  } finally {
    await sql.end();
  }
}

async function cleanupSlugArtifacts(
  page: Page,
  session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
  slug: string,
): Promise<void> {
  const apiUrl = resolveE2eApiUrl();
  const headers = apiHeaders(session);

  const prefsRes = await page.request.get(`${apiUrl}/go/preferences`, {
    headers: { Cookie: session.sessionCookie },
  });
  if (prefsRes.ok()) {
    const prefs = (await prefsRes.json()) as { items: Array<{ id: string; slug: string }> };
    for (const pref of prefs.items.filter((item) => item.slug === slug)) {
      await page.request.delete(`${apiUrl}/go/preferences/${pref.id}`, { headers });
    }
  }

  const bookmarksRes = await page.request.get(`${apiUrl}/bookmarks?scope=all`, {
    headers: { Cookie: session.sessionCookie },
  });
  if (bookmarksRes.ok()) {
    const bookmarks = (await bookmarksRes.json()) as {
      items: Array<{ id: string; slug: string | null }>;
    };
    for (const bookmark of bookmarks.items.filter((item) => item.slug === slug)) {
      await page.request.delete(`${apiUrl}/bookmarks/${bookmark.id}`, { headers });
    }
  }
}

async function createForwardingBookmark(
  page: Page,
  session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
  data: {
    title: string;
    url: string;
    slug: string;
  },
): Promise<{ id: string }> {
  const apiUrl = resolveE2eApiUrl();
  const res = await page.request.post(`${apiUrl}/bookmarks`, {
    headers: apiHeaders(session),
    data: {
      title: data.title,
      url: data.url,
      slug: data.slug,
      forwardingEnabled: true,
    },
  });
  expect(
    res.ok(),
    `Bookmark create failed (${data.title}): ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  return (await res.json()) as { id: string };
}

/**
 * Puts two worker users in the same workspace with per-owner slug `mail`,
 * then shares user B's bookmark with user A for disambiguation scenarios.
 */
export async function setupSharedSlugDisambiguation(
  page: Page,
  userAWorkerIndex: number,
  userASession: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
): Promise<SharedSlugDisambiguationSetup> {
  const userBWorkerIndex = (userAWorkerIndex + 1) % WORKER_COUNT;
  const userBSession = await loginWorkerApi(userBWorkerIndex);
  const userAEmail = getWorkerCredentials(userAWorkerIndex).email;
  const apiUrl = resolveE2eApiUrl();

  const workspaceRes = await page.request.get(`${apiUrl}/workspaces/active`, {
    headers: { Cookie: userBSession.sessionCookie },
  });
  expect(workspaceRes.ok(), `Active workspace fetch failed: ${workspaceRes.status()}`).toBeTruthy();
  const workspace = (await workspaceRes.json()) as { id: string };

  const userAId = await lookupUserId(userAEmail);
  await addWorkspaceMember(workspace.id, userAId);

  const activateRes = await page.request.post(`${apiUrl}/workspaces/${workspace.id}/activate`, {
    headers: apiHeaders(userASession),
  });
  expect(activateRes.ok(), `Workspace activate failed: ${activateRes.status()}`).toBeTruthy();

  await cleanupSlugArtifacts(page, userBSession, DISAMBIGUATION_SLUG);
  await cleanupSlugArtifacts(page, userASession, DISAMBIGUATION_SLUG);

  const userBTitle = 'User B Mail';
  const userATitle = 'User A Mail';
  const userBTargetUrl = 'https://example.com/mail-user-b';
  const userATargetUrl = 'https://example.com/mail-user-a';

  const userBBookmark = await createForwardingBookmark(page, userBSession, {
    title: userBTitle,
    url: userBTargetUrl,
    slug: DISAMBIGUATION_SLUG,
  });

  const userABookmark = await createForwardingBookmark(page, userASession, {
    title: userATitle,
    url: userATargetUrl,
    slug: DISAMBIGUATION_SLUG,
  });

  const targetsRes = await page.request.get(`${apiUrl}/sharing/targets`, {
    headers: { Cookie: userBSession.sessionCookie },
  });
  expect(targetsRes.ok(), `Share targets failed: ${targetsRes.status()}`).toBeTruthy();
  const targets = (await targetsRes.json()) as {
    members: Array<{ userId: string; email: string }>;
  };
  const recipient = targets.members.find((member) => member.userId === userAId);
  expect(recipient, 'User A must appear in share targets after joining workspace').toBeTruthy();

  const grantRes = await page.request.post(
    `${apiUrl}/sharing/bookmarks/${userBBookmark.id}/grants`,
    {
      headers: apiHeaders(userBSession),
      data: { kind: 'user', targetId: userAId },
    },
  );
  expect(
    grantRes.ok(),
    `Bookmark share grant failed: ${grantRes.status()} ${await grantRes.text()}`,
  ).toBeTruthy();

  return {
    slug: DISAMBIGUATION_SLUG,
    workspaceId: workspace.id,
    userASession,
    userBSession,
    userABookmarkId: userABookmark.id,
    userBBookmarkId: userBBookmark.id,
    userATargetUrl,
    userBTargetUrl,
    userATitle,
    userBTitle,
  };
}

export async function createSharingBookmark(
  page: Page,
  session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
  data: { title: string; url: string },
): Promise<{ id: string }> {
  const apiUrl = resolveE2eApiUrl();
  const res = await page.request.post(`${apiUrl}/bookmarks`, {
    headers: apiHeaders(session),
    data: {
      title: data.title,
      url: data.url,
    },
  });
  expect(
    res.ok(),
    `Bookmark create failed (${data.title}): ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  return (await res.json()) as { id: string };
}

export async function createSharingFolder(
  page: Page,
  session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
  name: string,
): Promise<{ id: string }> {
  const apiUrl = resolveE2eApiUrl();
  const res = await page.request.post(`${apiUrl}/folders`, {
    headers: apiHeaders(session),
    data: { name },
  });
  expect(res.ok(), `Folder create failed (${name}): ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string };
}

export async function linkBookmarkToFolder(
  page: Page,
  session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
  folderId: string,
  bookmarkId: string,
): Promise<void> {
  const apiUrl = resolveE2eApiUrl();
  const res = await page.request.post(`${apiUrl}/folders/${folderId}/bookmarks`, {
    headers: apiHeaders(session),
    data: { bookmarkId },
  });
  expect(
    res.ok(),
    `Folder bookmark link failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

export async function grantBookmarkShare(
  page: Page,
  session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
  bookmarkId: string,
  targetUserId: string,
): Promise<void> {
  const apiUrl = resolveE2eApiUrl();
  const res = await page.request.post(`${apiUrl}/sharing/bookmarks/${bookmarkId}/grants`, {
    headers: apiHeaders(session),
    data: { kind: 'user', targetId: targetUserId },
  });
  expect(
    res.ok(),
    `Bookmark share grant failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

export async function grantFolderShare(
  page: Page,
  session: Pick<ApiSession, 'sessionCookie' | 'csrfToken'>,
  folderId: string,
  targetUserId: string,
): Promise<void> {
  const apiUrl = resolveE2eApiUrl();
  const res = await page.request.post(`${apiUrl}/sharing/folders/${folderId}/grants`, {
    headers: apiHeaders(session),
    data: { kind: 'user', targetId: targetUserId },
  });
  expect(
    res.ok(),
    `Folder share grant failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}
