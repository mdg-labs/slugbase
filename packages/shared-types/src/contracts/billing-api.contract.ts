import { initContract } from "@ts-rest/core";
import { z } from "zod";

import { WorkspaceSchema } from "./workspace.contract.js";

const c = initContract();

export const BillingCheckoutPlanSchema = z.enum(["personal", "team"]);
export const BillingCheckoutModeSchema = z.enum(["recurring", "one_time"]);

export const BillingIntervalSchema = z.enum(["monthly", "annual"]);

export const BillingCheckoutBodySchema = z
  .object({
    plan: BillingCheckoutPlanSchema,
    mode: BillingCheckoutModeSchema,
    billingInterval: BillingIntervalSchema.default("monthly"),
    /** Seat quantity for Team recurring checkout (minimum 2). Ignored for Personal and one-time. */
    seatQuantity: z.number().int().positive().optional(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  })
  .strict();

export const BillingCheckoutSessionSchema = z
  .object({
    checkoutUrl: z.string().url(),
    sessionId: z.string(),
  })
  .strict();

export const BillingPortalBodySchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict();

export const BillingPortalSessionSchema = z
  .object({
    portalUrl: z.string().url(),
  })
  .strict();

export const BillingUpdateSeatsBodySchema = z
  .object({
    totalSeats: z.number().int().positive(),
  })
  .strict();

export const billingContract = c.router({
  startCheckout: {
    method: "POST",
    path: "/workspaces/:workspaceId/billing/checkout",
    pathParams: z.object({ workspaceId: z.string() }),
    body: BillingCheckoutBodySchema,
    responses: {
      200: BillingCheckoutSessionSchema,
      400: z.object({ message: z.string() }).strict(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Start a Stripe checkout session for a plan purchase or change",
  },
  openPortal: {
    method: "POST",
    path: "/workspaces/:workspaceId/billing/portal",
    pathParams: z.object({ workspaceId: z.string() }),
    body: BillingPortalBodySchema,
    responses: {
      200: BillingPortalSessionSchema,
      400: z.object({ message: z.string() }).strict(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Open the Stripe self-service billing portal",
  },
  updateSeats: {
    method: "PATCH",
    path: "/workspaces/:workspaceId/billing/seats",
    pathParams: z.object({ workspaceId: z.string() }),
    body: BillingUpdateSeatsBodySchema,
    responses: {
      200: WorkspaceSchema,
      400: z.object({ message: z.string() }).strict(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Adjust Team seat quantity (not below current member count)",
  },
  stripeWebhook: {
    method: "POST",
    path: "/billing/webhooks/stripe",
    body: c.type<{ raw: unknown }>(),
    responses: {
      200: z.object({ received: z.literal(true) }).strict(),
      400: z.object({ message: z.string() }).strict(),
    },
    summary: "Stripe billing webhook receiver (hosted only)",
  },
});

export type BillingCheckoutBody = z.infer<typeof BillingCheckoutBodySchema>;
export type BillingPortalBody = z.infer<typeof BillingPortalBodySchema>;
export type BillingUpdateSeatsBody = z.infer<typeof BillingUpdateSeatsBodySchema>;
