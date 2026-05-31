import { AccountsModule } from "./accounts/accounts.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { AiModule } from "./ai/ai.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { BillingModule } from "./billing/billing.module.js";
import { BookmarksModule } from "./bookmarks/bookmarks.module.js";
import { ChallengeModule } from "./challenge/challenge.module.js";
import { ContactModule } from "./contact/contact.module.js";
import { CryptoModule } from "./crypto/crypto.module.js";
import { DbModule } from "./db/db.module.js";
import { EntitlementsModule } from "./entitlements/entitlements.module.js";
import { ErrorReportingModule } from "./error-reporting/error-reporting.module.js";
import { ExportModule } from "./export/export.module.js";
import { FetchModule } from "./fetch/fetch.module.js";
import { FoldersModule } from "./folders/folders.module.js";
import { ImportModule } from "./import/import.module.js";
import { InvitationsModule } from "./invitations/invitations.module.js";
import { MailModule } from "./mail/mail.module.js";
import { OpenapiModule } from "./openapi/openapi.module.js";
import { SearchModule } from "./search/search.module.js";
import { SessionsModule } from "./sessions/sessions.module.js";
import { SetupModule } from "./setup/setup.module.js";
import { SharingModule } from "./sharing/sharing.module.js";
import { SlugsModule } from "./slugs/slugs.module.js";
import { TagsModule } from "./tags/tags.module.js";
import { TeamsModule } from "./teams/teams.module.js";
import { WorkspacesModule } from "./workspaces/workspaces.module.js";

export const domainModules = [
  AccountsModule,
  AdminModule,
  AiModule,
  AnalyticsModule,
  AuditModule,
  AuthModule,
  BillingModule,
  BookmarksModule,
  ChallengeModule,
  ContactModule,
  CryptoModule,
  DbModule,
  EntitlementsModule,
  ErrorReportingModule,
  ExportModule,
  FetchModule,
  FoldersModule,
  ImportModule,
  InvitationsModule,
  MailModule,
  OpenapiModule,
  SearchModule,
  SessionsModule,
  SetupModule,
  SharingModule,
  SlugsModule,
  TagsModule,
  TeamsModule,
  WorkspacesModule,
] as const;
