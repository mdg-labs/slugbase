/// <reference types="node" />
import { z } from "zod";

// Field builders. Every message names what is wrong and never the value: the
// loader prints them next to the key (doc 01 section 11, T7).

function parseUrl(value: string): URL | undefined {
  return URL.canParse(value) ? new URL(value) : undefined;
}

/** A non-negative integer written in decimal digits, within the bounds. */
export function envInteger(bounds: { min: number; max: number }) {
  return z
    .string()
    .refine((value) => /^\d{1,9}$/.test(value), { error: "must be a whole number written in digits" })
    .transform(Number)
    .refine((value) => value >= bounds.min && value <= bounds.max, {
      error: `must be between ${String(bounds.min)} and ${String(bounds.max)}`,
    });
}

/** An unset or empty key is "not configured". */
export function optional<T extends z.ZodType>(field: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), field.optional());
}

/** A PostgreSQL connection URL with a host. */
export function postgresUrl() {
  return z.string().refine(
    (value) => {
      const url = parseUrl(value);
      return url !== undefined && (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "";
    },
    { error: "must be a postgres:// or postgresql:// URL with a host" },
  );
}

/** The origin of a deployment: scheme, host and optional port, with no path, query or credentials. Yields the normalised origin. */
export function originUrl() {
  return z
    .string()
    .refine(
      (value) => {
        const url = parseUrl(value);
        return (
          url !== undefined &&
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === "" &&
          url.username === "" &&
          url.password === "" &&
          !/[?#]/.test(value)
        );
      },
      { error: "must be an http or https origin without a path, such as https://bookmarks.example.com" },
    )
    .transform((value) => new URL(value).origin);
}

/** An absolute http or https URL. A trailing slash is removed so links join it without doubling. */
export function baseUrl() {
  return z
    .string()
    .refine(
      (value) => {
        const url = parseUrl(value);
        return url !== undefined && (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
      },
      { error: "must be an absolute http or https URL" },
    )
    .transform((value) => value.replace(/\/+$/, ""));
}

/** Base64 or base64url text that decodes to exactly `bytes` bytes. */
export function base64Key(bytes: number) {
  return z.string().refine(
    (value) => {
      if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
        return false;
      }
      const decoded = Buffer.from(value, "base64");
      const canonical = (text: string): string => text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
      return decoded.length === bytes && canonical(decoded.toString("base64")) === canonical(value);
    },
    { error: `must be base64 text that decodes to exactly ${String(bytes)} bytes` },
  );
}
