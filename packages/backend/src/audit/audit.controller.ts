import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { AuditService } from "./audit.service.js";
import type { ListAuditEventsQuery } from "./audit.types.js";

@Controller("audit")
@UseGuards(TenantGuard)
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get("events")
  @HttpCode(200)
  async listEvents(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Query() query: ListAuditEventsQuery,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.audit.listEvents(workspace, userId, query);
  }
}
