import { Injectable, type LogLevel, type LoggerService } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";

const PII_LOG_FIELD_NAMES = new Set([
  "password",
  "passwordHash",
  "sessionToken",
  "authorization",
  "cookie",
  "email",
  "userEmail",
  "invitedEmail",
]);

function scrubLogAttributes(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (PII_LOG_FIELD_NAMES.has(key)) {
      continue;
    }
    scrubbed[key] = value;
  }
  return scrubbed;
}

function formatLogPayload(
  message: unknown,
  optionalParams: unknown[],
): { text: string; attributes: Record<string, unknown> } {
  const text =
    typeof message === "string" ? message : JSON.stringify(message);
  const attributes: Record<string, unknown> = {};

  for (const param of optionalParams) {
    if (param === undefined || param === null) {
      continue;
    }
    if (typeof param === "string") {
      attributes.detail = param;
      continue;
    }
    if (typeof param === "object" && !Array.isArray(param)) {
      Object.assign(attributes, param as Record<string, unknown>);
    }
  }

  return { text, attributes: scrubLogAttributes(attributes) };
}

/**
 * Bridges NestJS structured logging to the Sentry Logs API when Sentry is initialized.
 * Always mirrors output to stdout/stderr for local operator visibility.
 */
@Injectable()
export class SentryLoggerService implements LoggerService {
  private enabledLevels = new Set<LogLevel>([
    "error",
    "warn",
    "log",
    "debug",
    "verbose",
    "fatal",
  ]);

  setLogLevels(levels: LogLevel[]): void {
    this.enabledLevels = new Set(levels);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.enabledLevels.has(level)) {
      return;
    }

    const { text, attributes } = formatLogPayload(message, optionalParams);
    const hasAttributes = Object.keys(attributes).length > 0;

    this.writeToConsole(level, text, optionalParams);

    if (!Sentry.isInitialized()) {
      return;
    }

    switch (level) {
      case "error":
      case "fatal":
        Sentry.logger.error(text, hasAttributes ? attributes : undefined);
        break;
      case "warn":
        Sentry.logger.warn(text, hasAttributes ? attributes : undefined);
        break;
      case "debug":
      case "verbose":
        Sentry.logger.debug(text, hasAttributes ? attributes : undefined);
        break;
      case "log":
      default:
        Sentry.logger.info(text, hasAttributes ? attributes : undefined);
        break;
    }
  }

  private writeToConsole(
    level: LogLevel,
    text: string,
    optionalParams: unknown[],
  ): void {
    const payload =
      optionalParams.length > 0 ? [text, ...optionalParams] : [text];

    switch (level) {
      case "error":
      case "fatal":
        process.stderr.write(`${payload.map(String).join(" ")}\n`);
        break;
      default:
        process.stdout.write(`${payload.map(String).join(" ")}\n`);
        break;
    }
  }
}
