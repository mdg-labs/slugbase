import { z } from "zod";

import {
  CONTACT_MESSAGE_MAX_LENGTH,
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_TOPICS,
} from "./contact.constants.js";

export const ContactSubmitBodySchema = z
  .object({
    name: z.string().trim().min(1).max(CONTACT_NAME_MAX_LENGTH),
    email: z.string().trim().email(),
    topic: z.enum(CONTACT_TOPICS),
    message: z.string().trim().min(1).max(CONTACT_MESSAGE_MAX_LENGTH),
    challengeToken: z.string().min(1),
  })
  .strict();

export type ContactSubmitBody = z.infer<typeof ContactSubmitBodySchema>;

export function sanitizeContactField(value: string): string {
  return value.replace(/<script>/gi, "").replace(/[<>]/g, "");
}

export function parseContactSubmitBody(body: unknown): ContactSubmitBody {
  const parsed = ContactSubmitBodySchema.safeParse(body);
  if (!parsed.success) {
    throw parsed.error;
  }

  return {
    ...parsed.data,
    name: sanitizeContactField(parsed.data.name),
    message: sanitizeContactField(parsed.data.message),
  };
}
