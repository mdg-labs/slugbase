import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { SESSION_USER_ID_KEY, SessionGuard } from "../sessions/session.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { BillingApplicationService } from "./billing-application.service.js";

interface CheckoutBody {
  plan: "personal" | "team";
  mode: "recurring" | "one_time";
  billingInterval?: "monthly" | "annual";
  seatQuantity?: number;
  successUrl: string;
  cancelUrl: string;
}

interface UpdateSeatsBody {
  totalSeats: number;
}

@Controller()
export class BillingController {
  constructor(
    @Inject(BillingApplicationService)
    private readonly billingApp: BillingApplicationService,
  ) {}

  @Post("workspaces/:workspaceId/billing/checkout")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async startCheckout(
    @Param("workspaceId") workspaceId: string,
    @Body() body: CheckoutBody,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    return this.billingApp.startCheckout({
      workspaceId,
      requesterId: userId,
      plan: body.plan,
      mode: body.mode,
      billingInterval: body.billingInterval,
      seatQuantity: body.seatQuantity,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
    });
  }

  @Patch("workspaces/:workspaceId/billing/seats")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async updateSeats(
    @Param("workspaceId") workspaceId: string,
    @Body() body: UpdateSeatsBody,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<WorkspaceRecord> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    return this.billingApp.updateSeats({
      workspaceId,
      requesterId: userId,
      totalSeats: body.totalSeats,
    });
  }

  @Get("workspaces/:workspaceId/billing/invoices")
  @UseGuards(SessionGuard)
  async listInvoices(
    @Param("workspaceId") workspaceId: string,
    @Query("page") page: string | undefined,
    @Query("pageSize") pageSize: string | undefined,
    @Req() req: Request & Record<string, unknown>,
  ) {
    const userId = req[SESSION_USER_ID_KEY] as string;
    const parsedPage = page !== undefined ? Number.parseInt(page, 10) : undefined;
    const parsedPageSize = pageSize !== undefined ? Number.parseInt(pageSize, 10) : undefined;
    return this.billingApp.listInvoices({
      workspaceId,
      requesterId: userId,
      page:
        parsedPage !== undefined && Number.isFinite(parsedPage) && parsedPage > 0
          ? parsedPage
          : undefined,
      pageSize:
        parsedPageSize !== undefined &&
        Number.isFinite(parsedPageSize) &&
        parsedPageSize > 0
          ? parsedPageSize
          : undefined,
    });
  }
}
