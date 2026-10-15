import { DOMAIN_EVENTS, DOMAIN_EVENT_NAMES, parseDomainEventPayload, type AnyDomainEvent, type DomainEventField, type DomainEventName } from "@slugbase/core";
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

function payloadShape(name: DomainEventName): z.ZodRawShape {
  const fields: Readonly<Record<string, DomainEventField>> = DOMAIN_EVENTS[name];
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.type === "uuid" ? z.uuid() : z.enum(field.values)]));
}

/**
 * The event jobs. Delivery is at least once: a subscriber that failed makes the job run again, and every
 * subscriber sees the event again, so each is idempotent on `eventId`. One failing subscriber does not keep the
 * others from running in the attempt. A failure is logged with the event name, the identifier and the module,
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
        const event = { eventId: EVENT_ID.parse(eventId), name, payload: parseDomainEventPayload(name, fields) } as AnyDomainEvent;
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
