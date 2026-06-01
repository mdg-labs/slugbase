import type { DrizzleClient } from "./dialect/create-client.js";

export interface DbClientPort {
  getOrm(): DrizzleClient;
}
