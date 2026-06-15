import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { ConfigService } from "../../config/config.service.js";

const HMAC_ALGORITHM = "sha256";
const TOKEN_SEPARATOR = ".";

@Injectable()
export class CsrfService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private get secret(): string {
    return this.config.get("SESSION_SECRET");
  }

  /** Generates a signed CSRF token: `<random>.<HMAC(random, SECRET)>`. */
  generateToken(): string {
    const value = randomBytes(24).toString("base64url");
    const mac = createHmac(HMAC_ALGORITHM, this.secret)
      .update(value)
      .digest("base64url");
    return `${value}${TOKEN_SEPARATOR}${mac}`;
  }

  /** Verifies that a token was signed with our secret. */
  verifyToken(token: string): boolean {
    const idx = token.lastIndexOf(TOKEN_SEPARATOR);
    if (idx === -1) return false;

    const value = token.slice(0, idx);
    const mac = token.slice(idx + 1);

    const expected = createHmac(HMAC_ALGORITHM, this.secret)
      .update(value)
      .digest();
    const macBuf = Buffer.from(mac, "base64url");

    if (macBuf.length !== expected.length) return false;
    return timingSafeEqual(macBuf, expected);
  }
}
