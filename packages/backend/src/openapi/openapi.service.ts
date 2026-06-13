import { Inject, Injectable } from "@nestjs/common";
import { buildOpenApiDocument } from "@slugbase/shared-types";

import { ConfigService } from "../config/config.service.js";

@Injectable()
export class OpenapiService {
  private cachedDocument: ReturnType<typeof buildOpenApiDocument> | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  getDocument(): ReturnType<typeof buildOpenApiDocument> {
    if (!this.cachedDocument) {
      const document = buildOpenApiDocument();
      document.servers = [{ url: this.config.get("APP_BASE_URL") }];
      this.cachedDocument = document;
    }

    return this.cachedDocument;
  }
}
