/**
 * Stripe publishable key for Cloud mode billing.
 * Set via VITE_STRIPE_PUBLISHABLE_KEY at build time.
 */

const key = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '').toString().trim();
export const stripePublishableKey = key || null;
export const isStripeConfigured = !!key;
