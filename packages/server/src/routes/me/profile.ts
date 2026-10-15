import { getMe, updateMe } from "@slugbase/contracts";
import { accountProfileRepository, membershipRepository, type AccountProfile, type Database } from "@slugbase/db";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { route } from "../register.ts";

// GET /api/v1/me (doc 04 section 10.3): the signed-in account with its
// memberships and the workspace the request acts in. It reads the account's own
// row and memberships in an account-level transaction, on row-level security,
// and selects no hash and no secret. A browser error reporter's DSN is the
// session's alone: it is not asked for on behalf of an API token.
//
// PATCH /api/v1/me changes the profile (display name, language) and the
// preferences (theme, accent, default view, single-key shortcuts, AI opt-out,
// analytics consent, onboarding state) of the account the session belongs to and
// answers the account afterwards, applying every change in one statement. The account is the
// principal's, never a value of the request, and the body is a closed object, so
// a field the operation does not declare is a 422 before the handler runs.

export interface ProfileRoutesOptions {
  readonly withTenant: Database["withTenant"];
}

function accountBody(profile: AccountProfile) {
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.displayName,
    locale: profile.locale,
    theme: profile.theme,
    accent: profile.accent,
    defaultView: profile.defaultBookmarkView,
    singleKeyShortcuts: profile.singleKeyShortcuts,
    aiOptOut: profile.aiOptOut,
    analyticsConsent: profile.analyticsConsent,
    onboarding: profile.onboarding,
    emailVerified: profile.emailVerified,
    hasPassword: profile.hasPassword,
    mfaEnabled: profile.mfaEnabled,
  };
}

export function profileRoutes({ withTenant }: ProfileRoutesOptions): RouteBinding[] {
  return [
    route(getMe).handle(async (_request, context) => {
      const principal = context.get("principal");
      if (principal === undefined) {
        throw new ProblemError("unauthenticated", "Authentication is required.");
      }
      const { accountId } = principal;
      const { profile, memberships } = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => ({
        profile: await accountProfileRepository(tx).profile(),
        memberships: await membershipRepository(tx).list(),
      }));
      if (profile === undefined) {
        throw new ProblemError("unauthenticated", "Authentication is required.");
      }
      const workspaceId = context.get("tenant")?.workspaceId;
      const dsn = principal.kind === "session" ? await context.get("hooks")?.clientErrorReportDsn({ accountId, workspaceId }) : null;
      return {
        status: 200,
        body: {
          account: accountBody(profile),
          memberships: memberships.map(({ workspaceId: id, name, role }) => ({ workspaceId: id, name, role })),
          activeWorkspaceId: workspaceId ?? null,
          ...(dsn === null || dsn === undefined ? {} : { clientErrorReportDsn: dsn }),
        },
      };
    }),
    route(updateMe).handle(async ({ body }, context) => {
      const principal = context.get("principal");
      if (principal === undefined) {
        throw new ProblemError("unauthenticated", "Authentication is required.");
      }
      const profile = await withTenant({ accountId: principal.accountId, requestId: requestIdOf(context) }, (tx) =>
        accountProfileRepository(tx).updateProfile({
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          ...(body.locale === undefined ? {} : { locale: body.locale }),
          ...(body.theme === undefined ? {} : { theme: body.theme }),
          ...(body.accent === undefined ? {} : { accent: body.accent }),
          ...(body.defaultView === undefined ? {} : { defaultBookmarkView: body.defaultView }),
          ...(body.singleKeyShortcuts === undefined ? {} : { singleKeyShortcuts: body.singleKeyShortcuts }),
          ...(body.aiOptOut === undefined ? {} : { aiOptOut: body.aiOptOut }),
          ...(body.analyticsConsent === undefined ? {} : { analyticsConsent: body.analyticsConsent }),
          ...(body.onboarding === undefined ? {} : { onboarding: body.onboarding }),
        }),
      );
      if (profile === undefined) {
        throw new ProblemError("unauthenticated", "Authentication is required.");
      }
      return { status: 200, body: accountBody(profile) };
    }),
  ];
}
