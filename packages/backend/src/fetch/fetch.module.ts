import { Global, Module } from "@nestjs/common";

import { FetchService } from "./fetch.service.js";
import { FETCH } from "./fetch.tokens.js";

@Global()
@Module({
  providers: [
    FetchService,
    {
      provide: FETCH,
      useExisting: FetchService,
    },
  ],
  exports: [FetchService, FETCH],
})
export class FetchModule {}
