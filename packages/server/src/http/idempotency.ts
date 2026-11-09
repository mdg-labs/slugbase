import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAYED_HEADER, type AuthPolicy } from "@slugbase/contracts";
import { IdempotencyBusyError, idempotencyRepository, type Database, type StoredResponse, type TenantTx } from "@slugbase/db";
import { bodyBytes, decodedForm } from "./body-limits.ts";
import type { ChainContext, RequestStage } from "./chain.ts";
import { ProblemError, requestIdOf } from "./problem.ts";

// Stage 9a of the chain (doc 01 section 4, doc 04 section 6.3, doc 10 T1): an operation that declares
// `idempotency` accepts an `Idempotency-Key`, a client-generated UUID that belongs to the account. The stage
// runs after authorization, so a replay is judged by the same policy as the first request. It opens the
// transaction the handler runs in and claims the key in it; the handler's own `withTenant` joins that
// transaction, so the key, the handler's writes and the stored response commit together or not at all:
//   - a key not seen before runs the handler and stores its 2xx response in the commit;
//   - a key whose request finished, asked again the same way, answers the stored response with
//     `Idempotency-Replayed: true` and runs nothing;
//   - the same key with another operation, workspace or request is `409 idempotency_conflict`;
//   - a key held by a request still running makes this one wait on the key; it then replays the response
//     once the first request has committed, runs itself if the first rolled back, and answers
//     `503 unavailable` if the first is still running after the repository's wait.
// A request that ends in a problem or in a status other than 2xx rolls back, key included, so a retry runs.
// The claim of a workspace operation locks the workspace's row (FOR KEY SHARE) before it inserts the key, whose
// foreign key locks the account's row: account deletion locks the workspaces and then the account (doc 05 section
// 7.1), so the two requests take the rows in one order and cannot deadlock.
// The body of a route that declares `acceptsMultipart` is not in the validated input, so its request hash also covers the parts of the upload (`uploadDigest`): the same key with another file is a
// conflict and not a replay of the first answer. The digest is of the content of the parts and not of the bytes of the request, which carry a boundary the client picks anew on every attempt.
// The parts are decoded once for the request (`decodedForm` of the body-limits stage); the handler reads the same decoded form.
// A request without the header runs as usual. The handler of an operation that declares idempotency must
// open its transaction through `tenant.withTenant` for a workspace operation, or `withTenant` with the
// account alone for an account operation, which is what this stage opens.

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const DETAILS = {
  bad_key: `${IDEMPOTENCY_KEY_HEADER} must be a single UUID.`,
  conflict: `${IDEMPOTENCY_KEY_HEADER} was used for another request.`,
  busy: `A request with this ${IDEMPOTENCY_KEY_HEADER} is still running.`,
} as const;

/** The operations whose handler runs in the workspace of the request; the others act on the account. */
const WORKSPACE_POLICIES: ReadonlySet<AuthPolicy> = new Set(["member", "admin", "owner"]);

export interface IdempotencyOptions {
  /** Opens the account-level transaction of an operation that acts in no workspace. */
  readonly withTenant: Database["withTenant"];
}

/** The response of an operation that did not answer 2xx: it is returned as it is and nothing is stored. */
class NotStored extends Error {
  constructor() {
    super("the response is not stored");
    this.name = "NotStored";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, member]) => [name, canonical(member)]),
    );
  }
  return value === undefined ? null : value;
}

/**
 * SHA-256 of what the request asks for: the operation, the workspace it acts in and the parameters, query and
 * body as validated, with object members in a fixed order, so the same request spelled differently hashes the same.
 * An upload, which is no part of the validated input, adds its digest (`uploadDigest`); a request without one hashes as it always did.
 */
export function requestHash(context: ChainContext, operationId: string, upload?: string): Buffer {
  const input = context.get("input");
  const asked = canonical([operationId, context.get("workspaceId") ?? null, input?.params, input?.query, input?.body, ...(upload === undefined ? [] : [upload])]);
  return createHash("sha256").update(JSON.stringify(asked)).digest();
}

/**
 * SHA-256 of the parts of a multipart request, in order: each part's name, whether it is text or a file, and its content, each length-prefixed so that no two requests share a digest by where one part
 * ends. The filename and the part headers are left out, and so is the boundary. A body that is not multipart (the handler answers it `415` or `400`, which stores nothing) is digested as the bytes it is.
 */
export async function uploadDigest(request: Request): Promise<string> {
  const digest = createHash("sha256");
  const add = (bytes: Uint8Array): void => {
    digest.update(`${String(bytes.byteLength)}:`);
    digest.update(bytes);
  };
  try {
    for (const [name, value] of await decodedForm(request)) {
      add(new TextEncoder().encode(name));
      if (typeof value === "string") {
        digest.update("s");
        add(new TextEncoder().encode(value));
      } else {
        digest.update("f");
        add(new Uint8Array(await value.arrayBuffer()));
      }
    }
    return `parts:${digest.digest("hex")}`;
  } catch {
    return `bytes:${createHash("sha256").update(await bodyBytes(request)).digest("hex")}`;
  }
}

function replay({ status, body }: StoredResponse): Response {
  if (body === null) {
    return new Response(null, { status, headers: { [IDEMPOTENCY_REPLAYED_HEADER]: "true" } });
  }
  return new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_CONTENT_TYPE, [IDEMPOTENCY_REPLAYED_HEADER]: "true" } });
}

async function storable(response: Response): Promise<StoredResponse> {
  const text = await response.clone().text();
  if (text === "") {
    return { status: response.status, body: null };
  }
  return { status: response.status, body: JSON.parse(text) as unknown };
}

export function createIdempotency({ withTenant }: IdempotencyOptions): RequestStage {
  return async (context, next) => {
    const route = context.get("route");
    const header = context.req.header(IDEMPOTENCY_KEY_HEADER);
    if (route?.operation.idempotency !== true || header === undefined) {
      return next();
    }
    if (!KEY.test(header)) {
      throw new ProblemError("bad_request", DETAILS.bad_key);
    }
    const key = header.toLowerCase();
    const principal = context.get("principal");
    if (principal === undefined) {
      throw new Error(`${route.operation.operationId} declares idempotency and was reached without a principal`);
    }
    const tenant = context.get("tenant");
    const inWorkspace = WORKSPACE_POLICIES.has(route.operation.auth);
    if (inWorkspace && tenant === undefined) {
      throw new Error(`${route.operation.operationId} declares idempotency in a workspace and was reached without one`);
    }
    const run = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
      inWorkspace && tenant !== undefined ? tenant.withTenant(fn) : withTenant({ accountId: principal.accountId, requestId: requestIdOf(context) }, fn);

    const operationId = route.operation.operationId;
    const hash = requestHash(context, operationId, route.acceptsMultipart === true ? await uploadDigest(context.req.raw) : undefined);
    try {
      return await run(async (tx) => {
        const repository = idempotencyRepository(tx);
        const outcome = await repository.claim({ key, operation: operationId, requestHash: hash });
        if (outcome.kind === "conflict") {
          throw new ProblemError("idempotency_conflict", DETAILS.conflict);
        }
        if (outcome.kind === "replay") {
          return replay(outcome.response);
        }
        await next();
        const answered = context.res;
        if (answered.status < 200 || answered.status > 299) {
          throw new NotStored();
        }
        await repository.complete(key, await storable(answered));
        return undefined;
      });
    } catch (error) {
      if (error instanceof NotStored) {
        return undefined;
      }
      if (error instanceof IdempotencyBusyError) {
        throw new ProblemError("unavailable", DETAILS.busy);
      }
      throw error;
    }
  };
}
