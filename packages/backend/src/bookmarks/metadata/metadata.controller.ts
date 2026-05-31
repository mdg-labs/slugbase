import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { TenantGuard } from "../../workspaces/tenant.guard.js";
import type { FetchMetadataQuery } from "./metadata.types.js";
import { MetadataService } from "./metadata.service.js";

@Controller("bookmarks/metadata")
@UseGuards(TenantGuard)
export class MetadataController {
  constructor(@Inject(MetadataService) private readonly metadata: MetadataService) {}

  @Get()
  @HttpCode(200)
  fetchMetadata(@Query() query: FetchMetadataQuery) {
    return this.metadata.fetchMetadata(query.url);
  }
}

@Controller("bookmarks/favicon")
@UseGuards(TenantGuard)
export class FaviconController {
  constructor(@Inject(MetadataService) private readonly metadata: MetadataService) {}

  @Get()
  @HttpCode(200)
  async fetchFavicon(
    @Query() query: FetchMetadataQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const favicon = await this.metadata.fetchFavicon(query.url);
    res.setHeader("Content-Type", favicon.contentType);
    res.setHeader("Cache-Control", "public, max-age=604800");
    return Buffer.from(favicon.body);
  }
}
