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

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
}
