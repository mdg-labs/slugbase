import pino from "pino";
import type { Logger } from "../create-server.ts";

// The server's structured logger (doc 01 section 12): JSON lines through pino.
// Which fields a line carries is decided where it is written; the redaction
// list below is the second guard of doc 10 T7, censoring the fields that must
// never reach a log whichever code logs them.

const CENSOR = "[Redacted]";

/** Field names that carry a credential, a secret, a second-factor code or a request body. */
export const REDACTED_FIELDS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "password",
  "newPassword",
  "currentPassword",
  "oldPassword",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "secret",
  "clientSecret",
  "sessionSecret",
  "encryptionKey",
  "privateKey",
  "credential",
  "mfaCode",
  "totp",
  "totpCode",
  "recoveryCode",
  "body",
] as const;

// A field is censored at the top of a line and up to three objects deep
// (`headers.cookie`, `req.headers.cookie`, `request.body.password`).
const DEPTHS = ["", "*.", "*.*.", "*.*.*."] as const;

function pathsOf(fields: readonly string[]): string[] {
  return DEPTHS.flatMap((depth) => fields.map((field) => (depth === "" ? `["${field}"]` : `${depth.slice(0, -1)}["${field}"]`)));
}

/** The pino paths of every built-in redacted field. */
export const REDACT_PATHS: readonly string[] = pathsOf(REDACTED_FIELDS);

// A name goes into a bracketed pino path, and some names are refused:
// - a quote or a bracket makes pino throw when it parses the path;
// - a name that is exactly `*` would censor `msg` and every field the line carries; only pino's own `level` and
//   `time` survive;
// - line feed, carriage return and the line and paragraph separators (U+2028, U+2029) are not matched by pino's
//   top-level path, so the name would go uncensored there;
// - a backslash, an asterisk within a name and the other control characters (C0, DEL, C1) are censored at every
//   depth; they are refused with the rest of the class because a log key has no use for one.
const UNUSABLE_FIELD_NAME = /["\\[\]*\p{Cc}\p{Zl}\p{Zp}]/u;

function additionalPaths(fields: readonly string[]): string[] {
  for (const field of fields) {
    if (field === "" || UNUSABLE_FIELD_NAME.test(field)) {
      throw new Error(`redactFields: ${JSON.stringify(field)} is not a field name the logger can censor`);
    }
  }
  return pathsOf(fields);
}

/** Receives each finished JSON line, newline included. */
export interface LogDestination {
  write(line: string): void;
}

export interface LoggerOptions {
  /** `LOG_LEVEL`. */
  readonly level: string;
  /** Where lines go; stderr by default. */
  readonly destination?: LogDestination;
  /**
   * Field names a composition adds to `REDACTED_FIELDS` (doc 10 T7), for the credentials its own modules hold.
   * They are censored at the same depths and never replace the built-in list.
   */
  readonly redactFields?: readonly string[];
}

/** A `Logger` writing one JSON line per call, with `level` as its name and the message as `msg`. */
export function createLogger({ level, destination, redactFields = [] }: LoggerOptions): Logger {
  const root = pino(
    {
      level,
      base: null,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...REDACT_PATHS, ...additionalPaths(redactFields)], censor: CENSOR },
    },
    destination ?? pino.destination({ fd: 2 }),
  );
  return {
    info: (message, fields) => {
      root.info(fields ?? {}, message);
    },
    warn: (message, fields) => {
      root.warn(fields ?? {}, message);
    },
    error: (message, fields) => {
      root.error(fields ?? {}, message);
    },
  };
}

/** A logger whose every line carries `bindings`. */
export function childLogger(logger: Logger, bindings: Readonly<Record<string, unknown>>): Logger {
  return {
    info: (message, fields) => {
      logger.info(message, { ...fields, ...bindings });
    },
    warn: (message, fields) => {
      logger.warn(message, { ...fields, ...bindings });
    },
    error: (message, fields) => {
      logger.error(message, { ...fields, ...bindings });
    },
  };
}
