import type { Page, APIRequestContext } from '@playwright/test';

export interface SeedFixture {
  /**
   * Create seed data for e2e tests via the API.
   * Returns a seed context with IDs of created entities.
   */
  seed: (opts?: {
    bookmarks?: number;
    folders?: string[];
    tags?: string[];
  }) => Promise<SeedContext>;
}

export interface SeedContext {
  workspaceId: string;
  bookmarkIds: string[];
  folderIds: string[];
  tagIds: string[];
}

export interface SeedAuth {
  sessionCookie: string;
  csrfToken: string;
}

/**
 * Resolve the API base URL.
 */
function resolveApiUrl(_page: Page): string {
  const envApi = process.env.E2E_BASE_URL_API;
  if (envApi) return envApi;

  const envSelfHosted = process.env.E2E_BASE_URL_SELF_HOSTED;
  if (envSelfHosted) return envSelfHosted;

  const origin = new URL(_page.url()).origin;
  const project = _page.context()['_project']?.['name'];
  if (project === 'hosted') {
    return origin.replace(/:4002$/, ':4001');
  }
  return origin;
}

/**
 * Build a seed helper scoped to the given page and authenticated session.
 */
export function createSeedHelper(page: Page, auth: SeedAuth): SeedFixture['seed'] {
  const apiUrl = resolveApiUrl(page);
  const request: APIRequestContext = page.request;

  return async (opts = {}) => {
    const {
      bookmarks = 3,
      folders = ['General', 'Dev'],
      tags = ['important', 'archived'],
    } = opts;

    const headers = {
      Cookie: auth.sessionCookie,
      'x-csrf-token': auth.csrfToken,
      'Content-Type': 'application/json',
    };

    const wsRes = await request.get(`${apiUrl}/workspaces/active`, { headers });
    if (!wsRes.ok()) {
      throw new Error(`Failed to load active workspace: ${wsRes.status()}`);
    }
    const activeWorkspace = (await wsRes.json()) as { id: string };

    const folderIds: string[] = [];
    for (const name of folders) {
      const res = await request.post(`${apiUrl}/folders`, {
        headers,
        data: { name },
      });
      if (!res.ok()) {
        throw new Error(`Folder creation failed (${name}): ${res.status()}`);
      }
      const folder = (await res.json()) as { id: string };
      folderIds.push(folder.id);
    }

    const tagIds: string[] = [];
    for (const name of tags) {
      const res = await request.post(`${apiUrl}/tags`, {
        headers,
        data: { name },
      });
      if (!res.ok()) {
        throw new Error(`Tag creation failed (${name}): ${res.status()}`);
      }
      const tag = (await res.json()) as { id: string };
      tagIds.push(tag.id);
    }

    const bookmarkIds: string[] = [];
    for (let i = 0; i < bookmarks; i++) {
      const res = await request.post(`${apiUrl}/bookmarks`, {
        headers,
        data: {
          url: `https://example.com/e2e-test-${i}`,
          title: `E2E Test Bookmark ${i}`,
        },
      });
      if (!res.ok()) {
        throw new Error(`Bookmark creation failed (${i}): ${res.status()}`);
      }
      const bookmark = (await res.json()) as { id: string };
      bookmarkIds.push(bookmark.id);

      if (folderIds.length > 0) {
        const folderId = folderIds[i % folderIds.length];
        if (folderId) {
          const linkRes = await request.post(`${apiUrl}/folders/${folderId}/bookmarks`, {
            headers,
            data: { bookmarkId: bookmark.id },
          });
          if (!linkRes.ok()) {
            throw new Error(`Folder link failed (${folderId}): ${linkRes.status()}`);
          }
        }
      }

      if (tagIds.length > 0) {
        const tagId = tagIds[i % tagIds.length];
        if (tagId) {
          const linkRes = await request.post(`${apiUrl}/tags/${tagId}/bookmarks`, {
            headers,
            data: { bookmarkId: bookmark.id },
          });
          if (!linkRes.ok()) {
            throw new Error(`Tag link failed (${tagId}): ${linkRes.status()}`);
          }
        }
      }
    }

    return {
      workspaceId: activeWorkspace.id,
      bookmarkIds,
      folderIds,
      tagIds,
    };
  };
}
