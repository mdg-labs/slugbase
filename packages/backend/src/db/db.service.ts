import { Injectable } from "@nestjs/common";

import type { DbClientPort } from "./db.interface.js";
import type { DrizzleClient } from "./dialect/create-client.js";
import type { DbDialect } from "./dialect/dialect.js";

@Injectable()
export class DbService implements DbClientPort {
  constructor(
    private readonly orm: DrizzleClient,
    readonly dialect: DbDialect,
  ) {}

  getOrm(): DrizzleClient {
    return this.orm;
  }
}
