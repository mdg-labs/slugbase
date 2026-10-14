import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline, Writable, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
    /** Connects to exactly these addresses although they are not public; every other address is still checked. */
    readonly allowAddresses?: readonly string[];
    /** Certificate authority to trust, for a local HTTPS server. */
    readonly ca?: string | Buffer;
    /**
     * Resolves through these DNS servers (`address` or `address:port`), asking for A and AAAA records,
     * instead of the system resolver, so a test can serve the answers. Not combined with `resolve`.
     */
    readonly dnsServers?: readonly string[];
  };
}

interface Target {
  readonly url: URL;
  /** The host name, or the IP literal without brackets. */
  readonly hostname: string;
  readonly literal: ParsedAddress | undefined;
}

// Headers the adapter sets itself; a caller's value would change the framing or the host the request names.
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "accept-encoding"]);

// The only caller headers that follow a redirect to another origin. Any other header may carry a
// credential the adapter cannot recognise by name, so it stays with the origin it was sent to.
const CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "user-agent"]);

// The response to these statuses names where to ask next in `Location`.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// The redirects followed for one request; the sixth is refused.
const MAX_REDIRECTS = 5;

// The content encodings the adapter undoes, so that the size cap applies to the decoded body.
const ACCEPT_ENCODING = "gzip, deflate, br";
const MAX_ENCODINGS = 3;
const DECODERS: Readonly<Record<string, () => Readable>> = {
  gzip: createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
};

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

type Hop =
  | { readonly kind: "response"; readonly response: EgressResponse }
  | { readonly kind: "redirect"; readonly status: number; readonly location: string };

function systemResolver(hostname: string): Promise<readonly string[]> {
  return lookup(hostname, { all: true, verbatim: true }).then((answers) => answers.map(({ address }) => address));
}

// The records of a name that has none are an empty answer; every other failure is the resolver's.
function recordsOrNone(query: Promise<string[]>): Promise<string[]> {
  return query.catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") {
      return [];
    }
    throw error;
  });
}

function serverResolver(servers: readonly string[]): EgressResolver {
  const resolver = new Resolver({ timeout: 1_000, tries: 1 });
  resolver.setServers([...servers]);
  return async (hostname) => {
    const [v4, v6] = await Promise.all([
      recordsOrNone(resolver.resolve4(hostname)),
      recordsOrNone(resolver.resolve6(hostname)),
    ]);
    return [...v4, ...v6];
  };
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

function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

function withoutFragment(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

// A relative `Location` is resolved against the URL that answered; text that is no URL is refused like any bad target.
function redirectTarget(location: string, base: URL): string {
  try {
    return new URL(location, base).href;
  } catch {
    throw new EgressBlocked();
  }
}

function withoutHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  dropped: ReadonlySet<string>,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name.toLowerCase())));
}

function onlyHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  kept: ReadonlySet<string>,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => kept.has(name.toLowerCase())));
}

// The decoders for a `Content-Encoding` header, in the order the body is decoded; undefined when the
// adapter cannot undo an encoding, because a size cap on bytes it cannot decode would not be a cap on the body.
function decodersFor(header: string | undefined): Readable[] | undefined {
  const encodings = (header ?? "")
    .toLowerCase()
    .split(",")
    .map((encoding) => encoding.trim())
    .filter((encoding) => encoding !== "" && encoding !== "identity");
  if (encodings.length > MAX_ENCODINGS) {
    return undefined;
  }
  const decoders: Readable[] = [];
  for (const encoding of encodings.reverse()) {
    const create = Object.hasOwn(DECODERS, encoding) ? DECODERS[encoding] : undefined;
    if (create === undefined) {
      return undefined;
    }
    decoders.push(create());
  }
  return decoders;
}

/**
 * The egress adapter (doc 01 section 6, T6): the only module that opens a
 * connection on behalf of a request. It resolves the host itself, refuses the
 * request when any answer is not a public address, and connects to the address
 * it validated, with the host name kept for the `Host` header and the TLS server
 * name, so a second DNS answer cannot move the connection. Redirects are
 * followed by hand, a bounded number of times, and every hop is resolved,
 * validated and pinned afresh like the first request. A redirect to another
 * origin carries only a few named headers, and is refused when it would carry
 * the request body. One deadline covers every
 * hop's resolving, connecting and reading, and the decoded body is cut off at
 * `maxBytes`. A response outside the caller's content-type allowlist is refused
 * once its headers arrive.
 */
export class HttpEgress implements EgressPort {
  readonly available = true;
  readonly #resolve: EgressResolver;
  readonly #allowNonPublic: boolean;
  readonly #allowedAddresses: ReadonlySet<string>;
  readonly #ca: string | Buffer | undefined;

