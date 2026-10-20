import { getInstanceSettings, getInstanceStatus, sendInstanceTestMail, updateInstanceSettings } from "@slugbase/contracts";
import type { Adapters, RegistrationSettings } from "@slugbase/core";
import { instanceRepository, migrationLevel, type Database, type MigrationChain } from "@slugbase/db";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { BuildInfo } from "../../build-info.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { route } from "../register.ts";

// The operations of the CE instance admin (doc 04 section 10.10, doc 02 section 11, doc 10 T3 and T15). Every one
// declares the `instanceAdmin` policy, which stage 9 enforces before a handler runs: a complete session of an account
// that holds the flag and has a second factor enrolled, and no API token. The operations are mounted on every
// deployment, a composition that has no admin answers every call 403, and the system operations they call check the
// account again inside the database.
//
// GET /api/v1/instance/status reports what the operator configured and what the instance holds: the build's version
// and the migration level, which optional ports are configured, the OIDC providers that answered discovery (slug
// and name), the registration settings in force, the counts, and the health of the background jobs. Nothing of it is
// a credential: a port is a boolean, a provider has no URL or secret, and the database URL is read, never returned.
// Reading the status is an action of the admin and is written to the instance audit stream in the same transaction
// that reads the counts.
//
// GET and PATCH /api/v1/instance/settings read and change the instance settings (doc 02 section 11.3). Both go
// through a `sys_instance_*` function that repeats the admin check in the database and writes the instance audit
// event in the same call: `instance.settings_viewed` for the read and `instance.settings_changed` for the change; a setting the body leaves out keeps its value and null
// clears one. The workspace routes read the stored `allowWorkspaceCreation` on every request, so a change applies
// on the next one.
//
// POST /api/v1/instance/mail/test queues a test message to the calling admin's address, as the `mail.send` job reads
// the address when it runs, and writes `instance.test_mail_queued` in the transaction that queues it. A deployment
// without a mail adapter answers `503 mail_unavailable` before anything is written.

export interface InstanceRoutesOptions {
  readonly withTenant: Database["withTenant"];
  /** `DATABASE_URL`: the migration level is read as `slugbase_app`, which `migrate` lets read the bookkeeping tables. */
  readonly databaseUrl: string;
  /** The migration sets this build ships after the CE chain, read when the request is served, once the composition is complete. */
  readonly chains: () => readonly MigrationChain[];
  readonly buildInfo: BuildInfo;
  /** What the status reports as configured; only whether a port is available, and the providers' slug and name, are read. */
  readonly adapters: Pick<Adapters, "mail" | "ai" | "identity" | "errors">;
  /** The settings in force for public registration and email verification. */
  readonly registration: RegistrationSettings;
}

const MAIL_UNAVAILABLE = "Email delivery is not available on this instance.";

function sessionOf(context: ChainContext): { readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("forbidden", "You do not have access to this resource.");
  }
  return principal;
}

export function instanceRoutes({ withTenant, databaseUrl, chains, buildInfo, adapters, registration }: InstanceRoutesOptions): RouteBinding[] {
  return [
    route(getInstanceStatus).handle(async (_request, context) => {
      const principal = sessionOf(context);
      const level = await migrationLevel({ url: databaseUrl, chains: chains() });
      const providers = adapters.identity.available ? await adapters.identity.listProviders() : [];
      const { counts, jobs } = await withTenant({ accountId: principal.accountId, requestId: requestIdOf(context) }, async (tx) => {
        const repository = instanceRepository(tx);
        return {
          counts: await repository.status(uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null),
          jobs: await repository.jobHealth(),
        };
      });
      return {
        status: 200,
        body: {
          version: buildInfo.version,
          migrations: { expected: level.expected, applied: level.applied },
          ports: { mail: adapters.mail.available, ai: adapters.ai.available, errorReporting: adapters.errors.available },
          oidcProviders: providers.map(({ id, displayName }) => ({ slug: id, name: displayName })),
          signIn: { publicRegistration: registration.publicRegistration, emailVerificationRequired: registration.emailVerificationRequired },
          counts,
          jobs: { queueDepth: jobs.queueDepth, failed: jobs.failed },
        },
      };
    }),

    route(getInstanceSettings).handle(async (_request, context) => {
      const { accountId } = sessionOf(context);
      const settings = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        instanceRepository(tx).viewSettings(uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null),
      );
      return { status: 200, body: settings };
    }),

    route(updateInstanceSettings).handle(async ({ body }, context) => {
      const { accountId } = sessionOf(context);
      const settings = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        instanceRepository(tx).updateSettings(body, uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null),
      );
      return { status: 200, body: settings };
    }),

    route(sendInstanceTestMail).handle(async (_request, context) => {
      const { accountId } = sessionOf(context);
      if (!adapters.mail.available) {
        throw new ProblemError("mail_unavailable", MAIL_UNAVAILABLE);
      }
      await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        instanceRepository(tx).recordTestMail(uuidv7(), networkPrefixOf(context.get("clientIp")) ?? null, queueMailSend(uuidv7(), "testMail", accountId)),
      );
      return { status: 202 };
    }),
  ];
}
