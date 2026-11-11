import { DOMAIN_EVENTS, DOMAIN_EVENT_NAMES, DomainEventPayloadError, parseDomainEventPayload, type AnyDomainEvent, type DomainEventField, type DomainEventName } from "@slugbase/core";
import { z } from "zod";
import { defineJob, type JobDefinition } from "../worker/job.ts";
import { eventJobName } from "./publish.ts";
import type { RegisteredSubscriber } from "./subscriber.ts";

// The worker's side of publication: one built-in job `event.<name>` per catalog event, which hands the
// event to every subscriber the composed modules registered for it, in registration order.

/** Thrown when a subscriber failed, so the job retries; it names modules and never the payload. */
export class EventDeliveryError extends Error {
  constructor(name: string, modules: readonly string[]) {
    super(`the event ${name} was not delivered to ${modules.join(", ")}`);
    this.name = "EventDeliveryError";
  }
}

const EVENT_ID = z.uuid();

// The JSON text of a valid list is at most 1,977 characters: eight entries of an identifier of 32 characters and a version of 32 lone surrogates, which `JSON.stringify` writes as six characters each (checked with node). Keep this above that bound.
const ACKNOWLEDGEMENTS_TEXT_MAX = 2048;

function fieldSchema(field: DomainEventField): z.ZodType {
  switch (field.type) {
    case "uuid":
      return z.uuid();
    case "enum":
      return z.enum(field.values);
    case "acknowledgements":
      // The JSON text of the list (see `queueDomainEvent`); a job queued by the release before the field existed has none, which is an empty list.
      return z.string().max(ACKNOWLEDGEMENTS_TEXT_MAX).default("[]");
  }
}

function payloadShape(name: DomainEventName): z.ZodRawShape {
  const fields: Readonly<Record<string, DomainEventField>> = DOMAIN_EVENTS[name];
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, fieldSchema(field)]));
}

/** The catalog payload of a job's fields: the text of an acknowledgements field is read back as its list. */
function decoded(name: DomainEventName, fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const declared: Readonly<Record<string, DomainEventField>> = DOMAIN_EVENTS[name];
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (declared[key]?.type !== "acknowledgements" || typeof value !== "string") {
        return [key, value];
      }
      try {
        return [key, JSON.parse(value) as unknown];
      } catch {
        throw new DomainEventPayloadError(name, `has no valid ${key}`);
      }
    }),
  );
}

/** The value with it and every object or array it holds frozen. */
function deepFrozen<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) {
      deepFrozen(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The event jobs. Delivery is at least once: a subscriber that failed makes the job run again, and every
 * subscriber sees the event again, so each is idempotent on `eventId`. One failing subscriber does not keep the
 * others from running in the attempt. The event is deeply frozen, so every subscriber sees the same payload. A failure is logged with the event name, the identifier and the module,
 * never the payload.
 */
export function eventJobs(subscribersFor: (name: DomainEventName) => readonly RegisteredSubscriber[]): readonly JobDefinition[] {
  return DOMAIN_EVENT_NAMES.map((name) =>
    defineJob({
      name: eventJobName(name),
      payload: z.object({ eventId: EVENT_ID, ...payloadShape(name) }),
      handle: async ({ eventId, ...fields }, context) => {
        const subscribers = subscribersFor(name);
        if (subscribers.length === 0) {
          return;
        }
        // Every subscriber receives the same deeply frozen event, so none changes what a later one sees.
        const event = deepFrozen({ eventId: EVENT_ID.parse(eventId), name, payload: parseDomainEventPayload(name, decoded(name, fields)) }) as AnyDomainEvent;
        const failed: string[] = [];
        for (const subscriber of subscribers) {
          try {
            await subscriber.handle(event);
          } catch (error) {
            failed.push(subscriber.module);
            context.logger.error("An event subscriber failed", {
              event: name,
              eventId: event.eventId,
              module: subscriber.module,
              error: error instanceof Error ? error.name : typeof error,
            });
          }
        }
        if (failed.length > 0) {
          throw new EventDeliveryError(name, failed);
        }
      },
    }),
  );
}
