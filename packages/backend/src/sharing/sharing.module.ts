import { Global, Module } from "@nestjs/common";

import { AuthzService } from "../common/authz/authz.service.js";
import { DbModule } from "../db/db.module.js";
import { SharingService } from "./sharing.service.js";

@Global()
@Module({
  imports: [DbModule],
  providers: [AuthzService, SharingService],
  exports: [AuthzService, SharingService],
})
export class SharingModule {}
