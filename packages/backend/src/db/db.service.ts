import { Injectable } from "@nestjs/common";

import type { DbClientPort } from "./db.interface.js";
import type { DrizzleClient } from "./dialect/create-client.js";

@Injectable()
export class DbService implements DbClientPort {
  constructor(private readonly orm: DrizzleClient) {}

  getOrm(): DrizzleClient {
    return this.orm;
  }
}
