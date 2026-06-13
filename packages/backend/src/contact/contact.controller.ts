import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import type { Request } from "express";

import { SkipCsrf } from "../auth/csrf/skip-csrf.decorator.js";
import { IpThrottlerGuard } from "../auth/rate-limit/ip-throttler.guard.js";
import {
  CONTACT_RATE_LIMIT_MAX,
  CONTACT_RATE_LIMIT_TTL_MS,
} from "./contact.constants.js";
import { ContactService } from "./contact.service.js";

@Controller("contact")
@SkipCsrf()
export class ContactController {
  constructor(@Inject(ContactService) private readonly contactService: ContactService) {}

  @Post()
  @HttpCode(204)
  @UseGuards(IpThrottlerGuard)
  @SkipThrottle({ "user-hour": true })
  @Throttle({
    ip: { limit: CONTACT_RATE_LIMIT_MAX, ttl: CONTACT_RATE_LIMIT_TTL_MS },
  })
  async submit(@Req() req: Request): Promise<void> {
    const remoteIp = req.ips.length > 0 ? req.ips[0] : req.ip;
    await this.contactService.submit(req.body, remoteIp);
  }
}
