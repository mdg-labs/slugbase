import { parentPort } from "node:worker_threads";
import { runImportJob, type ImportJob } from "./job.ts";

// The entry of the import worker thread (doc 01 section 8.1): it answers each message `{ id, job }` of `client.ts` with `{ id, outcome }`, or with `{ id, failure: true }` when the job throws, and does one job at a time. The
// thread keeps nothing between jobs. The bytes of a job arrive transferred, and a body that is large comes back as a transferred buffer, never copied.

const port = parentPort;
if (port === null) {
  throw new Error("the import worker runs as a worker thread only");
}

port.on("message", (message: { readonly id: number; readonly job: ImportJob }) => {
  runImportJob(message.job).then(
    (outcome) => {
      const transfer = outcome.kind === "prepared" && outcome.canonicalBody !== undefined ? [outcome.canonicalBody.buffer as ArrayBuffer] : [];
      port.postMessage({ id: message.id, outcome }, transfer);
    },
    () => {
      port.postMessage({ id: message.id, failure: true });
    },
  );
});
