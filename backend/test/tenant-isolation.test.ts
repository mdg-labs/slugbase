import { before, describe, it } from 'node:test';
import assert from 'node:assert';
import { v4 as uuidv4 } from 'uuid';
import { execute, initDatabase, query, queryOne } from '../src/db/index.js';
import { canAccessBookmark, getTeamIdsForUser } from '../src/auth/authorization.js';
import { getAccessibleBookmarksBySlug } from '../src/routes/go-helpers.js';
import { createToken, listTokens, revokeToken } from '../src/services/api-tokens.js';

const tenantA = 't1';
const tenantB = 't2';
const userId = uuidv4();
let bookmarkAId: string;
let bookmarkBId: string;

describe('Tenant isolation', () => {
  before(async () => {
    await initDatabase();
    await execute(
      'INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)',
      [userId, 'tenant@test.local', 'Tenant User', 'tenant-user-key', 'hash']
    );

    bookmarkAId = uuidv4();
    bookmarkBId = uuidv4();
    await execute(
      'INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [bookmarkAId, tenantA, userId, 'Tenant A bookmark', 'https://a.example.com', 'slug-a', 1]
    );
    await execute(
      'INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [bookmarkBId, tenantB, userId, 'Tenant B bookmark', 'https://b.example.com', 'slug-b', 1]
    );

    await execute(
      'INSERT INTO oidc_providers (id, tenant_id, provider_key, client_id, client_secret, issuer_url, scopes, auto_create_users, default_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), tenantA, 'tenanta', 'client-a', 'secret-a', 'https://issuer-a.example.com', 'openid email profile', 1, 'user']
    );
    await execute(
      'INSERT INTO oidc_providers (id, tenant_id, provider_key, client_id, client_secret, issuer_url, scopes, auto_create_users, default_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), tenantB, 'tenantb', 'client-b', 'secret-b', 'https://issuer-b.example.com', 'openid email profile', 1, 'user']
    );
  });

  it('go helper resolves only current tenant bookmarks', async () => {
    const a = await getAccessibleBookmarksBySlug(userId, 'slug-a', null, tenantA);
    const b = await getAccessibleBookmarksBySlug(userId, 'slug-b', null, tenantB);

    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(a[0].id, bookmarkAId);
    assert.strictEqual(b[0].id, bookmarkBId);
  });

  it('authorization denies cross-tenant bookmark access', async () => {
    const allowed = await canAccessBookmark(userId, bookmarkAId, null, tenantA);
    const denied = await canAccessBookmark(userId, bookmarkAId, null, tenantB);
    assert.strictEqual(allowed, true);
    assert.strictEqual(denied, false);
  });

  it('OIDC providers are tenant-scoped', async () => {
    const aRows = await query('SELECT provider_key FROM oidc_providers WHERE tenant_id = ?', [tenantA]);
    const bRows = await query('SELECT provider_key FROM oidc_providers WHERE tenant_id = ?', [tenantB]);
    assert.strictEqual((aRows as any[]).length, 1);
    assert.strictEqual((bRows as any[]).length, 1);
    assert.strictEqual((aRows as any[])[0].provider_key, 'tenanta');
    assert.strictEqual((bRows as any[])[0].provider_key, 'tenantb');
    const none = await queryOne('SELECT provider_key FROM oidc_providers WHERE tenant_id = ? AND provider_key = ?', [tenantA, 'tenantb']);
    assert.strictEqual(none, null);
  });

  it('tags are tenant-scoped', async () => {
    const tagAId = uuidv4();
    const tagBId = uuidv4();
    await execute('INSERT INTO tags (id, tenant_id, user_id, name) VALUES (?, ?, ?, ?)', [tagAId, tenantA, userId, 'tenant-a-tag']);
    await execute('INSERT INTO tags (id, tenant_id, user_id, name) VALUES (?, ?, ?, ?)', [tagBId, tenantB, userId, 'tenant-b-tag']);

    const tagsA = await query('SELECT id FROM tags WHERE tenant_id = ? AND user_id = ?', [tenantA, userId]);
    const tagsB = await query('SELECT id FROM tags WHERE tenant_id = ? AND user_id = ?', [tenantB, userId]);
    assert.ok((tagsA as any[]).some((t) => t.id === tagAId));
    assert.ok((tagsB as any[]).some((t) => t.id === tagBId));
    const cross = await queryOne('SELECT id FROM tags WHERE tenant_id = ? AND id = ?', [tenantA, tagBId]);
    assert.strictEqual(cross, null);
  });

  it('teams and memberships are tenant-scoped', async () => {
    const teamAId = uuidv4();
    const teamBId = uuidv4();
    await execute('INSERT INTO teams (id, tenant_id, name, description) VALUES (?, ?, ?, ?)', [teamAId, tenantA, 'Team A', null]);
    await execute('INSERT INTO teams (id, tenant_id, name, description) VALUES (?, ?, ?, ?)', [teamBId, tenantB, 'Team B', null]);
    await execute('INSERT INTO team_members (team_id, user_id, tenant_id) VALUES (?, ?, ?)', [teamAId, userId, tenantA]);
    await execute('INSERT INTO team_members (team_id, user_id, tenant_id) VALUES (?, ?, ?)', [teamBId, userId, tenantB]);

    const aTeamIds = await getTeamIdsForUser(userId, tenantA);
    const bTeamIds = await getTeamIdsForUser(userId, tenantB);
    assert.ok(aTeamIds.includes(teamAId));
    assert.ok(bTeamIds.includes(teamBId));
    assert.ok(!aTeamIds.includes(teamBId));
    assert.ok(!bTeamIds.includes(teamAId));
  });

  it('api tokens are tenant-scoped', async () => {
    const createdA = await createToken(userId, 'tenant-a-token', tenantA);
    const createdB = await createToken(userId, 'tenant-b-token', tenantB);
    assert.strictEqual(createdA.success, true);
    assert.strictEqual(createdB.success, true);

    const tokensA = await listTokens(userId, tenantA);
    const tokensB = await listTokens(userId, tenantB);
    assert.strictEqual(tokensA.length, 1);
    assert.strictEqual(tokensB.length, 1);
    assert.strictEqual(tokensA[0].name, 'tenant-a-token');
    assert.strictEqual(tokensB[0].name, 'tenant-b-token');

    const revokeWrongTenant = await revokeToken(userId, tokensA[0].id, tenantB);
    assert.strictEqual(revokeWrongTenant.success, false);
    const revokeRightTenant = await revokeToken(userId, tokensA[0].id, tenantA);
    assert.strictEqual(revokeRightTenant.success, true);
  });
});
