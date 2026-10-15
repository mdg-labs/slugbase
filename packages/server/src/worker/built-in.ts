import type { ModuleContribution, ServerModule } from "../create-server.ts";
import type { JobDefinition } from "./job.ts";
import { mailJobs } from "./jobs/mail-send.ts";
import { maintenanceContribution, type MaintenanceStores } from "./maintenance.ts";

interface BuiltIn {
  readonly name: string;
  readonly contribute: (stores: MaintenanceStores) => ModuleContribution;
}

// The jobs every worker runs, whatever modules it composes: the one list the worker registers and
// `migrate` creates the queues from.
const BUILT_IN: readonly BuiltIn[] = [
  { name: "@slugbase/server/maintenance", contribute: maintenanceContribution },
  { name: "@slugbase/server/mail", contribute: () => ({ jobs: mailJobs }) },
];

export function createBuiltInModules(stores: MaintenanceStores): readonly ServerModule[] {
  return BUILT_IN.map(({ name, contribute }) => ({ name, register: () => contribute(stores) }));
}

const NEVER_RUN: MaintenanceStores = {
  rateLimit: { purgeIdle: () => Promise.reject(new Error("a job list read for its queues does not run jobs")) },
  retention: { purge: () => Promise.reject(new Error("a job list read for its queues does not run jobs")) },
};

/** The built-in jobs as definitions only, for a process that creates their queues and never runs them. */
export function builtInJobs(): readonly JobDefinition[] {
  return BUILT_IN.flatMap(({ contribute }) => contribute(NEVER_RUN).jobs ?? []);
}
