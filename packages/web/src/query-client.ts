import { QueryClient } from "@tanstack/react-query";
import { ApiProblemError } from "./api/client.ts";

const MAX_RETRIES = 2;

// A problem response is the server's answer to this request and repeating the
// request gives the same answer for 4xx; only a failed transport or a 5xx is worth another try.
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiProblemError && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

// Doc 03 §13: a mutation made while the browser is offline queues nothing. TanStack Query's default network mode
// (`online`) pauses it and sends it when the connection returns, so a change is silently held and lost with the tab.
// `always` runs it at once; the request fails and the shared error toast names the offline cause. Queries keep the
// default: a paused read is replayed on reconnect and writes nothing.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: shouldRetry }, mutations: { networkMode: "always" } },
  });
}
