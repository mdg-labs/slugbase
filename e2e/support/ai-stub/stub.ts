import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// A stand-in for an OpenAI-compatible endpoint, for the AI journey (tests/ai.spec.ts, doc 08 section 5.1). It answers the one request the
// server's adapter makes, `POST /v1/chat/completions`, and keeps every request it received so that the journey can read back what left the
// server: its method, path, the names of its headers (never their values) and its body. The answer is made from the address in the request:
// the title and the slug come from its host, and the first of the member's tags the request names is suggested first, as a model asked to
// prefer them would. A host that starts with `fail-` makes it answer 500, which is how a journey shows a provider that fails. It runs as a
// service of e2e/compose.ai.yml and is never part of an image.

/** The path of the one operation the adapter calls, under the base URL the stack gives the server. */
export const COMPLETIONS_PATH = "/v1/chat/completions";

/** The path the journey lists the received requests from (GET) and clears them at (DELETE). */
export const REQUESTS_PATH = "/requests";

const BODY_MAX_BYTES = 1_048_576;

export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  /** The names of the headers, in lower case. A value is never kept: it could be a credential. */
  readonly headers: readonly string[];
  readonly body: string;
}

export interface AiStub {
  readonly server: Server;
  readonly received: () => readonly ReceivedRequest[];
}

const BLOCK = /<bookmark_data>\n(.*)\n<\/bookmark_data>/s;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The data object of the user message of a chat completions body, or undefined where the body holds none. */
function dataOf(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = isRecord(parsed) ? parsed.messages : undefined;
    if (!Array.isArray(messages)) {
      return undefined;
    }
    for (const message of messages as unknown[]) {
      const content = isRecord(message) && message.role === "user" ? message.content : undefined;
      const block = typeof content === "string" ? BLOCK.exec(content)?.[1] : undefined;
      if (block !== undefined) {
        const data: unknown = JSON.parse(block);
        return isRecord(data) ? data : undefined;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function hostOf(data: Record<string, unknown> | undefined): string | undefined {
  try {
    return typeof data?.url === "string" ? new URL(data.url).hostname : undefined;
  } catch {
    return undefined;
  }
}

/** What the model answers for the data of a request, as the JSON text of the message the adapter reads. */
export function answerFor(data: Record<string, unknown> | undefined): string {
  const host = hostOf(data) ?? "page";
  const existing = Array.isArray(data?.existing_tags) ? (data.existing_tags as unknown[]).filter((tag): tag is string => typeof tag === "string") : [];
  return JSON.stringify({
    title: `Stub title for ${host}`,
    slug: host.split(".")[0],
    tags: [...existing.slice(0, 1), "stub-tag"],
    confidence: 0.9,
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk as Uint8Array);
    size += part.length;
    if (size > BODY_MAX_BYTES) {
      throw new Error("the body is larger than the stub keeps");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export function createAiStub(): AiStub {
  const requests: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://stub.invalid").pathname;
    const method = request.method ?? "GET";
    if (method === "GET" && path === "/health") {
      send(response, 200, { status: "ok" });
    } else if (method === "GET" && path === REQUESTS_PATH) {
      send(response, 200, requests);
    } else if (method === "DELETE" && path === REQUESTS_PATH) {
      requests.length = 0;
      send(response, 204);
    } else if (method === "POST" && path === COMPLETIONS_PATH) {
      readBody(request).then(
        (body) => {
          requests.push({ method, path, headers: Object.keys(request.headers).sort(), body });
          const data = dataOf(body);
          if (hostOf(data)?.startsWith("fail-") === true) {
            send(response, 500, { error: { message: "the stub fails on purpose" } });
            return;
          }
          send(response, 200, { choices: [{ index: 0, message: { role: "assistant", content: answerFor(data) }, finish_reason: "stop" }] });
        },
        () => {
          send(response, 413);
        },
      );
    } else {
      send(response, 404);
    }
  });
  return { server, received: () => requests };
}
