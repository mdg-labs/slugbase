// Removes personal data from an error event before it leaves the process
// (doc 01 section 6, doc 10 T7). The scrubber is the last step before the
// transport: an event it cannot scrub is dropped, never sent as it is.

const FILTERED = "[Filtered]";

// Keys whose value is never sent, whatever it holds.
const REDACTED_KEY = /pass(?:word|wd|phrase)|token|secret|code|key|authorization|cookie|credential/i;

const MAX_STRING_LENGTH = 4096;
const MAX_DEPTH = 12;

// The characters that open a quoted value: JSON uses `"`, Python and `util.inspect` use `'`, and `util.inspect`
// uses a backtick for a string that holds both of the others. Every place that decides what opens a quoted
// value reads this one set.
const QUOTES = "\"'`";
const QUOTE_CLASS = `[${QUOTES}]`;
const TRAILING_QUOTE = new RegExp(`${QUOTE_CLASS}$`);
function isQuote(char: string | undefined): char is string {
  return char !== undefined && QUOTES.includes(char);
}

// Header-style lines run to the end of the line: `Authorization: Basic <credentials>`.
const HEADER_LINE = new RegExp(`\\b(authorization|set-cookie|cookie)\\b(\\\\{0,8}${QUOTE_CLASS}?\\s*[=:]\\s*)[^\\r\\n]*`, "gi");
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const URL_QUERY = /(\/[^\s?#"'<>]*)[?#][^\s"'<>]*/g;
// `name=value`, `name: value` and `"name":"value"`, also as JSON embedded in a string, where the quotes carry
// escaping backslashes (`\"name\":\"value\"`, escaped once or several times). Only the name and the separator
// are matched here, with fixed maxima so that a hostile string costs a limited amount of work per position; the
// name is tested against the key list, and the value is then measured by `filteredValue` below.
const PAIR_PREFIX = new RegExp(`([\\w-]{1,64})(\\\\{0,8}${QUOTE_CLASS}?)(\\s*[=:]\\s*)`, "g");
const UNQUOTED_VALUE = /[^\s&,;"'}\])]+/y;
const AUTH_SCHEME = /^(?:Bearer|Basic)$/i;
const SCHEME_CREDENTIAL = /\s+[^\s&,;"'}\])]+/y;

// A quote closes a value when the run of backslashes in front of it is the opening's own run (`opening`, the
// backslashes that escape a quote at this nesting depth) plus a whole, even number of escaped backslashes (each
// `opening + 1` long). A longer odd run is a quote inside the value, and any other run is no closer at all.
function closes(run: number, opening: number): boolean {
  const extra = run - opening;
  return extra >= 0 && extra % (opening + 1) === 0 && (extra / (opening + 1)) % 2 === 0;
}

/**
 * Where the array or object that opens at `start` ends: one past its matching close bracket, or the end of the
 * text when there is none. Brackets inside quoted strings do not count; a string opened by one kind of quote
 * (see `QUOTES`) closes only on that kind, by the same backslash-run rule as `closes`, with `opening` the
 * backslashes that escape a quote at this nesting depth.
 */
function bracketedEnd(text: string, start: number, opening: number): number {
  let depth = 0;
  let quote: string | undefined;
  let run = 0;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      run += 1;
      continue;
    }
    if (isQuote(char) && closes(run, opening)) {
      if (quote === undefined) {
        quote = char;
      } else if (quote === char) {
        quote = undefined;
      }
    } else if (quote === undefined && (char === "[" || char === "{")) {
      depth += 1;
    } else if (quote === undefined && (char === "]" || char === "}")) {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
    run = 0;
  }
  return text.length;
}

/**
 * What replaces the value that starts at `start`, and where that value ends. A quoted value ends at its closing
 * quote and an array or object at its matching close bracket; when none is found it runs to the end of the text,
 * so nothing of it is left in the clear. An unquoted value ends at the first delimiter. The scan is linear in
 * the text. `keyOpening` is the number of backslashes that escape a quote at the depth of the key.
 */
function filteredValue(
  text: string,
  start: number,
  keyOpening: number,
): { replacement: string; end: number } | undefined {
  if (text.startsWith(FILTERED, start)) {
    return { replacement: FILTERED, end: start + FILTERED.length };
  }
  if (text[start] === "[" || text[start] === "{") {
    return { replacement: FILTERED, end: bracketedEnd(text, start, keyOpening) };
  }
  let quoteAt = start;
  while (text[quoteAt] === "\\") {
    quoteAt += 1;
  }
  const quote = text[quoteAt];
  if (isQuote(quote)) {
    const opening = quoteAt - start;
    const open = opening === 0 ? '"' : `${text.slice(start, quoteAt)}${quote}`;
    let run = 0;
    for (let at = quoteAt + 1; at < text.length; at += 1) {
      const char = text[at];
      if (char === "\\") {
        run += 1;
        continue;
      }
      if (char === quote && closes(run, opening)) {
        return { replacement: `${open}${FILTERED}${open}`, end: at + 1 };
      }
      run = 0;
    }
    return { replacement: `${open}${FILTERED}`, end: text.length };
  }
  UNQUOTED_VALUE.lastIndex = start;
  const unquoted = UNQUOTED_VALUE.exec(text);
  if (unquoted === null) {
    return undefined;
  }
  let end = start + unquoted[0].length;
  // `Bearer <credential>` is one value: the scheme word alone would leave the credential behind.
  if (AUTH_SCHEME.test(unquoted[0])) {
    SCHEME_CREDENTIAL.lastIndex = end;
    const credential = SCHEME_CREDENTIAL.exec(text);
    if (credential !== null) {
      end += credential[0].length;
    }
  }
  return { replacement: FILTERED, end };
}

function redactPairs(text: string): string {
  const prefix = new RegExp(PAIR_PREFIX);
  let redacted = "";
  let copied = 0;
  for (let found = prefix.exec(text); found !== null; found = prefix.exec(text)) {
    const name = found[1] ?? "";
    const valueStart = found.index + found[0].length;
    const keyOpening = (found[2] ?? "").replace(TRAILING_QUOTE, "").length;
    const value = REDACTED_KEY.test(name) ? filteredValue(text, valueStart, keyOpening) : undefined;
    if (value !== undefined) {
      redacted += text.slice(copied, valueStart) + value.replacement;
      copied = value.end;
      prefix.lastIndex = value.end;
    }
  }
  return redacted + text.slice(copied);
}
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_FULL = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi;
const IPV6_COMPRESSED =
  /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi;

/** Replaces the personal data a piece of text can carry: credentials, query strings, emails and IP addresses. */
export function scrubText(text: string): string {
  const bounded = text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}...` : text;
  // Pairs go first: the steps after this one delete characters, which would cut a secret short and leave its tail.
  const withoutCredentials = redactPairs(bounded)
    .replace(HEADER_LINE, `$1$2${FILTERED}`)
    .replace(BEARER, `$1 ${FILTERED}`)
    .replace(JWT, FILTERED)
    .replace(URL_CREDENTIALS, `$1${FILTERED}@`)
    .replace(URL_QUERY, "$1");
  return withoutCredentials
    .replace(EMAIL, "[email]")
    .replace(IPV4, "[ip]")
    .replace(IPV6_FULL, "[ip]")
    .replace(IPV6_COMPRESSED, (match) => (match === "::" ? match : "[ip]"));
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return FILTERED;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => scrubValue(item, depth + 1));
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    scrubbed[key] = REDACTED_KEY.test(key) ? FILTERED : scrubValue(item, depth + 1);
  }
  return scrubbed;
}

// A concrete segment (an identifier, a slug-like token, a number) never names a route.
const TEMPLATE_PARAMETER = /^(?:\{[A-Za-z_]\w*\}|:[A-Za-z_]\w*)$/;
const JOB_NAME = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
const PLAIN_WORD = /^[a-z][a-z-]{0,31}$/;

/**
 * The route template a transaction name stands for: the method and the path
 * without origin, query or fragment, where every segment that is neither a
 * template parameter nor a plain lower-case word becomes `{param}`.
 */
export function routeTemplate(name: string): string {
  // A name with no path in it, such as the name of a job, stands for itself.
  if (!name.includes("/")) {
    return JOB_NAME.test(name) ? name : "{param}";
  }
  const method = /^([A-Z]{3,7}) /.exec(name)?.[1];
  let path = method === undefined ? name : name.slice(method.length + 1);
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/[?#].*$/s, "");
  const segments = path.split("/").map((segment) => {
    if (segment === "" || TEMPLATE_PARAMETER.test(segment) || PLAIN_WORD.test(segment) || /^v\d+$/.test(segment)) {
      return segment;
    }
    return "{param}";
  });
  const template = segments.join("/");
  return method === undefined ? template : `${method} ${template}`;
}

// What an event may keep of the request it was raised in; everything else, the body, the query string,
// cookies and headers included, is dropped with it.
function requestOf(request: unknown): { method: string } | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const method = (request as { method?: unknown }).method;
  return typeof method === "string" && /^[A-Za-z]{3,7}$/.test(method) ? { method: method.toUpperCase() } : undefined;
}

// Fields an event never keeps as they are: the user (and with it the client IP), the host name and the
// breadcrumbs go; the request and the transaction name are rebuilt below.
const DROPPED_FIELDS: readonly string[] = ["request", "user", "server_name", "breadcrumbs", "transaction"];

/** A copy of a Sentry event with no personal data; it throws on a value it cannot walk, and the caller then sends nothing. */
export function scrubEvent<Event extends object>(event: Event): Event {
  const source = event as Record<string, unknown>;
  const kept = Object.fromEntries(Object.entries(source).filter(([key]) => !DROPPED_FIELDS.includes(key)));
  const scrubbed = scrubValue(kept, 0) as Record<string, unknown>;
  const request = requestOf(source["request"]);
  if (request !== undefined) {
    scrubbed["request"] = request;
  }
  const transaction = source["transaction"];
  if (typeof transaction === "string" && transaction !== "") {
    scrubbed["transaction"] = routeTemplate(transaction);
  }
  return scrubbed as Event;
}
