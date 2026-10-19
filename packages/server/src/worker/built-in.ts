import type { ModuleContribution, ServerModule } from "../create-server.ts";
import { eventJobs } from "../events/jobs.ts";
import type { JobDefinition } from "./job.ts";
import { invitationSendJob } from "./jobs/invitation-mail.ts";
import { mailJobs } from "./jobs/mail-send.ts";
import { workspaceDeleteJob } from "./jobs/workspace-delete.ts";
import { maintenanceContribution, type MaintenanceStores } from "./maintenance.ts";

/** The subscribers the composed modules registered for an event; read when a job runs, after composition. */
type SubscribersFor = Parameters<typeof eventJobs>[0];

interface BuiltIn {
  readonly name: string;
  readonly contribute: (stores: MaintenanceStores, subscribersFor: SubscribersFor) => ModuleContribution;
}

// The jobs every worker runs, whatever modules it composes: the one list the worker registers and
// `migrate` creates the queues from.
const BUILT_IN: readonly BuiltIn[] = [
  { name: "@slugbase/server/maintenance", contribute: maintenanceContribution },
  { name: "@slugbase/server/mail", contribute: () => ({ jobs: [...mailJobs, invitationSendJob] }) },
  // Removes the rows of a workspace that was marked as being deleted (doc 05 section 7.2).
  { name: "@slugbase/server/workspace-deletion", contribute: (stores) => ({ jobs: [workspaceDeleteJob(stores.workspaceDeletion)] }) },
  // One job per domain event, which hands the event to the subscribers of the composed modules.
  { name: "@slugbase/server/events", contribute: (_stores, subscribersFor) => ({ jobs: eventJobs(subscribersFor) }) },
];

export function createBuiltInModules(stores: MaintenanceStores, subscribersFor: SubscribersFor): readonly ServerModule[] {
  return BUILT_IN.map(({ name, contribute }) => ({ name, register: () => contribute(stores, subscribersFor) }));
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

/** The built-in jobs as definitions only, for a process that creates their queues and never runs them. */
export function builtInJobs(): readonly JobDefinition[] {
  return BUILT_IN.flatMap(({ contribute }) => contribute(NEVER_RUN, NO_SUBSCRIBERS).jobs ?? []);
}
