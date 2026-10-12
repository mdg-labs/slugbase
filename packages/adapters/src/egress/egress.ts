import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  EGRESS_MAX_REQUEST_BODY_BYTES,
  EgressBlocked,
  EgressError,
  EgressTimeout,
  EgressTooLarge,
  type EgressPort,
  type EgressRequest,
  type EgressResponse,
} from "@slugbase/core";
import { formatAddress, isPublicAddress, parseAddress, type ParsedAddress } from "./address.ts";

/** Resolves a host name to the addresses a connection to it could use. */
export type EgressResolver = (hostname: string) => Promise<readonly string[]>;

export interface CreateEgressOptions {
  /** The validated `NODE_ENV` of the process. */
  readonly nodeEnv: string;
  /** Replaces the system resolver. Its answers are validated like any other. */
  readonly resolve?: EgressResolver;
  /**
   * Allowances for tests that talk to a local server. The constructor throws when
   * any is given and `nodeEnv` is `production`.
   */
  readonly testOnly?: {
    /** Connects to loopback, private and other non-public addresses. */
    readonly allowNonPublicAddresses?: boolean;
    /** Certificate authority to trust, for a local HTTPS server. */
    readonly ca?: string | Buffer;
  };
}

interface Target {
  readonly url: URL;
  /** The host name, or the IP literal without brackets. */
  readonly hostname: string;
  readonly literal: ParsedAddress | undefined;
}

// Headers the adapter sets itself; a caller's value would change the framing or the host the request names.
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection"]);

// Errors of the connect phase, after which the next validated address may be tried.
const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "ETIMEDOUT",
]);

class ConnectFailure extends EgressError {}

function systemResolver(hostname: string): Promise<readonly string[]> {
  return lookup(hostname, { all: true, verbatim: true }).then((answers) => answers.map(({ address }) => address));
}

function parseTarget(text: string): Target {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new EgressBlocked();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new EgressBlocked();
  }
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname === "") {
    throw new EgressBlocked();
  }
  const literal = parseAddress(hostname);
  if (literal === undefined && hostname.includes(":")) {
    throw new EgressBlocked();
  }
  return { url, hostname, literal };
}

function raceDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new EgressTimeout());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    work.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error instanceof Error ? error : new EgressError());
      },
    );
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The egress adapter (doc 01 section 6, T6): the only module that opens a
 * connection on behalf of a request. It resolves the host itself, refuses the
 * request when any answer is not a public address, and connects to the address
 * it validated, with the host name kept for the `Host` header and the TLS server
 * name, so a second DNS answer cannot move the connection. One deadline covers
 * resolving, connecting and reading, and the response is cut off at `maxBytes`.
 * Redirects are returned to the caller as responses and are not followed.
 */
export class HttpEgress implements EgressPort {
  readonly available = true;
  readonly #resolve: EgressResolver;
  readonly #allowNonPublic: boolean;
  readonly #ca: string | Buffer | undefined;

  constructor(options: CreateEgressOptions) {
    if (options.testOnly !== undefined && options.nodeEnv === "production") {
      throw new Error("The egress test allowances cannot be used when NODE_ENV is production");
    }
    this.#resolve = options.resolve ?? systemResolver;
    this.#allowNonPublic = options.testOnly?.allowNonPublicAddresses === true;
    this.#ca = options.testOnly?.ca;
  }

  async request(request: EgressRequest): Promise<EgressResponse> {
    const { timeoutMs, maxBytes } = request;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("An egress request needs a positive time budget and a maximum size");
    }
    const method = request.method ?? "GET";
    const body = request.method === "POST" ? request.body : undefined;
    if (method === "POST" && body === undefined) {
      throw new RangeError("A POST egress request needs a body");
    }
    if (body !== undefined && body.length > EGRESS_MAX_REQUEST_BODY_BYTES) {
      throw new EgressTooLarge();
    }
    const target = parseTarget(request.url);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const addresses = await raceDeadline(this.#validatedAddresses(target), controller.signal);
      for (const address of addresses) {
        try {
          return await this.#exchange(target, address, method, request.headers, body, maxBytes, controller.signal);
        } catch (error) {
          if (!(error instanceof ConnectFailure)) {
            throw error;
          }
        }
      }
      throw new EgressError();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async #validatedAddresses(target: Target): Promise<string[]> {
    let answers: readonly ParsedAddress[];
    if (target.literal === undefined) {
      let texts: readonly string[];
      try {
        texts = await this.#resolve(target.hostname);
      } catch {
        // A name that does not resolve is refused like one that resolves to an internal address,
        // so the two cannot be told apart.
        throw new EgressBlocked();
      }
      const parsed = texts.map(parseAddress);
      if (parsed.length === 0 || parsed.some((address) => address === undefined)) {
        throw new EgressBlocked();
      }
      answers = parsed.filter((address): address is ParsedAddress => address !== undefined);
    } else {
      answers = [target.literal];
    }
    if (!this.#allowNonPublic && !answers.every(isPublicAddress)) {
      throw new EgressBlocked();
    }
    return answers.map(formatAddress);
  }

  #exchange(
    target: Target,
    address: string,
    method: string,
    callerHeaders: Readonly<Record<string, string>> | undefined,
    body: Uint8Array | undefined,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<EgressResponse> {
    const { url } = target;
    const secure = url.protocol === "https:";
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(callerHeaders ?? {})) {
      if (!RESERVED_HEADERS.has(name.toLowerCase())) {
        headers[name] = value;
      }
    }
    headers["host"] = url.host;
    headers["connection"] = "close";
    if (body !== undefined) {
      headers["content-length"] = body.length;
    }

    return new Promise<EgressResponse>((resolve, reject) => {
      let settled = false;
      let connected = false;
      let req: ReturnType<typeof httpRequest> | undefined;
      const onAbort = (): void => {
        settle(new EgressTimeout());
      };
      function settle(outcome: EgressResponse | Error): void {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (outcome instanceof Error) {
          req?.destroy();
          reject(outcome);
        } else {
          resolve(outcome);
        }
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      const options = {
        host: address,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
        agent: false,
        ...(secure && target.literal === undefined ? { servername: target.hostname } : {}),
        ...(secure && this.#ca !== undefined ? { ca: this.#ca } : {}),
      };
      try {
        req = (secure ? httpsRequest : httpRequest)(options, (res: IncomingMessage) => {
          const declared = Number(headerValue(res.headers["content-length"]));
          if (method !== "HEAD" && Number.isFinite(declared) && declared > maxBytes) {
            settle(new EgressTooLarge());
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
              settle(new EgressTooLarge());
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            settle({
              url: url.href,
              status: res.statusCode ?? 0,
              contentType: headerValue(res.headers["content-type"]),
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
          res.on("error", () => {
            settle(new EgressError());
          });
          res.on("close", () => {
            settle(new EgressError());
          });
        });
        req.on("socket", (socket) => {
          socket.once("connect", () => {
            connected = true;
          });
        });
        req.on("error", (error: NodeJS.ErrnoException) => {
          // Only a connection that was never established is tried again on the next address, so a
          // request body is never sent twice.
          const retryable = !connected && error.code !== undefined && CONNECT_ERRORS.has(error.code);
          settle(retryable ? new ConnectFailure() : new EgressError());
        });
        req.end(body === undefined ? undefined : Buffer.from(body));
      } catch {
        settle(new EgressError());
      }
    });
  }
}
