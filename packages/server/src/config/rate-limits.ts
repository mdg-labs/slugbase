import { z } from "zod";
import { envFragment } from "./fragment.ts";

// The bucket registry of doc 04 section 7: every bucket an operation can name, the
// scopes it is limited by, and the default of each. The defaults and the
// `RATE_LIMIT_<BUCKET>_<SCOPE>` keys that override them live here and nowhere
// else: the rate-limit stage reads the registry for what to take, and the
// composition root reads it for the limits the Postgres adapter enforces.
//
// Doc 02 section 16 lists the same values as doc 04 section 7. Where the two
// differ, doc 02 wins; today they agree on every value, so nothing is overridden.
//
// Scopes: `ip` is the client address as resolved through the trusted proxies,
// `account` the authenticated principal's account, `workspace` the principal's
// workspace. `email` is a limit per target email address of a credential
// operation; the stage cannot know it, so the operation that takes the address
// consumes it.

/** How long a bucket takes to refill from empty, by unit. */
const PERIOD_SECONDS = { sec: 1, min: 60, hour: 3600 } as const;

export const RATE_LIMIT_SCOPES = ["ip", "account", "workspace", "email"] as const;
export type RateScope = (typeof RATE_LIMIT_SCOPES)[number];

/** `count` tokens, refilled evenly over `windowSeconds`. */
export interface RateLimitSpec {
  readonly count: number;
  readonly windowSeconds: number;
}

/** What the Postgres adapter enforces: a bucket of `capacity` tokens that refills `refillPerSecond` every second. */
export interface RateLimitWindow {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export const RATE_LIMIT_DEFAULTS = {
  login: { ip: "10/min", email: "20/hour" },
  mfa: { ip: "10/min", account: "30/hour" },
  register: { ip: "5/hour" },
  reset: { ip: "5/hour", email: "3/hour" },
  token_redeem: { ip: "10/hour", account: "10/hour" },
  token_create: { ip: "20/hour", account: "20/hour" },
  setup: { ip: "10/hour" },
  go: { ip: "600/min", account: "300/min" },
  read: { ip: "1200/min", account: "1200/min" },
  write: { ip: "300/min", account: "120/min" },
  bulk: { ip: "20/hour", account: "20/hour" },
  fetch: { ip: "120/min", account: "60/min" },
  ai: { ip: "60/hour", account: "60/hour", workspace: "600/hour" },
  public: { ip: "300/min" },
} as const satisfies Record<string, Partial<Record<RateScope, string>>>;

export type RateLimitDefaults = typeof RATE_LIMIT_DEFAULTS;
/** The name of a bucket of doc 04 section 7 other than `none`. */
export type RateLimitBucket = keyof RateLimitDefaults;

/** Every `RATE_LIMIT_<BUCKET>_<SCOPE>` key the registry declares. */
export type RateLimitKey = {
  [Bucket in RateLimitBucket]: {
    [Scope in keyof RateLimitDefaults[Bucket] & string]: `RATE_LIMIT_${Uppercase<Bucket>}_${Uppercase<Scope>}`;
  }[keyof RateLimitDefaults[Bucket] & string];
}[RateLimitBucket];

/** The part of a process configuration the registry reads. */
export type RateLimitConfig = { readonly [Key in RateLimitKey]: RateLimitSpec };

function parseSpec(value: string): RateLimitSpec | undefined {
  const match = /^(\d{1,7})\/(sec|min|hour)$/.exec(value);
  const count = Number(match?.[1]);
  const unit = match?.[2];
  if (unit !== "sec" && unit !== "min" && unit !== "hour") {
    return undefined;
  }
  return count >= 1 ? { count, windowSeconds: PERIOD_SECONDS[unit] } : undefined;
}

function limitField(fallback: string): z.ZodType<RateLimitSpec> {
  const spec = parseSpec(fallback);
  if (spec === undefined) {
    throw new Error(`the default rate limit ${fallback} is not a limit`);
  }
  const field = z
    .string()
    .refine((value) => parseSpec(value) !== undefined, {
      error: "must be a count and a period such as 5/hour (the period is sec, min or hour)",
    })
    .transform((value) => parseSpec(value) as RateLimitSpec)
    .default(spec);
  return z.preprocess((value) => (value === "" ? undefined : value), field);
}

export function rateLimitKey(bucket: string, scope: RateScope): string {
  return `RATE_LIMIT_${bucket.toUpperCase()}_${scope.toUpperCase()}`;
}

/** The name the rate-limit port knows a bucket's scope by: the bucket itself for `ip`, else `<bucket>:<scope>`. */
export function limitName(bucket: string, scope: RateScope): string {
  return scope === "ip" ? bucket : `${bucket}:${scope}`;
}

const SHAPE = Object.fromEntries(
  Object.entries(RATE_LIMIT_DEFAULTS).flatMap(([bucket, scopes]) =>
    Object.entries(scopes).map(([scope, fallback]) => [rateLimitKey(bucket, scope as RateScope), limitField(fallback)] as const),
  ),
) as Record<RateLimitKey, z.ZodType<RateLimitSpec>>;

/** The limits of the registry, as `RATE_LIMIT_<BUCKET>_<SCOPE>` keys, for the server and the worker. */
export const rateLimitFragment = envFragment({ shape: SHAPE });

/** One limit of a bucket: the scope it is keyed by, its name at the port and what it allows. */
export interface ScopeLimit {
  readonly scope: RateScope;
  readonly name: string;
  readonly spec: RateLimitSpec;
}

export interface RateLimitRegistry {
  /** The limits of a bucket in the order the stage takes them, or `undefined` for a name no operation of this registry can declare. */
  scopesOf(bucket: string): readonly ScopeLimit[] | undefined;
  /** The window the port enforces for `limitName(bucket, scope)`; `undefined` for a name that is no limit. */
  window(name: string): RateLimitWindow | undefined;
}

export const RATE_LIMIT_BUCKETS = Object.keys(RATE_LIMIT_DEFAULTS) as readonly RateLimitBucket[];

export function createRateLimitRegistry(config: RateLimitConfig): RateLimitRegistry {
  const byBucket = new Map<string, readonly ScopeLimit[]>();
  const byName = new Map<string, RateLimitSpec>();
  for (const bucket of RATE_LIMIT_BUCKETS) {
    const declared: Partial<Record<RateScope, string>> = RATE_LIMIT_DEFAULTS[bucket];
    const limits = RATE_LIMIT_SCOPES.filter((scope) => scope in declared).map((scope): ScopeLimit => {
      const spec = config[rateLimitKey(bucket, scope) as RateLimitKey];
      return { scope, name: limitName(bucket, scope), spec };
    });
    byBucket.set(bucket, limits);
    for (const limit of limits) {
      byName.set(limit.name, limit.spec);
    }
  }
  return {
    scopesOf: (bucket) => byBucket.get(bucket),
    window(name) {
      const spec = byName.get(name);
      return spec === undefined ? undefined : { capacity: spec.count, refillPerSecond: spec.count / spec.windowSeconds };
    },
  };
}
