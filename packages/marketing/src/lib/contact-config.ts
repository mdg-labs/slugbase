/** Marketing contact form - public env (spec §2.3, §11.8). */

const CONTACT_NAME_MAX_LENGTH = 200;
const CONTACT_MESSAGE_MAX_LENGTH = 5000;

export type ContactTopic = "general" | "support" | "business" | "press" | "selfhost";

export const CONTACT_TOPICS: readonly ContactTopic[] = [
  "general",
  "support",
  "business",
  "press",
  "selfhost",
] as const;

export interface MarketingContactConfig {
  contactEndpoint: string;
  turnstileSiteKey: string;
  nameMaxLength: number;
  messageMaxLength: number;
}

function readEnv(key: string): string {
  if (!(key in import.meta.env)) {
    const nodeValue = process.env[key];
    return typeof nodeValue === "string" ? nodeValue.trim() : "";
  }
  const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
  if (typeof value === "string" && value.length > 0) {
    return value.trim();
  }
  const nodeValue = process.env[key];
  return typeof nodeValue === "string" ? nodeValue.trim() : "";
}

export function loadMarketingContactConfig(): MarketingContactConfig {
  return {
    contactEndpoint: readEnv("PUBLIC_CONTACT_ENDPOINT"),
    turnstileSiteKey: readEnv("PUBLIC_TURNSTILE_SITE_KEY"),
    nameMaxLength: CONTACT_NAME_MAX_LENGTH,
    messageMaxLength: CONTACT_MESSAGE_MAX_LENGTH,
  };
}

export function isContactFormConfigured(config: MarketingContactConfig): boolean {
  return config.contactEndpoint.length > 0;
}
