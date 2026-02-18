/**
 * Stats service tests. Run with: DB_PATH=:memory: npm run test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { initDatabase, execute } from '../src/db/index.js';
import {
  getCoreCounts,
  getActivity,
  getDistributions,
  getBreakdowns,
  aggregateStats,
} from '../src/services/stats.js';
import { v4 as uuidv4 } from 'uuid';

describe('Stats service', () => {
  before(async () => {
    await initDatabase();
    const u1 = uuidv4();
    const u2 = uuidv4();
    await execute(
      'INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)',
      [u1, 'u1@test.local', 'User 1', 'key1', 'hash']
    );
    await execute(
      'INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)',
      [u2, 'u2@test.local', 'User 2', 'key2', 'hash']
    );
    await execute(
      'INSERT INTO bookmarks (id, user_id, title, url, slug) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), u1, 'B1', 'https://a.com', 'b1']
    );
    await execute(
      'INSERT INTO bookmarks (id, user_id, title, url, slug) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), u1, 'B2', 'https://b.com', 'b2']
    );
    await execute(
      'INSERT INTO bookmarks (id, user_id, title, url, slug) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), u2, 'B3', 'https://c.com', 'b3']
    );
    await execute(
      'INSERT INTO folders (id, user_id, name) VALUES (?, ?, ?)',
      [uuidv4(), u1, 'F1']
    );
    await execute(
      'INSERT INTO tags (id, user_id, name) VALUES (?, ?, ?)',
      [uuidv4(), u1, 'T1']
    );
  });

  it('getCoreCounts returns expected totals', async () => {
    const counts = await getCoreCounts();
    assert.strictEqual(counts.users_total, 2);
    assert.strictEqual(counts.bookmarks_total, 3);
    assert.strictEqual(counts.folders_total, 1);
    assert.strictEqual(counts.tags_total, 1);
    assert(typeof counts.shares_total === 'number');
  });

  it('getBreakdowns includes shares_by_type', async () => {
    const b = await getBreakdowns();
    assert.ok(b.shares_by_type);
    assert(typeof b.shares_by_type.team === 'number');
    assert(typeof b.shares_by_type.user === 'number');
  });

  it('getActivity returns numbers', async () => {
    const a = await getActivity();
    assert(typeof a.active_users_7d === 'number');
    assert(typeof a.active_users_30d === 'number');
  });

  it('getDistributions returns percentiles', async () => {
    const d = await getDistributions();
    assert.ok(d.bookmarks_per_user);
    assert(typeof d.bookmarks_per_user.p50 === 'number');
    assert(typeof d.bookmarks_per_user.p90 === 'number');
    assert(typeof d.bookmarks_per_user.max === 'number');
  });

  it('aggregateStats returns full shape', async () => {
    const stats = await aggregateStats();
    assert.ok(stats.core_counts);
    assert.ok(stats.breakdowns);
    assert.ok(stats.activity);
    assert.ok(stats.distributions);
    assert.ok(stats.timeseries);
    assert.ok(stats.timeseries.users_30d);
    assert.ok(stats.timeseries.bookmarks_30d);
    assert(stats.payments === null || typeof stats.payments === 'object');
  });
});
