/**
 * Tests for /go slug resolution and slug preferences.
 * Covers: resolution logic, preferences, IDOR, multi-tenant isolation.
 * Run with: DB_PATH=:memory: npm run test (or npx tsx run test/go.test.ts)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { initDatabase, query, queryOne, execute } from '../src/db/index.js';
import { getAccessibleBookmarksBySlug } from '../src/routes/go-helpers.js';
import { canAccessBookmark } from '../src/auth/authorization.js';
import { v4 as uuidv4 } from 'uuid';

const userAId = uuidv4();
const userBId = uuidv4();
const teamId = uuidv4();
const tenantA = 't1';
const tenantB = 't2';
let bookmarkAId: string;
let bookmarkBId: string;

describe('Go slug resolution', () => {
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
      'INSERT INTO teams (id, tenant_id, name, description) VALUES (?, ?, ?, ?)',
      [teamId, tenantA, 'Test Team', 'Desc']
    );
    await execute(
      'INSERT INTO team_members (tenant_id, user_id, team_id) VALUES (?, ?, ?)',
      [tenantA, userAId, teamId]
    );
    await execute(
      'INSERT INTO team_members (tenant_id, user_id, team_id) VALUES (?, ?, ?)',
      [tenantA, userBId, teamId]
    );
    bookmarkAId = uuidv4();
    await execute(
      'INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [bookmarkAId, tenantA, userAId, 'Bookmark A', 'https://a.example.com', 'test-slug', 1]
    );
    bookmarkBId = uuidv4();
    await execute(
      'INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [bookmarkBId, tenantA, userBId, 'Bookmark B', 'https://b.example.com', 'other-slug', 1]
    );
    await execute(
      'INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), tenantB, userAId, 'Tenant B Bookmark', 'https://tb.example.com', 'test-slug-b', 1]
    );
  });

  describe('getAccessibleBookmarksBySlug', () => {
    it('returns own bookmark for slug', async () => {
      const candidates = await getAccessibleBookmarksBySlug(userAId, 'test-slug', null, tenantA);
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].id, bookmarkAId);
      assert.strictEqual(candidates[0].workspace, 'Personal');
    });

    it('returns empty for unknown slug', async () => {
      const candidates = await getAccessibleBookmarksBySlug(userAId, 'nonexistent', null, tenantA);
      assert.strictEqual(candidates.length, 0);
    });

    it('User B does not see User A bookmark without share', async () => {
      const candidates = await getAccessibleBookmarksBySlug(userBId, 'test-slug', null, tenantA);
      assert.strictEqual(candidates.length, 0);
    });

    it('User B sees User A bookmark after user share', async () => {
      await execute(
        'INSERT INTO bookmark_user_shares (tenant_id, bookmark_id, user_id) VALUES (?, ?, ?)',
        [tenantA, bookmarkAId, userBId]
      );
      const candidates = await getAccessibleBookmarksBySlug(userBId, 'test-slug', null, tenantA);
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].id, bookmarkAId);
      assert.notStrictEqual(candidates[0].workspace, 'Personal');
    });

    it('does not return bookmarks from other tenants', async () => {
      const candidates = await getAccessibleBookmarksBySlug(userAId, 'test-slug', null, tenantB);
      assert.strictEqual(candidates.length, 0);
    });
  });

  describe('Slug preferences - IDOR and isolation', () => {
    it('User B cannot set preference for bookmark without access', async () => {
      const userCId = uuidv4();
      await execute(
        'INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)',
        [userCId, 'c@test.local', 'User C', 'user-c-key', 'hash']
      );
      const hasAccess = await canAccessBookmark(userCId, bookmarkAId, null, tenantA);
      assert.strictEqual(hasAccess, false);
    });

    it('User B can set preference for shared bookmark', async () => {
      const hasAccess = await canAccessBookmark(userBId, bookmarkAId, null, tenantA);
      assert.strictEqual(hasAccess, true);
    });

    it('Preference is user-scoped', async () => {
      await execute(
        'INSERT INTO slug_preferences (tenant_id, user_id, slug, bookmark_id) VALUES (?, ?, ?, ?)',
        [tenantA, userAId, 'pref-slug-a', bookmarkAId]
      );
      const aPref = await queryOne(
        'SELECT * FROM slug_preferences WHERE tenant_id = ? AND user_id = ? AND slug = ?',
        [tenantA, userAId, 'pref-slug-a']
      );
      assert.ok(aPref);
      const bPref = await queryOne(
        'SELECT * FROM slug_preferences WHERE tenant_id = ? AND user_id = ? AND slug = ?',
        [tenantA, userBId, 'pref-slug-a']
      );
      assert.strictEqual(bPref, null);
    });
  });

  describe('Per-user resolution', () => {
    it('each user sees their accessible bookmark by slug', async () => {
      const aCandidates = await getAccessibleBookmarksBySlug(userAId, 'test-slug', null, tenantA);
      const bCandidates = await getAccessibleBookmarksBySlug(userBId, 'other-slug', null, tenantA);
      assert.strictEqual(aCandidates.length, 1);
      assert.strictEqual(bCandidates.length, 1);
    });

    it('User B sees shared bookmark when shared', async () => {
      const candidates = await getAccessibleBookmarksBySlug(userBId, 'test-slug', null, tenantA);
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].id, bookmarkAId);
    });
  });
});
