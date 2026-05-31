import type { DrizzleClient } from "./dialect/create-client.js";
import type { DbDialect } from "./dialect/dialect.js";

export interface DbClientPort {
  readonly dialect: DbDialect;
  getOrm(): DrizzleClient;
}
