import { jsonResponse, problemResponse } from "../../src/operations/define.ts";
import { getHealth } from "../../src/operations/meta.ts";
import { HealthStatusSchema } from "../../src/operations/meta.ts";

// Built without defineOperation's type check: the shape a careless edit could ship.
const withoutPolicy = {
  method: "post",
  path: "/api/v1/bookmarks",
  operationId: "createBookmarkWithoutPolicy",
  tag: "bookmarks",
  responses: {
    200: jsonResponse("ok", HealthStatusSchema),
    422: problemResponse("invalid"),
  },
} as unknown;

export const operations: readonly unknown[] = [getHealth, withoutPolicy];
