import {
  Global,
  Inject,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";
import type { DbClientPort } from "./db.interface.js";
import { DbService } from "./db.service.js";
import { DB_CLIENT } from "./db.tokens.js";
import { createDbClient } from "./dialect/create-client.js";
import { InstanceMetadataRepository } from "./instance-metadata.repository.js";

interface DbClientRegistration {
  service: DbService;
  close: () => void;
}

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DbClientRegistration => {
        const handle = createDbClient(config.get("DATABASE_URL"));
        const service = new DbService(handle.client, handle.dialect);

        return {
          service,
          close: handle.close,
        };
      },
    },
    {
      provide: DbService,
      inject: [DB_CLIENT],
      useFactory: (registration: DbClientRegistration): DbService =>
        registration.service,
    },
    {
      provide: InstanceMetadataRepository,
      inject: [DbService],
      useFactory: (db: DbClientPort): InstanceMetadataRepository =>
        new InstanceMetadataRepository(db.getOrm()),
    },
  ],
  exports: [DbService, InstanceMetadataRepository],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(DB_CLIENT) private readonly registration: DbClientRegistration) {}

  onModuleDestroy(): void {
    this.registration.close();
  }
}
