/**
 * Isolation tests: User A vs User B, no share vs shared.
 * Run with: DB_PATH=:memory: npm run test (or npx tsx run test/authorization.test.ts)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { initDatabase, queryOne, execute } from '../src/db/index.js';
import {
  canAccessBookmark,
  canModifyBookmark,
  canAccessFolder,
  canModifyFolder,
  canAccessTag,
} from '../src/auth/authorization.js';
import { v4 as uuidv4 } from 'uuid';

const userAId = uuidv4();
const userBId = uuidv4();
const teamId = uuidv4();
let bookmarkId: string;
let folderId: string;
let tagId: string;

describe('Authorization isolation', () => {
  before(async () => {
    await initDatabase();
    await execute(
      'INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)',
      [userAId, 'a@test.local', 'User A', 'user-a-key', 'hash']
    );
    await execute(
      'INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)',
      [userBId, 'b@test.local', 'User B', 'user-b-key', 'hash']
    );
    await execute(
      'INSERT INTO teams (id, name, description) VALUES (?, ?, ?)',
      [teamId, 'Test Team', 'Desc']
    );
    await execute(
      'INSERT INTO team_members (user_id, team_id) VALUES (?, ?)',
      [userAId, teamId]
    );
    await execute(
      'INSERT INTO team_members (user_id, team_id) VALUES (?, ?)',
      [userBId, teamId]
    );

    folderId = uuidv4();
    await execute(
      'INSERT INTO folders (id, user_id, name, icon) VALUES (?, ?, ?, ?)',
      [folderId, userAId, 'Folder A', 'Folder']
    );
    tagId = uuidv4();
    await execute(
      'INSERT INTO tags (id, user_id, name) VALUES (?, ?, ?)',
      [tagId, userAId, 'Tag A']
    );
    bookmarkId = uuidv4();
    await execute(
      'INSERT INTO bookmarks (id, user_id, title, url, slug, forwarding_enabled) VALUES (?, ?, ?, ?, ?, ?)',
      [bookmarkId, userAId, 'Bookmark A', 'https://a.example.com', 'slug-a', 1]
    );
    await execute(
      'INSERT INTO bookmark_folders (bookmark_id, folder_id) VALUES (?, ?)',
      [bookmarkId, folderId]
    );
    await execute(
      'INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)',
      [bookmarkId, tagId]
    );
  });

  describe('Bookmarks', () => {
    it('User B cannot access or modify User A bookmark when not shared', async () => {
      assert.strictEqual(await canAccessBookmark(userBId, bookmarkId), false);
      assert.strictEqual(await canModifyBookmark(userBId, bookmarkId), false);
    });

    it('User B can access but not modify after user share', async () => {
      await execute(
        'INSERT INTO bookmark_user_shares (bookmark_id, user_id) VALUES (?, ?)',
        [bookmarkId, userBId]
      );
      assert.strictEqual(await canAccessBookmark(userBId, bookmarkId), true);
      assert.strictEqual(await canModifyBookmark(userBId, bookmarkId), false);
    });

    it('User A remains owner and can modify', async () => {
      assert.strictEqual(await canAccessBookmark(userAId, bookmarkId), true);
      assert.strictEqual(await canModifyBookmark(userAId, bookmarkId), true);
    });
  });

  describe('Folders', () => {
    it('User B cannot access or modify User A folder when not shared', async () => {
      assert.strictEqual(await canAccessFolder(userBId, folderId), false);
      assert.strictEqual(await canModifyFolder(userBId, folderId), false);
    });

    it('User B can access but not modify after folder user share', async () => {
      const sharedFolderId = uuidv4();
      await execute(
        'INSERT INTO folders (id, user_id, name, icon) VALUES (?, ?, ?, ?)',
        [sharedFolderId, userAId, 'Shared Folder', null]
      );
      await execute(
        'INSERT INTO folder_user_shares (folder_id, user_id) VALUES (?, ?)',
        [sharedFolderId, userBId]
      );
      assert.strictEqual(await canAccessFolder(userBId, sharedFolderId), true);
      assert.strictEqual(await canModifyFolder(userBId, sharedFolderId), false);
    });
  });

  describe('Tags', () => {
    it('User B cannot access User A tag (tags are not shared)', async () => {
      assert.strictEqual(await canAccessTag(userBId, tagId), false);
    });
    it('User A can access own tag', async () => {
      assert.strictEqual(await canAccessTag(userAId, tagId), true);
    });
  });
});
