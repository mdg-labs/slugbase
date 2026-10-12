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

/** The pino paths of every redacted field. */
export const REDACT_PATHS: readonly string[] = DEPTHS.flatMap((depth) =>
  REDACTED_FIELDS.map((field) => (depth === "" ? `["${field}"]` : `${depth.slice(0, -1)}["${field}"]`)),
);

/** Receives each finished JSON line, newline included. */
export interface LogDestination {
  write(line: string): void;
}

export interface LoggerOptions {
  /** `LOG_LEVEL`. */
  readonly level: string;
  /** Where lines go; stderr by default. */
  readonly destination?: LogDestination;
}

/** A `Logger` writing one JSON line per call, with `level` as its name and the message as `msg`. */
export function createLogger({ level, destination }: LoggerOptions): Logger {
  const root = pino(
    {
      level,
      base: null,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...REDACT_PATHS], censor: CENSOR },
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
