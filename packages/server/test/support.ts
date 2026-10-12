import { unconfigured, type Adapters } from "@slugbase/core";
import type { Database } from "@slugbase/db";
import { defineOperation, jsonResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import { z } from "zod";
import { loadConfig } from "../src/config/index.ts";
import type { Logger, ModuleContext } from "../src/create-server.ts";
import { productionEnv } from "./config/support.ts";

export interface RecordedLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The message of the line the request-context stage writes once per request. */
export const REQUEST_LINE = "Request completed";

/**
 * Records what is logged. `entries` holds every line except the per-request
 * line, which a test of another stage does not look at; that one is in `requests`.
 */
export function recordingLogger(): Logger & { readonly entries: RecordedLog[]; readonly requests: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const requests: RecordedLog[] = [];
  const record =
    (level: RecordedLog["level"]) =>
    (message: string, fields: Readonly<Record<string, unknown>> = {}): void => {
      (message === REQUEST_LINE ? requests : entries).push({ level, message, fields });
    };
  return { entries, requests, info: record("info"), warn: record("warn"), error: record("error") };
}

export function serverConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig("server", productionEnv(overrides)).config;
}

export function adapters(): Adapters {
  return unconfigured();
}

export interface FakeDatabase extends Database {
  readonly closed: { count: number };
}

export function fakeDatabase(): FakeDatabase {
  const closed = { count: 0 };
  return {
    closed,
    withTenant: (_context, fn) => fn({ accountId: "", workspaceId: undefined, requestId: "" }),
    close: () => {
      closed.count += 1;
      return Promise.resolve();
    },
  };
}

export function operation(method: "get" | "post", path: string, operationId: string): OperationDefinition {
  return defineOperation({
    method,
    path,
    operationId,
    tag: "test",
    auth: "anonymous",
    rate: "none",
    responses: {
      200: jsonResponse("ok", z.record(z.string(), z.unknown())),
      404: problemResponse("not found"),
    },
  });
}

export function moduleContext(config: ModuleContext["config"] = serverConfig()): ModuleContext {
  const database = fakeDatabase();
  return { config, logger: recordingLogger(), adapters: adapters(), withTenant: database.withTenant.bind(database) };
}
