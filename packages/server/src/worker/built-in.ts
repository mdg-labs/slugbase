import type { ModuleContext, ModuleContribution, ServerModule } from "../create-server.ts";
import { eventJobs } from "../events/jobs.ts";
import type { JobDefinition } from "./job.ts";
import { fetchFaviconJob } from "./jobs/fetch-favicon.ts";
import { fetchMetadataJob } from "./jobs/fetch-metadata.ts";
import { invitationSendJob } from "./jobs/invitation-mail.ts";
import { mailJobs } from "./jobs/mail-send.ts";
import { workspaceDeleteJob } from "./jobs/workspace-delete.ts";
import { maintenanceContribution, type MaintenanceStores } from "./maintenance.ts";
import { memberDepartureContribution } from "./member-departure.ts";

/** The subscribers the composed modules registered for an event; read when a job runs, after composition. */
type SubscribersFor = Parameters<typeof eventJobs>[0];

/** What a built-in module reads of the module context. */
type BuiltInContext = Pick<ModuleContext, "withTenant" | "logger">;

interface BuiltIn {
  readonly name: string;
  readonly contribute: (stores: MaintenanceStores, subscribersFor: SubscribersFor, context: BuiltInContext) => ModuleContribution;
}

// The jobs every worker runs, whatever modules it composes: the one list the worker registers and
// `migrate` creates the queues from.
const BUILT_IN: readonly BuiltIn[] = [
  { name: "@slugbase/server/maintenance", contribute: maintenanceContribution },
  { name: "@slugbase/server/mail", contribute: () => ({ jobs: [...mailJobs, invitationSendJob] }) },
  // Fetches and caches the metadata of the page a bookmark points at (doc 02 section 5.4).
  { name: "@slugbase/server/bookmark-metadata", contribute: () => ({ jobs: [fetchMetadataJob] }) },
  // Fetches and caches the favicon of a host a member has a bookmark on (doc 02 section 5.4).
  { name: "@slugbase/server/favicons", contribute: () => ({ jobs: [fetchFaviconJob] }) },
  // Removes the rows of a workspace that was marked as being deleted (doc 05 section 7.2).
  { name: "@slugbase/server/workspace-deletion", contribute: (stores) => ({ jobs: [workspaceDeleteJob(stores.workspaceDeletion)] }) },
  // Applies the content choice of a departure when `member.left` is delivered (doc 02 section 3.6).
  { name: "@slugbase/server/member-departure", contribute: (_stores, _subscribersFor, context) => memberDepartureContribution(context) },
  // One job per domain event, which hands the event to the subscribers of the composed modules.
  { name: "@slugbase/server/events", contribute: (_stores, subscribersFor) => ({ jobs: eventJobs(subscribersFor) }) },
];

export function createBuiltInModules(stores: MaintenanceStores, subscribersFor: SubscribersFor): readonly ServerModule[] {
  return BUILT_IN.map(({ name, contribute }) => ({ name, register: (context) => contribute(stores, subscribersFor, context) }));
}

const NEVER_RUN: MaintenanceStores = {
  rateLimit: { purgeIdle: () => Promise.reject(new Error("a job list read for its queues does not run jobs")) },
  retention: { purge: () => Promise.reject(new Error("a job list read for its queues does not run jobs")) },
  workspaceDeletion: {
    purgeRows: () => Promise.reject(new Error("a job list read for its queues does not run jobs")),
    finish: () => Promise.reject(new Error("a job list read for its queues does not run jobs")),
  },
};

const NO_SUBSCRIBERS: SubscribersFor = () => [];

const NEVER_RUN_CONTEXT: BuiltInContext = {
  withTenant: () => Promise.reject(new Error("a job list read for its queues does not run jobs")),
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
};

/** The built-in jobs as definitions only, for a process that creates their queues and never runs them. */
export function builtInJobs(): readonly JobDefinition[] {
  return BUILT_IN.flatMap(({ contribute }) => contribute(NEVER_RUN, NO_SUBSCRIBERS, NEVER_RUN_CONTEXT).jobs ?? []);
}
