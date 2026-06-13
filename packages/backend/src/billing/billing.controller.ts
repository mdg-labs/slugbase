import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";

import { SkipCsrf } from "../auth/csrf/skip-csrf.decorator.js";
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

interface PortalBody {
  returnUrl: string;
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

  @Post("workspaces/:workspaceId/billing/portal")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async openPortal(
    @Param("workspaceId") workspaceId: string,
    @Body() body: PortalBody,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<{ portalUrl: string }> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    return this.billingApp.openPortal({
      workspaceId,
      requesterId: userId,
      returnUrl: body.returnUrl,
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

  @Post("billing/webhooks/stripe")
  @HttpCode(200)
  @SkipCsrf()
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!signature) {
      throw new BadRequestException("Missing stripe-signature header");
    }
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException("Missing raw request body for webhook verification");
    }
    return this.billingApp.processWebhookEvent(rawBody, signature);
  }
}
