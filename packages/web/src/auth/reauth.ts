import type { Middleware } from "openapi-fetch";

const REAUTH_PATH = "/api/v1/me/reauth";
const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** The request was not sent again because the member closed the re-authentication prompt without confirming. */
export class ReauthCancelled extends Error {
  constructor() {
    super("The re-authentication was cancelled");
    this.name = "ReauthCancelled";
  }
}

export function isReauthCancelled(error: unknown): boolean {
  return error instanceof ReauthCancelled;
}

type Listener = () => void;

/**
 * The state of the shared re-authentication prompt (doc 04 section 4.4). `request()` asks the member to
 * confirm; every caller that asks while the prompt is open waits on the same answer, so one prompt
 * serves a burst of requests that all need a fresh re-authentication.
 */
export interface Reauth {
  /** Opens the prompt; resolves `true` once the member has re-authenticated and `false` when they gave up. */
  request(): Promise<boolean>;
  /** Called by the prompt: closes it with the answer. */
  settle(confirmed: boolean): void;
  isOpen(): boolean;
  subscribe(listener: Listener): () => void;
}

export function createReauth(): Reauth {
  const listeners = new Set<Listener>();
  let pending: { promise: Promise<boolean>; resolve: (confirmed: boolean) => void } | undefined;

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    request() {
      if (pending === undefined) {
        let resolve: (confirmed: boolean) => void = () => undefined;
        const promise = new Promise<boolean>((done) => {
          resolve = done;
        });
        pending = { promise, resolve };
        notify();
      }
      return pending.promise;
    },
    settle(confirmed) {
      const current = pending;
      pending = undefined;
      current?.resolve(confirmed);
      notify();
    },
    isOpen: () => pending !== undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function asksForReauth(response: Response): Promise<boolean> {
  if (response.status !== 401 || !(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith(PROBLEM_CONTENT_TYPE)) {
    return false;
  }
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "reauth_required";
}

/**
 * Middleware of the API client with re-authentication built in: a `401 reauth_required` opens the prompt
 * and, once the member has confirmed, sends the same request one more time and answers with that result.
 * When the member gives up the request fails with `ReauthCancelled`. The re-authentication call itself is
 * never retried: its own `reauth_required` means the password was wrong. Register it after the problem
 * middleware, so the retried answer is the one that is turned into an error.
 */
export function reauthMiddleware(reauth: Reauth): Middleware {
  const unsent = new WeakMap<Request, Request>();
  return {
    onRequest({ request }) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        unsent.set(request, request.clone());
      }
      return undefined;
    },
    async onResponse({ request, response, options }) {
      const again = unsent.get(request);
      unsent.delete(request);
      if (again === undefined || new URL(request.url).pathname === REAUTH_PATH || !(await asksForReauth(response))) {
        return undefined;
      }
      if (!(await reauth.request())) {
        throw new ReauthCancelled();
      }
      return options.fetch(again);
    },
  };
}
