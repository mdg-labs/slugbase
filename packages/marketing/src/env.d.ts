/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_FRONTEND_ORIGIN?: string;
  readonly PUBLIC_FORWARDING_DOMAIN?: string;
  readonly PUBLIC_API_BASE_URL?: string;
  readonly PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY?: string;
  readonly PUBLIC_PLAN_PRICE_PERSONAL_YEARLY?: string;
  readonly PUBLIC_PLAN_PRICE_TEAM_SEAT?: string;
  readonly PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY?: string;
  readonly PUBLIC_PLAN_PRICE_SUPPORTER?: string;
  readonly PUBLIC_SUPPORTER_PROMOTION_END?: string;
  readonly PUBLIC_TEAM_BASE_SEATS?: string;
  readonly PUBLIC_FREE_BOOKMARK_CAP?: string;
  readonly PUBLIC_CONTACT_ENDPOINT?: string;
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
