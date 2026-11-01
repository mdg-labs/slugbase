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

/** The host name or IP address of a relay, with no scheme, port or path. */
export function relayHost() {
  const isName = (value: string): boolean => /^[A-Za-z0-9.-]{1,253}$/.test(value);
  const isIpv6 = (value: string): boolean => /^[0-9A-Fa-f:.]{2,45}$/.test(value) && value.split(":").length > 2;
  return z.string().refine((value) => isName(value) || isIpv6(value), {
    error: "must be a host name or IP address, with no scheme, port or path",
  });
}

const MAILBOX_ADDRESS = String.raw`[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+`;

/** One mailbox: an address, or a display name followed by an address in angle brackets. */
export function mailbox() {
  const plain = new RegExp(`^${MAILBOX_ADDRESS}$`);
  const named = new RegExp(`^[^\\r\\n<>"]+<${MAILBOX_ADDRESS}>$`);
  return z.string().refine((value) => plain.test(value) || named.test(value), {
    error: "must be an address such as slugbase@example.com, or a name and address such as SlugBase <slugbase@example.com>",
  });
}

/**
 * A Sentry-protocol DSN: an http or https URL with a public key before the host and a numeric project id as the
 * last path segment. The value is the operator's, so it is kept as it is.
 */
export function sentryDsn() {
  return z.string().refine(
    (value) => {
      const url = parseUrl(value);
      return (
        url !== undefined &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname !== "" &&
        url.username !== "" &&
        /^(?:\/[^/]+)*\/\d+$/.test(url.pathname) &&
        url.search === "" &&
        url.hash === ""
      );
    },
    { error: "must be a Sentry DSN such as https://<public key>@errors.example.com/1" },
  );
}

function isBase64Of(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  const canonical = (text: string): string => text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return decoded.length === bytes && canonical(decoded.toString("base64")) === canonical(value);
}

/** Base64 or base64url text that decodes to exactly `bytes` bytes. */
export function base64Key(bytes: number) {
  return z.string().refine((value) => isBase64Of(value, bytes), {
    error: `must be base64 text that decodes to exactly ${String(bytes)} bytes`,
  });
}

/** A key id: 1 to 64 letters, digits, dots, hyphens or underscores. */
export const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface PreviousKey {
  readonly keyId: string;
  /** Base64 or base64url text of the key. */
  readonly key: string;
}

/**
 * Comma-separated `id:key` pairs, each key base64 text of `bytes` bytes. Unset or empty is no previous
 * key. Yields the pairs in order.
 */
export function previousKeys(bytes: number) {
  const entry = (text: string): PreviousKey | undefined => {
    const separator = text.indexOf(":");
    const keyId = text.slice(0, separator);
    const key = text.slice(separator + 1);
    return separator > 0 && KEY_ID_PATTERN.test(keyId) && isBase64Of(key, bytes) ? { keyId, key } : undefined;
  };
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .refine((value) => value.split(",").every((text) => entry(text.trim()) !== undefined), {
        error: `must be comma-separated id:key pairs, each id 1 to 64 letters, digits, dots, hyphens or underscores and each key base64 text that decodes to exactly ${String(bytes)} bytes`,
      })
      .transform((value): readonly PreviousKey[] =>
        value.split(",").flatMap((text) => {
          const parsed = entry(text.trim());
          return parsed === undefined ? [] : [parsed];
        }),
      )
      .default([]),
  );
}

/**
 * The name an authenticator app lists an account under: 1 to 64 characters after trimming, with no
 * control character and no colon (the colon separates the issuer from the account in the otpauth label).
 */
export function totpIssuer() {
  return z
    .string()
    .trim()
    .refine((value) => /^[^\p{Cc}:]{1,64}$/u.test(value), {
      error: "must be 1 to 64 characters with no control character and no colon",
    });
}

/**
 * The base URL of an OpenAI-compatible endpoint: an absolute http or https URL with a host, no credentials, no query
 * and no fragment (the adapter appends its path, and a credential in the URL could not be sent). Trailing slashes are removed.
 */
export function aiBaseUrl() {
  return z
    .string()
    .refine(
      (value) => {
        const url = parseUrl(value);
        return (
          url !== undefined &&
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.hostname !== "" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "" &&
          !/[?#]/.test(value)
        );
      },
      { error: "must be an absolute http or https URL with a host and no credentials, query or fragment" },
    )
    .transform((value) => value.replace(/\/+$/, ""));
}

/** A credential or an identifier sent to the provider: visible ASCII with no space, so it is one header or JSON value as written. */
export function visibleToken(maxLength: number) {
  return z.string().refine((value) => value.length <= maxLength && /^[\x21-\x7e]+$/.test(value), {
    error: `must be 1 to ${String(maxLength)} visible ASCII characters with no space`,
  });
}

/** A name shown to members: 1 to 64 characters after trimming, with no control character. */
export function displayName() {
  return z
    .string()
    .trim()
    .refine((value) => /^[^\p{Cc}]{1,64}$/u.test(value), { error: "must be 1 to 64 characters with no control character" });
}

// Characters that make a value more than one bare host: whitespace, a scheme, port, userinfo, path, query, wildcard, list or range separator, a percent escape.
const NOT_IN_A_BARE_HOST = /[\s/\\?#@:*,%[\]<>"'|^`{}!$&();=+~]/u;

/**
 * One bare host: a DNS name or an IP literal (an IPv6 literal with or without brackets), with no scheme, port, path,
 * userinfo, wildcard, comma or network range. Yields the host as `URL` normalises it (lower case, IDNA, IPv4 notations
 * and IPv6 compressed to one form), so it compares with the host of a URL.
 */
export function bareHost() {
  return z
    .string()
    .transform((value) => {
      const bracketed = /^\[([0-9A-Fa-f:.]+)\]$/.exec(value)?.[1];
      const unbracketed = /^[0-9A-Fa-f:.]+$/.test(value) && value.split(":").length > 2 ? value : undefined;
      const literal = bracketed ?? unbracketed;
      if (literal === undefined && NOT_IN_A_BARE_HOST.test(value)) {
        return undefined;
      }
      const url = parseUrl(`http://${literal === undefined ? value : `[${literal}]`}`);
      return url !== undefined && url.hostname !== "" && url.host === url.hostname && url.pathname === "/" ? url.hostname : undefined;
    })
    .refine((host): host is string => host !== undefined, {
      error: "must be one bare host name or IP address, with no scheme, port, path, wildcard or range",
    });
}
