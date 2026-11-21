/**
 * Events near the person (docs/outreach.md), on Alignable (decision 112; the owner's pick of 28 Oct 2026: "Once a week
 * it reads events near you, and their hosts and attendees go to the AI to check. It never signs you up.") and on
 * Facebook (decision 188; the owner's pick 7a of 20 Nov 2026: "read once a week like Alignable's, and the hosts and
 * people going get the AI's check, with nothing pressed, plus a Today card listing the events so you can go in
 * person"):
 *
 * - **Once a week** (`EVENTS_EVERY_DAYS`), the person's computer opens the events near them and reads up to 5 it hasn't
 *   read before (`EVENTS_READ_MOST`): on Alignable those in their own town (the town their business page's address
 *   names); on Facebook what its event search shows for their town (`eventSearches`, Settings → You → Where you are, or
 *   the business's address).
 * - **Each event's hosts and guests.** On Alignable they're kept as found (`event`: "Hosting or going to the Alignable
 *   event “Spring Mixer” in Austin, TX") and checked by the AI from their own page, as anyone found is. On Facebook
 *   they're kept with the event (`event_people`) and checked by the AI like friends (`outreach.checks.next`'s `event`,
 *   after followers); a good fit goes on Today for a friend request ("Going to “Spring Mixer” near you").
 * - **Today lists the events** (`TodayEvent`): the ones coming up, the soonest first, each with Open and Not going.
 * - **It never signs the person up**, and presses nothing on an event's page: no RSVP, Going, Interested or Share.
 *
 * Browser-safe: the extension reads these shapes. The server's side is ./ops/events-near.ts.
 */
import { z } from 'zod';
import { PersonName, ProfileRef } from './saves';

/** How many days apart the events near the person are read. */
export const EVENTS_EVERY_DAYS = 7;
/** The most events one read takes: the first ones the town's page lists that weren't read before. */
export const EVENTS_READ_MOST = 5;
/** How many of the events read lately are kept, so none is read twice: about three months of weeks. */
export const EVENTS_KEPT_MOST = 60;
export const EVENT_URL_MOST = 500;
/** An event's name, when and where as its page wrote them, at most. */
export const EVENT_NAME_MOST = 200;
export const EVENT_WHEN_MOST = 120;
export const EVENT_PLACE_MOST = 200;
/** The hosts an event's card names, and the people kept from one event's page on Facebook, at most. */
export const EVENT_HOSTS_MOST = 10;
export const EVENT_PEOPLE_MOST = 40;
/** How long someone seen at an event near the person stays someone to check: a month after the read. */
export const EVENT_PEOPLE_KEPT_DAYS = 30;
/** How many events Today lists, and how far ahead. */
export const EVENTS_TODAY_MOST = 5;
export const EVENTS_AHEAD_DAYS = 45;
/** An event whose day the page didn't say stays on Today this long after it was read. */
export const EVENTS_UNDATED_DAYS = 10;

/** The networks whose events near the person are read. */
export const EVENT_PLATFORMS = ['alignable', 'facebook'] as const;
export type EventPlatform = (typeof EVENT_PLATFORMS)[number];

/** What Facebook's event search looks for near the person, with their town after it: two searches a week at most. */
export const EVENT_SEARCH_WORDS = ['networking', 'business'] as const;

/** Facebook's event searches for a town: "networking Boise, ID", then "business Boise, ID". None with no town. */
export function eventSearches(area: string | null): string[] {
  const town = area?.replace(/\s+/g, ' ').trim();
  return town ? EVENT_SEARCH_WORDS.map((w) => `${w} ${town}`) : [];
}

