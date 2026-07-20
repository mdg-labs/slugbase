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

export const BillingUpdateSeatsBodySchema = z
  .object({
    totalSeats: z.number().int().positive(),
  })
  .strict();

export const BillingCancelBodySchema = z.object({}).strict();

export const BillingReactivateBodySchema = z
  .object({
    plan: BillingCheckoutPlanSchema,
    billingInterval: BillingIntervalSchema.default("monthly"),
    seatQuantity: z.number().int().positive().optional(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  })
  .strict();

export const BillingChangePlanBodySchema = z
  .object({
    targetPlan: BillingCheckoutPlanSchema,
    billingInterval: BillingIntervalSchema.default("monthly"),
    seatQuantity: z.number().int().positive().optional(),
  })
  .strict();

export const BillingPaymentMethodBodySchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict();

export const BillingInvoiceStatusSchema = z.enum([
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
]);

export const BillingInvoiceSchema = z
  .object({
    id: z.string(),
    createdAt: z.string().datetime(),
    description: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    status: BillingInvoiceStatusSchema,
    invoicePdfUrl: z.string().url().nullable(),
  })
  .strict();

export const BillingInvoiceListSchema = z
  .object({
    items: z.array(BillingInvoiceSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    hasMore: z.boolean(),
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
    summary: "Start a Mollie checkout session for a plan purchase or change",
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
  cancelSubscription: {
    method: "POST",
    path: "/workspaces/:workspaceId/billing/cancel",
    pathParams: z.object({ workspaceId: z.string() }),
    body: BillingCancelBodySchema,
    responses: {
      200: WorkspaceSchema,
      400: z.object({ message: z.string() }).strict(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Cancel subscription at period end",
  },
  reactivateSubscription: {
    method: "POST",
    path: "/workspaces/:workspaceId/billing/reactivate",
    pathParams: z.object({ workspaceId: z.string() }),
    body: BillingReactivateBodySchema,
    responses: {
      200: z.union([WorkspaceSchema, BillingCheckoutSessionSchema]),
      400: z.object({ message: z.string() }).strict(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Reactivate a cancelled subscription or start a new checkout",
  },
  changePlan: {
    method: "POST",
    path: "/workspaces/:workspaceId/billing/change-plan",
    pathParams: z.object({ workspaceId: z.string() }),
    body: BillingChangePlanBodySchema,
    responses: {
      200: WorkspaceSchema,
      400: z.object({ message: z.string() }).strict(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Change subscription plan tier",
  },
  updatePaymentMethod: {
    method: "POST",
    path: "/workspaces/:workspaceId/billing/payment-method",
    pathParams: z.object({ workspaceId: z.string() }),
    body: BillingPaymentMethodBodySchema,
    responses: {
      200: BillingCheckoutSessionSchema,
      400: z.object({ message: z.string() }).strict(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Start a hosted payment-method update session",
  },
  listInvoices: {
    method: "GET",
    path: "/workspaces/:workspaceId/billing/invoices",
    pathParams: z.object({ workspaceId: z.string() }),
    query: z.object({
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(100).optional(),
    }),
    responses: {
      200: BillingInvoiceListSchema,
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "List invoices for the workspace billing customer",
  },
  mollieWebhook: {
    method: "POST",
    path: "/billing/webhooks/mollie",
    body: c.type<{ raw: unknown }>(),
    responses: {
      200: z.object({ received: z.literal(true) }).strict(),
      400: z.object({ message: z.string() }).strict(),
    },
    summary: "Mollie billing webhook receiver (hosted only)",
  },
});

export type BillingCheckoutBody = z.infer<typeof BillingCheckoutBodySchema>;
export type BillingUpdateSeatsBody = z.infer<typeof BillingUpdateSeatsBodySchema>;
export type BillingReactivateBody = z.infer<typeof BillingReactivateBodySchema>;
export type BillingChangePlanBody = z.infer<typeof BillingChangePlanBodySchema>;
export type BillingPaymentMethodBody = z.infer<typeof BillingPaymentMethodBodySchema>;
