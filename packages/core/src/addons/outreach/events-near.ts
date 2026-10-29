/**
 * Events near the person on Alignable (docs/outreach.md, decision 112; the owner's pick of 28 Oct 2026: "Once a week it
 * reads events near you, and their hosts and attendees go to the AI to check. It never signs you up."):
 *
 * - **Once a week** (`EVENTS_EVERY_DAYS`), the person's computer opens the events in their own town on Alignable (the
 *   town their business page's address names) and reads up to 5 it hasn't read before (`EVENTS_READ_MOST`).
 * - **Each event's hosts and guests** are kept as found (`event`: "Hosting or going to the Alignable event “Spring
 *   Mixer” in Austin, TX") and checked by the AI from their own page before anything is done for them, as anyone found
 *   is. Only a good check puts them on Today.
 * - **It never signs the person up**, and presses nothing on an event's page: no RSVP, Going, Interested or Share.
 *
 * Browser-safe: the extension reads these shapes. The server's side is ./ops/events-near.ts.
 */
import { z } from 'zod';

/** How many days apart the events near the person are read. */
export const EVENTS_EVERY_DAYS = 7;
/** The most events one read takes: the first ones the town's page lists that weren't read before. */
export const EVENTS_READ_MOST = 5;
/** How many of the events read lately are kept, so none is read twice: about three months of weeks. */
export const EVENTS_KEPT_MOST = 60;
export const EVENT_URL_MOST = 500;

/** An address on Alignable's own site. */
export function onAlignable(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && /^(www\.)?alignable\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

const EventUrl = z
  .string()
  .trim()
  .min(1)
  .max(EVENT_URL_MOST)
  .refine(onAlignable, { error: 'Send the event’s own address on Alignable.' });

export const EventsNextInput = z.object({
  workspaceId: z.uuid(),
  platform: z.literal('alignable').default('alignable'),
});
export type EventsNextInput = z.input<typeof EventsNextInput>;
export const EventsNextOutput = z.object({
  /** Whether this week's read is still to do: never read, or last read a week ago or more. */
  due: z.boolean(),
  /** The events read lately, by their own addresses: never read again. */
  read: z.array(z.string()),
});
export type EventsNextOutput = z.output<typeof EventsNextOutput>;

export const EventsReadInput = z.object({
  workspaceId: z.uuid(),
  platform: z.literal('alignable').default('alignable'),
  /** The events read this time, by their own addresses: none when the town showed none new. */
  urls: z.array(EventUrl).max(EVENTS_READ_MOST).default([]),
});
export type EventsReadInput = z.input<typeof EventsReadInput>;
export const EventsReadOutput = z.object({
  /** When the events were read: the next read is a week on. */
  readAt: z.string(),
});
export type EventsReadOutput = z.output<typeof EventsReadOutput>;
