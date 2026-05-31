import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { ImportService } from "./import.service.js";

@Controller("import")
@UseGuards(TenantGuard)
export class ImportController {
  constructor(@Inject(ImportService) private readonly importService: ImportService) {}

  @Post("json")
  @HttpCode(200)
  async importJson(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: unknown,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.importService.importJson(workspace, userId, body);
  }

  @Post("netscape-html")
  @HttpCode(200)
  async importNetscapeHtml(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: { html: string },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.importService.importNetscapeHtml(workspace, userId, body.html);
  }
}
