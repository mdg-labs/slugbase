import { postJson, type Attempt, type AuthWorld } from "./support.ts";

// The requests of the credential flows the enumeration, rate-limit and token-lifetime suites send: the four that
// ask for an emailed link (register, resend, forgot, change email) and the four that redeem one (verify, reset,
// confirm, cancel), each one call with the client address it comes from.

export const REGISTER = "/api/v1/auth/register";
export const RESEND = "/api/v1/auth/verify-email/resend";
export const FORGOT = "/api/v1/auth/password/forgot";
export const CHANGE_EMAIL = "/api/v1/me/email";
export const VERIFY = "/api/v1/auth/verify-email";
export const RESET = "/api/v1/auth/password/reset";
export const CONFIRM = "/api/v1/me/email/confirm";
export const CANCEL = "/api/v1/me/email/cancel";

/** A password the registration and verification steps accept. */
export const STRONG_PASSWORD = "a long enough password for this account";

export type From = Pick<Attempt, "forwardedFor">;

/** A configuration for a server that accepts registrations and mails a verification link, which is what these suites need of it. */
export const CREDENTIAL_ENV = { PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "true" } as const;

export interface RequestFlow {
  readonly name: string;
  readonly path: string;
  /** Asks for the link for `email`; `cookie` is the session of the account that asks, for the flow that needs one. */
  readonly call: (world: AuthWorld, email: string, from: From, cookie?: string) => Promise<Response>;
  /** The bucket the flow counts in. */
  readonly bucket: "register" | "reset";
  /** Whether the flow needs a signed-in, re-authenticated session. */
  readonly authenticated: boolean;
}

export const requestFlows: readonly RequestFlow[] = [
  {
    name: "POST /auth/register",
    path: REGISTER,
    bucket: "register",
    authenticated: false,
    call: (world, email, from) => world.server.fetch(postJson(world.origin, REGISTER, { displayName: "Ada Lovelace", email, password: STRONG_PASSWORD }, from)),
  },
  {
    name: "POST /auth/verify-email/resend",
    path: RESEND,
    bucket: "reset",
    authenticated: false,
    call: (world, email, from) => world.server.fetch(postJson(world.origin, RESEND, { email }, from)),
  },
  {
    name: "POST /auth/password/forgot",
    path: FORGOT,
    bucket: "reset",
    authenticated: false,
    call: (world, email, from) => world.server.fetch(postJson(world.origin, FORGOT, { email }, from)),
  },
  {
    name: "POST /me/email",
    path: CHANGE_EMAIL,
    bucket: "reset",
    authenticated: true,
    call: (world, email, from, cookie) => world.server.fetch(postJson(world.origin, CHANGE_EMAIL, { email }, { ...from, ...(cookie === undefined ? {} : { cookie }) })),
  },
];

export interface RedeemFlow {
  readonly name: string;
  readonly path: string;
  /** The status of a redemption that works. */
  readonly success: number;
  readonly call: (world: AuthWorld, token: string, from?: From) => Promise<Response>;
}

export const redeemFlows: readonly RedeemFlow[] = [
  {
    name: "POST /auth/verify-email",
    path: VERIFY,
    success: 200,
    call: (world, token, from) => world.server.fetch(postJson(world.origin, VERIFY, { token, password: "the password chosen when verifying" }, from)),
  },
  {
    name: "POST /auth/password/reset",
    path: RESET,
    success: 200,
    call: (world, token, from) => world.server.fetch(postJson(world.origin, RESET, { token, newPassword: "the password chosen on the reset page" }, from)),
  },
  {
    name: "POST /me/email/confirm",
    path: CONFIRM,
    success: 204,
    call: (world, token, from) => world.server.fetch(postJson(world.origin, CONFIRM, { token }, from)),
  },
  {
    name: "POST /me/email/cancel",
    path: CANCEL,
    success: 204,
    call: (world, token, from) => world.server.fetch(postJson(world.origin, CANCEL, { token }, from)),
  },
];
