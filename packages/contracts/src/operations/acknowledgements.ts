import { z } from "zod";

// What the person creating an account acknowledged first (doc 01 section 13.5, doc 04 section 10.2): a short list of
// document or statement identifiers with the version label the person saw. The bounds hold identifiers and labels
// only, so the list may travel in the registration policy's input and in the `account.created` payload (doc 10 T7).

/** The most acknowledgements one request carries. */
export const REGISTRATION_ACKNOWLEDGEMENTS_MAX = 8;

/** The grammar of an acknowledgement's identifier. */
export const REGISTRATION_ACKNOWLEDGEMENT_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** The longest version label of an acknowledgement. */
export const REGISTRATION_ACKNOWLEDGEMENT_VERSION_MAX_LENGTH = 32;

const CONTROL_CHARACTER = /\p{Cc}/u;

export const RegistrationAcknowledgementSchema = z
  .strictObject({
    id: z.string().regex(REGISTRATION_ACKNOWLEDGEMENT_ID_PATTERN).describe("The acknowledged document or statement: 1 to 32 characters of a-z, 0-9, underscore and hyphen"),
    version: z
      .string()
      .min(1)
      .max(REGISTRATION_ACKNOWLEDGEMENT_VERSION_MAX_LENGTH)
      .refine((value) => !CONTROL_CHARACTER.test(value), { message: "must not contain a control character" })
      .describe("The version label the person acknowledged: 1 to 32 characters, no control character"),
  })
  .meta({ id: "RegistrationAcknowledgement" });

export const RegistrationAcknowledgementsSchema = z
  .array(RegistrationAcknowledgementSchema)
  .max(REGISTRATION_ACKNOWLEDGEMENTS_MAX)
  .superRefine((list, context) => {
    const seen = new Set<string>();
    list.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        context.addIssue({ code: "custom", message: "an acknowledgement is named once", path: [index, "id"] });
      }
      seen.add(entry.id);
    });
  })
  .meta({ id: "RegistrationAcknowledgements" });
