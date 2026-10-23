// The domain event catalog (doc 01 section 7.1 and 7.4, doc 09 section 2): the
// notification points inside core flows. An event announces a change that is
// committed; it never vetoes or alters the flow (the hooks of doc 01 section 13
// do that). A payload holds scalar identifiers and enumerated values only: never
// an email address, a name or any other personal data, because the payload travels
// through the job queue and the logs of the subscribers (doc 10 T7). A subscriber
// that needs more reads current state by identifier. Adding an event is a contract
// change (doc 01 section 7.4).

/** How an account came to exist; `setup` is first-run setup, which the registration policy skips (doc 01 section 13.5). */
export const ACCOUNT_CREATION_PATHS = ["self-registration", "invitation", "oidc", "setup"] as const;

export type AccountCreationPath = (typeof ACCOUNT_CREATION_PATHS)[number];

/** What happens to the content of a member who leaves or is removed (doc 02 section 3.6). */
export const MEMBER_CONTENT_CHOICES = ["transfer", "delete"] as const;

export type MemberContentChoice = (typeof MEMBER_CONTENT_CHOICES)[number];

/** The roles a membership can hold (doc 02 section 3.3). */
const MEMBER_ROLES = ["owner", "admin", "member"] as const;

/** The kinds of field a payload holds. */
export type DomainEventField =
  | { readonly type: "uuid" }
  | { readonly type: "enum"; readonly values: readonly [string, ...string[]] };

/** The payload of every event, field by field. */
export const DOMAIN_EVENTS = {
  "account.created": {
    accountId: { type: "uuid" },
    path: { type: "enum", values: ACCOUNT_CREATION_PATHS },
  },
  /**
   * An account is gone, with everything personal to it: queued in the transaction that deletes the account row, so it
   * is announced once, when the account no longer exists. A module that owns content keeps the account's content in
   * the workspaces that remain ownerless (its foreign keys to the account set the owner to NULL, Q54) and removes
   * whatever personal data of its own it holds, identified by `accountId`.
   */
  "account.deleted": {
    accountId: { type: "uuid" },
  },
  "workspace.created": {
    workspaceId: { type: "uuid" },
    /** The account the workspace was created for, which is its owner. */
    accountId: { type: "uuid" },
  },
  /**
   * A workspace's rows are all gone: queued in the transaction of the deletion job that removes the workspace row,
   * so it is announced exactly once, when the workspace no longer exists. A subscriber that holds data of its own
   * about the workspace removes it, identified by `workspaceId`.
   */
  "workspace.deleted": {
    workspaceId: { type: "uuid" },
  },
  /**
   * A membership ended, by the member leaving or by an admin removing the member; it is queued in the transaction that
   * deletes the membership. `transferTo` is the recipient the request resolved to, carried for `delete` as well, where
   * it is not used.
   */
  "member.left": {
    workspaceId: { type: "uuid" },
    accountId: { type: "uuid" },
    content: { type: "enum", values: MEMBER_CONTENT_CHOICES },
    transferTo: { type: "uuid" },
  },
  /**
   * An account became a member of a workspace by accepting an invitation; it is queued in the transaction that inserts
   * the membership, so it is announced exactly when the membership exists. A module that counts seats recounts on it.
   * `role` is the role the membership was given.
   */
  "member.joined": {
    workspaceId: { type: "uuid" },
    accountId: { type: "uuid" },
    role: { type: "enum", values: MEMBER_ROLES },
  },
  /**
   * A bookmark was created: queued in the transaction that inserts it, so it is announced exactly when the bookmark
   * exists. `accountId` is the member who created it and owns it. A subscriber that needs the bookmark reads it by
   * `bookmarkId`; the payload holds no URL or title.
   */
  "bookmark.created": {
    workspaceId: { type: "uuid" },
    bookmarkId: { type: "uuid" },
    accountId: { type: "uuid" },
  },
} as const satisfies Record<string, Readonly<Record<string, DomainEventField>>>;

export type DomainEventName = keyof typeof DOMAIN_EVENTS;

/** The value a field holds: the listed values of an enum, a string for an identifier. */
export type DomainEventFieldValue<Field> = Field extends { readonly values: readonly (infer Value)[] } ? Value : string;

/** The payload of the event `Name`. */
export type DomainEventPayload<Name extends DomainEventName = DomainEventName> = {
  readonly [Key in keyof (typeof DOMAIN_EVENTS)[Name]]: DomainEventFieldValue<(typeof DOMAIN_EVENTS)[Name][Key]>;
};

/** What a subscriber receives. `eventId` is the same on every delivery of one event, so a subscriber deduplicates on it. */
export interface DomainEvent<Name extends DomainEventName = DomainEventName> {
  readonly eventId: string;
  readonly name: Name;
  readonly payload: DomainEventPayload<Name>;
}

/** The events a subscriber binds to, as the union of `DomainEvent` over the catalog. */
export type AnyDomainEvent = { [Name in DomainEventName]: DomainEvent<Name> }[DomainEventName];

export const DOMAIN_EVENT_NAMES = Object.keys(DOMAIN_EVENTS) as readonly DomainEventName[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDomainEventName(value: unknown): value is DomainEventName {
  return typeof value === "string" && Object.hasOwn(DOMAIN_EVENTS, value);
}

/** Thrown when a payload is not the one the catalog declares for its event; the message names fields, never values. */
export class DomainEventPayloadError extends Error {
  constructor(name: string, problem: string) {
    super(`the payload of ${name} ${problem}`);
    this.name = "DomainEventPayloadError";
  }
}

function fits(field: DomainEventField, value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return field.type === "uuid" ? UUID.test(value) : field.values.includes(value);
}

/** The payload of the event `name` as the catalog declares it: exactly its fields, each of its kind; anything else throws. */
export function parseDomainEventPayload<Name extends DomainEventName>(name: Name, value: unknown): DomainEventPayload<Name> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainEventPayloadError(name, "must be an object");
  }
  const fields: Readonly<Record<string, DomainEventField>> = DOMAIN_EVENTS[name];
  const given = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(fields, key)) {
      throw new DomainEventPayloadError(name, `has the field ${key}, which the catalog does not declare`);
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    if (!fits(field, given[key])) {
      throw new DomainEventPayloadError(name, `has no valid ${key}`);
    }
  }
  return given as DomainEventPayload<Name>;
}
