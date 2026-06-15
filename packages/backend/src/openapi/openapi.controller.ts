import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Res,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";

import { ConfigService } from "../config/config.service.js";
import { renderInteractiveDocsPage } from "./interactive-docs.page.js";
import { OpenapiService } from "./openapi.service.js";

@Controller()
@SkipThrottle({ ip: true, "user-hour": true })
export class OpenapiController {
  constructor(
    @Inject(OpenapiService) private readonly openapi: OpenapiService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Get("openapi.json")
  getOpenApiDocument() {
    return this.openapi.getDocument();
  }

  @Get("docs")
  getInteractiveDocs(@Res() res: Response): void {
    // SEC-018: interactive docs are never served in production
    if (
      this.config.get("isProduction") ||
      !this.config.get("OPENAPI_INTERACTIVE_DOCS")
    ) {
      throw new NotFoundException();
    }

    const specUrl = new URL("/openapi.json", this.config.get("APP_BASE_URL")).toString();
    res.type("html").send(renderInteractiveDocsPage(specUrl));
  }
}
