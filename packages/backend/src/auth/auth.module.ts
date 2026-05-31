import { Module } from "@nestjs/common";

import { CsrfModule } from "./csrf/csrf.module.js";

@Module({
  imports: [CsrfModule],
})
export class AuthModule {}
