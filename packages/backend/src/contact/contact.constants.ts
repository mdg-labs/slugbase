/** Rate limit: 5 submissions per hour per IP (defaults-and-constants.md §4). */
export const CONTACT_RATE_LIMIT_MAX = 5;
export const CONTACT_RATE_LIMIT_TTL_MS = 3_600_000;

export const CONTACT_TOPICS = [
  "general",
  "support",
  "business",
  "press",
  "selfhost",
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export const CONTACT_TOPIC_LABELS: Record<ContactTopic, string> = {
  general: "General",
  support: "Support",
  business: "Business",
  press: "Press",
  selfhost: "Self-hosting",
};

export const CONTACT_NAME_MAX_LENGTH = 200;
export const CONTACT_MESSAGE_MAX_LENGTH = 5000;