  constructor(options: CreateEgressOptions) {
    if (options.testOnly !== undefined && options.nodeEnv === "production") {
      throw new Error("The egress test allowances cannot be used when NODE_ENV is production");
    }
    const dnsServers = options.testOnly?.dnsServers;
    if (dnsServers !== undefined && options.resolve !== undefined) {
      throw new Error("The egress adapter takes a resolver or DNS servers, not both");
    }
    this.#resolve = options.resolve ?? (dnsServers === undefined ? systemResolver : serverResolver(dnsServers));
    this.#allowNonPublic = options.testOnly?.allowNonPublicAddresses === true;
    this.#allowedAddresses = new Set(
      (options.testOnly?.allowAddresses ?? []).map((text) => {
        const parsed = parseAddress(text);
        if (parsed === undefined) {
          throw new Error("An egress test allowance needs an IP address");
        }
        return formatAddress(parsed);
      }),
    );
    this.#ca = options.testOnly?.ca;
  }

  async request(request: EgressRequest): Promise<EgressResponse> {
    const { timeoutMs, maxBytes } = request;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("An egress request needs a positive time budget and a maximum size");
    }
    let method: string = request.method ?? "GET";
    let body = request.method === "POST" ? request.body : undefined;
    if (method === "POST" && body === undefined) {
      throw new RangeError("A POST egress request needs a body");
    }
    if (body !== undefined && body.length > EGRESS_MAX_REQUEST_BODY_BYTES) {
      throw new EgressTooLarge();
    }
    const accepted =
      request.acceptContentTypes === undefined
        ? undefined
        : new Set(request.acceptContentTypes.map((type) => mediaType(type)));
    let target = parseTarget(request.url);
    let headers = request.headers;
    const visited = new Set([withoutFragment(target.url)]);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      for (let redirects = 0; ; redirects += 1) {
        const addresses = await raceDeadline(this.#validatedAddresses(target), controller.signal);
        const hop = await this.#connect(target, addresses, method, headers, body, maxBytes, accepted, controller.signal);
        if (hop.kind === "response") {
          return hop.response;
        }
        const next = parseTarget(redirectTarget(hop.location, target.url));
        if (visited.has(withoutFragment(next.url)) || redirects === MAX_REDIRECTS) {
          throw new EgressError();
        }
        visited.add(withoutFragment(next.url));
        if (hop.status === 303 ? method !== "HEAD" : (hop.status === 301 || hop.status === 302) && method === "POST") {
          method = "GET";
          body = undefined;
          headers = withoutHeaders(headers, new Set(["content-type"]));
        }
        if (next.url.origin !== target.url.origin) {
          // A 307 or 308 keeps the body, which another origin must not receive.
          if (body !== undefined) {
            throw new EgressError();
          }
          headers = onlyHeaders(headers, CROSS_ORIGIN_HEADERS);
        }
        target = next;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async #connect(
    target: Target,
    addresses: readonly string[],
    method: string,
    headers: Readonly<Record<string, string>> | undefined,
    body: Uint8Array | undefined,
    maxBytes: number,
    accepted: ReadonlySet<string | undefined> | undefined,
    signal: AbortSignal,
  ): Promise<Hop> {
    for (const address of addresses) {
      try {
        return await this.#exchange(target, address, method, headers, body, maxBytes, accepted, signal);
      } catch (error) {
        if (!(error instanceof ConnectFailure)) {
          throw error;
        }
      }
    }
    throw new EgressError();
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
    const permitted = (address: ParsedAddress): boolean =>
      isPublicAddress(address) || this.#allowedAddresses.has(formatAddress(address));
    if (!this.#allowNonPublic && !answers.every(permitted)) {
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
    accepted: ReadonlySet<string | undefined> | undefined,
    signal: AbortSignal,
  ): Promise<Hop> {
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
    headers["accept-encoding"] = ACCEPT_ENCODING;
    if (body !== undefined) {
      headers["content-length"] = body.length;
    }

    return new Promise<Hop>((resolve, reject) => {
      let settled = false;
      let connected = false;
      let req: ReturnType<typeof httpRequest> | undefined;
      const onAbort = (): void => {
        settle(new EgressTimeout());
      };
      function settle(outcome: Hop | Error): void {
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
          const status = res.statusCode ?? 0;
          const location = headerValue(res.headers["location"]);
          if (REDIRECT_STATUSES.has(status) && location !== undefined) {
            // The body of a redirect is never read.
            settle({ kind: "redirect", status, location });
            req?.destroy();
            return;
          }
          const contentType = headerValue(res.headers["content-type"]);
          if (accepted !== undefined && !accepted.has(mediaType(contentType))) {
            settle(new EgressError());
            return;
          }
          const encoding = headerValue(res.headers["content-encoding"]);
          const declared = Number(headerValue(res.headers["content-length"]));
          const hasBody = method !== "HEAD" && status >= 200 && status !== 204 && status !== 304 && declared !== 0;
          const decoders = hasBody ? decodersFor(encoding) : [];
          if (decoders === undefined) {
            settle(new EgressError());
            return;
          }
          // A declared length is the encoded size when the body is encoded; then only the decoded bytes count.
          if (hasBody && decoders.length === 0 && Number.isFinite(declared) && declared > maxBytes) {
            settle(new EgressTooLarge());
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          const sink = new Writable({
            write(chunk: Buffer, _encoding, done): void {
              received += chunk.length;
              if (received > maxBytes) {
                done(new EgressTooLarge());
                return;
              }
              chunks.push(chunk);
              done();
            },
          });
          pipeline([res, ...decoders, sink], (error) => {
            if (error) {
              settle(error instanceof EgressError ? error : new EgressError());
              return;
            }
            settle({
              kind: "response",
              response: { url: url.href, status, contentType, body: new Uint8Array(Buffer.concat(chunks)) },
            });
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
