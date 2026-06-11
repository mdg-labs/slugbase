import type { Page, APIRequestContext } from '@playwright/test';

export interface SeedFixture {
  /**
   * Create seed data for e2e tests via the API.
   * Returns a seed context with IDs of created entities.
   */
  seed: (opts?: {
    workspaceName?: string;
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

/**
 * Resolve the API base URL.
 */
function resolveApiUrl(_page: Page): string {
  // Prefer environment variables set by scripts/e2e.sh or CI
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
 * Build a seed helper scoped to the given page.
 */
export function createSeedHelper(page: Page): SeedFixture['seed'] {
  const apiUrl = resolveApiUrl(page);
  const request: APIRequestContext = page.request;

  return async (opts = {}) => {
    const {
      workspaceName = 'E2E Test Workspace',
      bookmarks = 3,
      folders = ['General', 'Dev'],
      tags = ['important', 'archived'],
    } = opts;

    // Create workspace
    const wsRes = await request.post(`${apiUrl}/api/v1/workspaces`, {
      data: { name: workspaceName },
    });
    const workspace = await wsRes.json();
    const workspaceId: string = workspace.id;

    // Create folders
    const folderIds: string[] = [];
    for (const name of folders) {
      const res = await request.post(`${apiUrl}/api/v1/folders`, {
        data: { workspaceId, name },
      });
      const folder = await res.json();
      folderIds.push(folder.id);
    }

    // Create tags
    const tagIds: string[] = [];
    for (const name of tags) {
      const res = await request.post(`${apiUrl}/api/v1/tags`, {
        data: { workspaceId, name },
      });
      const tag = await res.json();
      tagIds.push(tag.id);
    }

    // Create bookmarks
    const bookmarkIds: string[] = [];
    for (let i = 0; i < bookmarks; i++) {
      const res = await request.post(`${apiUrl}/api/v1/bookmarks`, {
        data: {
          workspaceId,
          url: `https://example.com/e2e-test-${i}`,
          title: `E2E Test Bookmark ${i}`,
          folderId: folderIds[i % folderIds.length],
          tagIds: [tagIds[i % tagIds.length]],
        },
      });
      const bookmark = await res.json();
      bookmarkIds.push(bookmark.id);
    }

    return { workspaceId, bookmarkIds, folderIds, tagIds };
  };
}