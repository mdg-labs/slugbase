import { Module } from "@nestjs/common";

import { AccountsService } from "./accounts.service.js";
import { PasswordService } from "./password.service.js";

@Module({
  providers: [AccountsService, PasswordService],
  exports: [AccountsService, PasswordService],
})
export class AccountsModule {}
