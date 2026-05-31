import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { SearchService } from "./search.service.js";
import type { GlobalSearchQuery } from "./search.types.js";

@Controller("search")
@UseGuards(TenantGuard)
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get()
  @HttpCode(200)
  async globalSearch(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Query() query: GlobalSearchQuery,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.search.search(workspace, userId, query);
  }
}
