import { Controller, Get, HttpCode, Inject, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { ExportService } from "./export.service.js";

@Controller("export")
@UseGuards(TenantGuard)
export class ExportController {
  constructor(@Inject(ExportService) private readonly exportService: ExportService) {}

  @Get("json")
  @HttpCode(200)
  async exportJson(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.exportService.exportJson(workspace, userId);
  }
}
