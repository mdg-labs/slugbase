import { createAiStub } from "./stub.ts";

// The entry point of the stub as the service of e2e/compose.ai.yml runs it: `node main.ts`, with the shipped image's Node, from a read-only mount.
const port = Number(process.env.AI_STUB_PORT ?? "8080");
createAiStub().server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`the AI stub listens on ${String(port)}\n`);
});
