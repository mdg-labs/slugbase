import type postgres from "postgres";

const PUBLIC_PRODUCT_DDL = `
CREATE TABLE IF NOT EXISTS public.user_accounts (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  theme text NOT NULL DEFAULT 'auto',
  accent_color text,
  is_instance_admin boolean NOT NULL DEFAULT false,
  mfa_state text NOT NULL DEFAULT 'not_enrolled',
  mfa_totp_secret_encrypted text,
  ai_opt_out boolean NOT NULL DEFAULT false,
  default_bookmark_view text NOT NULL DEFAULT 'grid',
  onboarding_completed_at bigint,
  dashboard_checklist_dismissed boolean NOT NULL DEFAULT false,
  dashboard_checklist_manual text,
  pending_email text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'free',
  plan_seats integer,
  plan_archived boolean NOT NULL DEFAULT false,
  billing_customer_id text,
  billing_subscription_id text,
  billing_status text,
  billing_period_end bigint,
  permanent_personal boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.bookmarks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  slug text,
  forwarding_enabled boolean NOT NULL DEFAULT false,
  pinned boolean NOT NULL DEFAULT false,
  plan_archived boolean NOT NULL DEFAULT false,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  last_activity_at bigint NOT NULL,
  data text NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS public.workspace_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  invited_email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by_user_id text NOT NULL,
  accepted_at bigint,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.workspace_members (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  joined_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at bigint NOT NULL
);
`;

const PUBLIC_PRODUCT_TABLES = [
  "billing_webhook_events",
  "bookmarks",
  "sessions",
  "workspace_invitations",
  "workspace_members",
  "workspaces",
  "user_accounts",
] as const;

export async function ensurePublicProductTables(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(PUBLIC_PRODUCT_DDL);
}

export async function resetPublicProductTables(sql: postgres.Sql): Promise<void> {
  for (const table of PUBLIC_PRODUCT_TABLES) {
    await sql.unsafe(`TRUNCATE TABLE public.${table} RESTART IDENTITY CASCADE`);
  }
}

type SeedPublicProductOptions = {
  nowMs: number;
};

export async function seedPublicProductOverviewData(
  sql: postgres.Sql,
  { nowMs }: SeedPublicProductOptions,
): Promise<void> {
  const fiveDaysAgo = nowMs - 5 * 24 * 60 * 60 * 1000;
  const tenDaysAgo = nowMs - 10 * 24 * 60 * 60 * 1000;
  const fortyDaysAgo = nowMs - 40 * 24 * 60 * 60 * 1000;
  const futureExpiry = nowMs + 24 * 60 * 60 * 1000;
  const pastExpiry = nowMs - 24 * 60 * 60 * 1000;

  await sql`
    INSERT INTO public.user_accounts (
      id, email, name, password_hash, mfa_state, email_verified, language, ai_opt_out, created_at, updated_at
    ) VALUES
      ('u-old', 'old@slugbase.test', 'Old User', 'secret-hash-1', 'not_enrolled', false, 'en', false, ${fortyDaysAgo}, ${fortyDaysAgo}),
      ('u-recent', 'recent@slugbase.test', 'Recent User', 'secret-hash-2', 'enrolled', true, 'de', false, ${fiveDaysAgo}, ${fiveDaysAgo}),
      ('u-new', 'new@slugbase.test', 'New User', 'secret-hash-3', 'not_enrolled', true, 'en', true, ${nowMs - 2 * 24 * 60 * 60 * 1000}, ${nowMs - 2 * 24 * 60 * 60 * 1000})
  `;

  await sql`
    INSERT INTO public.workspaces (
      id, name, slug, plan, plan_seats, plan_archived, billing_status, billing_period_end, permanent_personal, created_at, updated_at
    ) VALUES
      ('ws-free', 'Free WS', 'free-ws', 'free', null, false, null, null, false, ${tenDaysAgo}, ${tenDaysAgo}),
      ('ws-personal', 'Personal WS', 'personal-ws', 'personal', null, false, 'active', ${futureExpiry}, false, ${tenDaysAgo}, ${tenDaysAgo}),
      ('ws-team', 'Team WS', 'team-ws', 'team', 5, false, 'trialing', ${futureExpiry}, false, ${nowMs}, ${nowMs})
  `;

  await sql`
    INSERT INTO public.workspace_members (id, workspace_id, user_id, role, joined_at) VALUES
      ('m-1', 'ws-free', 'u-old', 'OWNER', ${tenDaysAgo}),
      ('m-2', 'ws-personal', 'u-old', 'OWNER', ${tenDaysAgo}),
      ('m-3', 'ws-personal', 'u-recent', 'MEMBER', ${fiveDaysAgo}),
      ('m-4', 'ws-team', 'u-new', 'OWNER', ${nowMs})
  `;

  await sql`
    INSERT INTO public.bookmarks (
      id, workspace_id, user_id, title, url, plan_archived, access_count, created_at, updated_at
    ) VALUES
      ('b-active-1', 'ws-free', 'u-old', 'Active 1', 'https://example.com/1', false, 3, ${tenDaysAgo}, ${tenDaysAgo}),
      ('b-active-2', 'ws-personal', 'u-recent', 'Active 2', 'https://example.com/2', false, 1, ${tenDaysAgo}, ${tenDaysAgo}),
      ('b-archived', 'ws-team', 'u-new', 'Archived', 'https://example.com/3', true, 0, ${tenDaysAgo}, ${tenDaysAgo})
  `;

  await sql`
    INSERT INTO public.sessions (
      id, user_id, expires_at, created_at, last_activity_at, data
    ) VALUES
      ('s-active', 'u-recent', ${futureExpiry}, ${tenDaysAgo}, ${tenDaysAgo}, '{"token":"session-secret"}'),
      ('s-expired', 'u-old', ${pastExpiry}, ${fortyDaysAgo}, ${fortyDaysAgo}, '{"token":"expired-secret"}')
  `;

  await sql`
    INSERT INTO public.workspace_invitations (
      id, workspace_id, invited_email, role, token_hash, invited_by_user_id, accepted_at, expires_at, created_at
    ) VALUES
      ('inv-pending', 'ws-team', 'pending@slugbase.test', 'MEMBER', 'invite-token-hash-pending', 'u-new', null, ${futureExpiry}, ${tenDaysAgo}),
      ('inv-accepted', 'ws-team', 'accepted@slugbase.test', 'MEMBER', 'invite-token-hash-accepted', 'u-new', ${tenDaysAgo}, ${futureExpiry}, ${tenDaysAgo}),
      ('inv-expired', 'ws-team', 'expired@slugbase.test', 'MEMBER', 'invite-token-hash-expired', 'u-new', null, ${pastExpiry}, ${fortyDaysAgo})
  `;

  await sql`
    INSERT INTO public.billing_webhook_events (event_id, event_type, processed_at) VALUES
      ('evt-1', 'customer.subscription.updated', ${tenDaysAgo}),
      ('evt-2', 'customer.subscription.updated', ${tenDaysAgo}),
      ('evt-3', 'invoice.paid', ${nowMs})
  `;
}
