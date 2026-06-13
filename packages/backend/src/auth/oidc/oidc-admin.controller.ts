import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import type { OidcProvider } from "@slugbase/shared-types";

import { ActiveWorkspace } from "../../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../../workspaces/workspace.types.js";
import { WorkspacesService } from "../../workspaces/workspaces.service.js";
import { OidcService } from "./oidc.service.js";
import type { OidcProviderRecord } from "./oidc.types.js";
import type { CreateOidcProviderBody, UpdateOidcProviderBody } from "@slugbase/shared-types";

function toPublicProvider(record: OidcProviderRecord): OidcProvider {
  return {
    id: record.id,
    name: record.name,
    issuerUrl: record.issuerUrl,
    clientId: record.clientId,
    hasClientSecret: record.clientSecretEncrypted.length > 0,
    scopes: record.scopes,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Exposes CRUD for OIDC providers under /workspace/settings/oidc/providers.
 *
 * All endpoints require an active workspace session and ADMIN role (spec §5.6).
 * Client secrets are encrypted at rest (spec §11.11).
 * CSRF is enforced globally on mutations - no explicit decorator needed.
 */
@Controller("workspace/settings/oidc/providers")
@UseGuards(TenantGuard)
export class OidcAdminController {
  constructor(
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  @HttpCode(200)
  async listProviders(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<OidcProvider[]> {
    await this.requireAdmin(workspace.id, req);
    const providers = await this.oidc.listProviders();
    return providers.map(toPublicProvider);
  }

  @Post()
  @HttpCode(201)
  async createProvider(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: CreateOidcProviderBody,
  ): Promise<OidcProvider> {
    await this.requireAdmin(workspace.id, req);
    const provider = await this.oidc.createProvider({
      name: body.name,
      issuerUrl: body.issuerUrl,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      scopes: body.scopes,
      enabled: body.enabled,
    });
    return toPublicProvider(provider);
  }

  @Patch(":providerId")
  @HttpCode(200)
  async updateProvider(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("providerId") providerId: string,
    @Body() body: UpdateOidcProviderBody,
  ): Promise<OidcProvider> {
    await this.requireAdmin(workspace.id, req);
    const provider = await this.oidc.updateProvider(providerId, {
      name: body.name,
      issuerUrl: body.issuerUrl,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      scopes: body.scopes,
      enabled: body.enabled,
    });
    return toPublicProvider(provider);
  }

  @Delete(":providerId")
  @HttpCode(204)
  async deleteProvider(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("providerId") providerId: string,
  ): Promise<void> {
    await this.requireAdmin(workspace.id, req);
    await this.oidc.deleteProvider(providerId);
  }

  private async requireAdmin(workspaceId: string, req: Request & Record<string, unknown>): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, "ADMIN");
  }
}
