import { parentPort, threadId } from "node:worker_threads";

// A stand-in for the import worker thread that behaves as the job's `contentType` says, so that the tests of the client can make a thread fail in each way a real one could.
parentPort.on("message", ({ id, job }) => {
  switch (job.contentType) {
    case "throw":
      throw new Error("the stub throws");
    case "exit":
      process.exit(3);
      break;
    case "wrong-id":
      parentPort.postMessage({ id: id + 100, outcome: {} });
      break;
    case "failure":
      parentPort.postMessage({ id, failure: true });
      break;
    case "hang":
      break;
    default:
      parentPort.postMessage({ id, outcome: { bytes: job.bytes.byteLength, threadId } });
  }
});
