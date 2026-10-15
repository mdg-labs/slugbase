import { isDomainEventName, type AnyDomainEvent, type DomainEvent, type DomainEventName } from "@slugbase/core";

/**
 * A module's binding to one domain event (doc 01 section 7.1). `handle` receives the event once per
 * delivery; delivery is at least once, so it must leave the same state however often it sees one
 * `eventId`. It cannot veto or change the flow that emitted the event.
 */
export interface EventBinding<Name extends DomainEventName = DomainEventName> {
  readonly event: Name;
  readonly handle: (event: DomainEvent<Name>) => void | Promise<void>;
}

/** A binding to any event of the catalog, `handle` typed from the event it names. */
export type EventSubscriber = { [Name in DomainEventName]: EventBinding<Name> }[DomainEventName];

/** A subscriber with the module that registered it; `handle` takes the event it was registered for. */
export interface RegisteredSubscriber {
  readonly module: string;
  readonly event: DomainEventName;
  // A method, so that a handler typed for one event is accepted where any event is named; it is only called with its own.
  handle(event: AnyDomainEvent): void | Promise<void>;
}

/** The subscriber a module declared, which `invalidSubscriber` accepted. */
export function registeredSubscriber(module: string, subscriber: EventSubscriber): RegisteredSubscriber {
  return { module, event: subscriber.event, handle: subscriber.handle };
}

/** The subscribers registered for the event `name`, in registration order. */
export function subscribersOf(registered: readonly RegisteredSubscriber[], name: string): readonly RegisteredSubscriber[] {
  return registered.filter(({ event }) => event === name);
}

/** Why a subscriber is invalid, or undefined when it names an event of the catalog and has a function to call. */
export function invalidSubscriber(subscriber: unknown): string | undefined {
  if (typeof subscriber !== "object" || subscriber === null) {
    return "a subscriber must be an object with an event and a handle function";
  }
  const { event, handle } = subscriber as { event?: unknown; handle?: unknown };
  if (!isDomainEventName(event)) {
    return `${typeof event === "string" ? event : "an event name"} is not an event of the catalog`;
  }
  if (typeof handle !== "function") {
    return `the handler for ${event} must be a function`;
  }
  return undefined;
}
