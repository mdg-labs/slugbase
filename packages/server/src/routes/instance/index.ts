import { getInstanceStatus } from "@slugbase/contracts";
import type { Adapters, RegistrationSettings } from "@slugbase/core";
import { instanceRepository, migrationLevel, type Database, type MigrationChain } from "@slugbase/db";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { BuildInfo } from "../../build-info.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
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

export function instanceRoutes({ withTenant, databaseUrl, chains, buildInfo, adapters, registration }: InstanceRoutesOptions): RouteBinding[] {
  return [
    route(getInstanceStatus).handle(async (_request, context) => {
      const principal = context.get("principal");
      if (principal?.kind !== "session") {
        throw new ProblemError("forbidden", "You do not have access to this resource.");
      }
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
  ];
}
