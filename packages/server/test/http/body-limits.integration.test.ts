import { connect } from "node:net";
import { defineOperation, jsonResponse, problemResponse } from "@slugbase/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer, type RunningServer, type ServerModule } from "../../src/create-server.ts";
import { DEFAULT_MAX_BODY_BYTES } from "../../src/http/body-limits.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig, documentOf } from "../support.ts";

// The failure scenario of the body-limits stage over a real socket: a chunked
// upload with no Content-Length that would run to a gibibyte is refused soon
// after the limit. The client is a raw socket: the repository allows no HTTP
// client outside the egress adapter.

const GIBIBYTE = 1024 * 1024 * 1024;
const CHUNK = Buffer.alloc(16 * 1024, 0x61);
// What the kernel may buffer between the two ends of the connection before the
// writer is held back; the bytes the client gets through are bounded by the
// limit plus this, never by the size of the upload.
const SOCKET_SLACK_BYTES = 8 * 1024 * 1024;

const sink: ServerModule = {
  name: "upload-sink",
  register: () => ({
    routes: [
      {
        operation: defineOperation({
          method: "post",
          path: "/api/v1/upload",
          operationId: "postUpload",
          tag: "test",
          auth: "anonymous",
          rate: "none",
          request: { body: z.strictObject({ note: z.string().optional() }) },
          responses: { 200: jsonResponse("ok", z.record(z.string(), z.unknown())), 400: problemResponse("bad request") },
        }),
        handler: async (context) => Response.json({ length: (await context.req.text()).length }),
      },
    ],
  }),
};

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

interface Upload {
  readonly head: string;
  readonly sent: number;
}

function chunkedUpload(port: number, total: number): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const received: Buffer[] = [];
    let sent = 0;
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      socket.destroy();
      resolve({ head: Buffer.concat(received).toString("utf8").split("\r\n\r\n")[0] ?? "", sent });
    };
    const pump = (): void => {
      while (!finished && sent < total) {
        sent += CHUNK.length;
        const hex = CHUNK.length.toString(16);
        socket.write(`${hex}\r\n`);
        if (!socket.write(Buffer.concat([CHUNK, Buffer.from("\r\n")]))) {
          socket.once("drain", pump);
          return;
        }
      }
    };
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (Buffer.concat(received).includes("\r\n\r\n")) {
        finish();
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET" || error.code === "EPIPE") {
        finish();
        return;
      }
      reject(error);
    });
    socket.on("close", finish);
    socket.write(
      "POST /api/v1/upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    pump();
  });
}

describe("the body-limits stage over a socket", () => {
  it("refuses a 1 GiB chunked upload soon after the limit and reads nothing like the whole body", async () => {
    const server = createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [sink],
      openApiDocument: documentOf([sink]),
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });
    const started = await server.start({ port: 0 });
    running.push(started);

    const { head, sent } = await chunkedUpload(started.port, GIBIBYTE);

    expect(head).toMatch(/^HTTP\/1\.1 413 /);
    expect(head.toLowerCase()).toContain("application/problem+json");
    expect(sent).toBeGreaterThan(DEFAULT_MAX_BODY_BYTES);
    expect(sent).toBeLessThan(DEFAULT_MAX_BODY_BYTES + SOCKET_SLACK_BYTES);
    expect(sent).toBeLessThan(GIBIBYTE / 64);
  }, 30_000);
});
