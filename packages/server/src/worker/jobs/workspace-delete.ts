import type { WorkspaceDeletionStore } from "@slugbase/db";
import { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import { defineJob } from "../job.ts";

// `workspace.delete` (doc 05 section 7.2, doc 01 section 8.1): removes the rows of a workspace that
// `DELETE /api/v1/workspace` marked as being deleted. The job carries the workspace's identifier and nothing
// else. It empties each tenant table in batches, in the order of the registry in `@slugbase/db`, each batch in
// a transaction of its own, then deletes the workspace row, which cascades whatever is left, and queues
// `workspace.deleted` in the transaction that deletes it. It is idempotent and resumable: a run that stopped
// halfway, was released at shutdown or ran past its expiry is run again from the first table and finds the
// finished ones empty, and a run after the workspace is gone deletes nothing and announces nothing. It touches
// only the workspace it names and only while that workspace is being deleted: a payload that names a live
// workspace, or one that never existed, deletes nothing.

export const WORKSPACE_DELETE_JOB = "workspace.delete";

export function workspaceDeleteJob(store: WorkspaceDeletionStore) {
  return defineJob({
    name: WORKSPACE_DELETE_JOB,
    payload: z.object({ workspaceId: z.uuid() }),
    // A large workspace takes several attempts' worth of time at worst; every attempt resumes where the last stopped.
    retry: { limit: 10, delaySeconds: 30, backoff: true, maxDelaySeconds: 3600 },
    handle: async ({ workspaceId }, context) => {
      const deleted = await store.purgeRows(workspaceId);
      const finished = await store.finish(workspaceId, [queueDomainEvent(uuidv7(), "workspace.deleted", { workspaceId })]);
      if (finished) {
        context.logger.info("Workspace deleted", { deleted });
      } else {
        context.logger.warn("Nothing left to delete for the workspace; it is not being deleted, or is gone", { deleted });
      }
    },
  });
}