/** An address on Alignable's own site. */
export function onAlignable(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && /^(www\.)?alignable\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

/** An event's own page on Facebook: /events/<its number>. */
export function onFacebookEvent(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      url.protocol === 'https:' &&
      /^((www|web|m)\.)?facebook\.com$/i.test(url.hostname) &&
      /^\/events\/\d{5,}\/?/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

const eventUrlOn = (platform: EventPlatform, href: string) =>
  platform === 'facebook' ? onFacebookEvent(href) : onAlignable(href);

const EventUrl = z.string().trim().min(1).max(EVENT_URL_MOST);
const line = (most: number) =>
  z
    .string()
    .transform((t) => t.replace(/\s+/g, ' ').trim())
    .transform((t) => (t.length > most ? `${t.slice(0, most - 1).trimEnd()}…` : t))
    .nullable()
    .default(null)
    .transform((t) => t || null);

/** Someone an event's page showed hosting it or going. */
export const EventPerson = z.object({ profile: ProfileRef, name: PersonName });
export type EventPerson = z.input<typeof EventPerson>;

/** An event as its page showed it: for Today's card, and on Facebook, who hosts it and who's going. */
export const EventSeen = z.object({
  url: EventUrl,
  name: z
    .string()
    .transform((t) => t.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Send the event’s name as its page shows it.'))
    .transform((t) =>
      t.length > EVENT_NAME_MOST ? `${t.slice(0, EVENT_NAME_MOST - 1).trimEnd()}…` : t,
    ),
  /** When, as the page wrote it: "Thursday, December 4, 2025 at 7:30 AM CST". */
  when: line(EVENT_WHEN_MOST),
  /** When it starts, when the page said a day and time the extension could read. */
  startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  /** Where, as the page wrote it: a place's name, an address, or "Online". */
  place: line(EVENT_PLACE_MOST),
  hosts: z.array(EventPerson).max(EVENT_HOSTS_MOST).default([]),
  /** Who's going, as far as the page showed them without pressing anything: kept on Facebook only. */
  guests: z.array(EventPerson).max(EVENT_PEOPLE_MOST).default([]),
});
export type EventSeen = z.input<typeof EventSeen>;

export const EventsNextInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(EVENT_PLATFORMS).default('alignable'),
});
export type EventsNextInput = z.input<typeof EventsNextInput>;
export const EventsNextOutput = z.object({
  /** Whether this week's read is still to do: never read, or last read a week ago or more. */
  due: z.boolean(),
  /** The events read lately, by their own addresses: never read again. */
  read: z.array(z.string()),
  /** On Facebook, what its event search looks for, in turn (`eventSearches`): none with no town known. */
  searches: z.array(z.string()).default([]),
});
export type EventsNextOutput = z.output<typeof EventsNextOutput>;

export const EventsReadInput = z
  .object({
    workspaceId: z.uuid(),
    platform: z.enum(EVENT_PLATFORMS).default('alignable'),
    /** The events read this time, by their own addresses: none when the town showed none new. */
    urls: z.array(EventUrl).max(EVENTS_READ_MOST).default([]),
    /** What each event read showed, for Today's card (from 0.150.0): builds before send only their addresses. */
    events: z.array(EventSeen).max(EVENTS_READ_MOST).default([]),
  })
  .superRefine((input, ctx) => {
    for (const [i, url] of input.urls.entries())
      if (!eventUrlOn(input.platform, url))
        ctx.addIssue({
          code: 'custom',
          path: ['urls', i],
          message:
            input.platform === 'facebook'
              ? 'Send the event’s own address on Facebook.'
              : 'Send the event’s own address on Alignable.',
        });
    for (const [i, event] of input.events.entries())
      if (!eventUrlOn(input.platform, event.url))
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'url'],
          message: 'Send the event’s own address on the network it was read on.',
        });
  });
export type EventsReadInput = z.input<typeof EventsReadInput>;
export const EventsReadOutput = z.object({
  /** When the events were read: the next read is a week on. */
  readAt: z.string(),
  /** On Facebook, the people new at these events who aren't friends: the AI checks them like friends. */
  added: z.number().int().min(0).default(0),
});
export type EventsReadOutput = z.output<typeof EventsReadOutput>;

/** What Today says of someone at an event near the person, and what the AI's check is told of them. */
export const eventWhy = (name: string, host: boolean) =>
  host ? `Hosting “${name}” near you` : `Going to “${name}” near you`;
export const eventFact = (name: string, place: string | null, host: boolean) =>
  `${host ? 'Hosting' : 'Going to'} the Facebook event “${name}”${place ? ` (${place})` : ''} near the owner, though they aren’t friends`;

/** An event on Today's card (decision 188): what it is, when and where, and who hosts it. */
export const TodayEvent = z.object({
  id: z.uuid(),
  url: z.string(),
  name: z.string(),
  when: z.string().nullable(),
  startsAt: z.string().nullable(),
  place: z.string().nullable(),
  hosts: z.array(z.string()),
  /** People hosting or going whom the AI is checking, or who fit: on Facebook. */
  people: z.number().int().min(0),
});
export type TodayEvent = z.output<typeof TodayEvent>;

export const EVENT_WORDS = {
  title: 'Events near you',
  about: 'Read from the events near you this week. Go in person to meet people.',
  open: 'Open',
  skip: 'Not going',
  hosted: (hosts: readonly string[]) =>
    hosts.length ? `Hosted by ${hosts.slice(0, 3).join(', ')}` : null,
  people: (n: number) => (n ? `${n} ${n === 1 ? 'person' : 'people'} there to check` : null),
} as const;

export const EventSkipInput = z.object({ workspaceId: z.uuid(), eventId: z.uuid() });
export type EventSkipInput = z.input<typeof EventSkipInput>;
export const EventSkipOutput = z.object({ skipped: z.boolean() });
export type EventSkipOutput = z.output<typeof EventSkipOutput>;
