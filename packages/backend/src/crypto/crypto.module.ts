import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { DbModule } from "../db/db.module.js";
import { AesGcmCryptoService } from "./aes-gcm-crypto.service.js";
import { CRYPTO } from "./crypto.tokens.js";
import { SampleEncryptedSettingService } from "./sample-encrypted-setting.service.js";

@Global()
@Module({
  imports: [ConfigModule, DbModule],
  providers: [
    AesGcmCryptoService,
    {
      provide: CRYPTO,
      useExisting: AesGcmCryptoService,
    },
    SampleEncryptedSettingService,
  ],
  exports: [CRYPTO, AesGcmCryptoService, SampleEncryptedSettingService],
})
export class CryptoModule {}
