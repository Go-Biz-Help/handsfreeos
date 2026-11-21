/**
 * **Events near you** on Facebook (docs/outreach.md decision 188; `events`, once a week while the extension works on
 * its own there, before the day's checks). The owner's pick 7a: "Local Facebook events: read once a week like
 * Alignable's, and the hosts and people going get the AI's check, with nothing pressed, plus a Today card listing the
 * events so you can go in person."
 *
 * HandsFreeOS says whether this week's read is due, which events were read lately, and what to search for near the
 * person (`outreach.events.next`: "networking Boise, ID", then "business Boise, ID", from Settings → You → Where you
 * are, or the business's address). Facebook's event search is opened for each in turn and read a screen or two; up to
 * 5 events coming up that weren't read before are opened, at a person's pace, and each one's name, day, place, hosts
 * and the guests its page shows go to HandsFreeOS (`outreach.events.read`). There the events go on Today's Events near
 * you, and the people who aren't the person's friends are checked by the AI like friends, inside the day's checks; the
 * good fits go on Today for a friend request. Nothing is pressed on an event, so they're never signed up: no Going,
 * Interested, Invite or Share, and no See all. It stops on any Facebook warning.
 *
 * The search and the event's page are read by guesses till the owner's next Check Facebook outlines them: a search that
 * showed no events, or an event that showed nobody, is noted with its outline so the readers can be tuned.
 */
import {
  EVENTS_READ_MOST,
  EventPerson,
  type EventSeen,
} from '@hfos/core/addons/outreach/events-near';
import type { EventCard, EventGoer, EventPage } from '../networks/facebook/types';
import { FACEBOOK, profileKey } from '../networks/facebook/urls';
import { counted } from '../words';
import { pause, paced, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** Facebook's search of events, for some words. */
export const eventSearch = (words: string) =>
  `${FACEBOOK}/search/events/?q=${encodeURIComponent(words)}`;
/** Screens of a search read, and of an event's page (its Guests are below its details). */
const SEARCH_SCREENS = 2;
const EVENT_SCREENS = 2;
/** Between pages: a person going from one event to the next. */
const PAGE_PACE_MS = [15_000, 30_000] as const;
const SCROLL_PACE_MS = [4_000, 9_000] as const;
/** While an event's page draws its details and its guests. */
const DRAWN_MS = 1_500;
/** An event that started this long ago is gone by: never opened. */
const STARTED_MS = 2 * 60 * 60_000;

/** With no town known, there's nothing near the person to search for: what the person does about it. */
export const NO_TOWN_FACEBOOK_EVENTS =
  'HandsFreeOS doesn’t know where you are, so the events near you on Facebook weren’t read. Set your town in Social Outreach’s Settings → You → Where you are, or add your business’s address; they’re read next time.';

/** The words at the end of the week's line. */
const NOTHING_PRESSED = 'Nothing on an event was pressed, so you’re never signed up.';

/** The people an event's page showed, each once, as HandsFreeOS takes them: a name and a profile it can keep. */
function sendable(goers: readonly EventGoer[]): EventPerson[] {
  const seen = new Set<string>();
  const out: EventPerson[] = [];
  for (const goer of goers) {
    const key = profileKey(goer.profile);
    if (seen.has(key)) continue;
    const person = { profile: goer.profile, name: goer.name.slice(0, 80) };
    if (!EventPerson.safeParse(person).success) continue;
    seen.add(key);
    out.push(person);
  }
  return out;
}

/** What one event showed, for HandsFreeOS: its page's words, and its card's where the page said nothing. */
export function eventSeen(card: EventCard, page: EventPage | null): EventSeen {
  return {
    url: card.url,
    name: page?.name || card.name,
    when: page?.when ?? card.when,
    startsAt: page?.startsAt ?? card.startsAt,
    place: page?.place ?? card.place,
    hosts: sendable(page?.hosts ?? []).slice(0, 10),
    guests: sendable(page?.guests ?? []).slice(0, 40),
  };
}

const ended = (got: object): got is JobEnd => 'warned' in got;

/** One search's events, a screen or two of them. A warning ends it. */
async function searchEvents(job: Job, words: string): Promise<EventCard[] | JobEnd> {
  job.progress(`Searching Facebook’s events for “${words}”…`);
  await job.tab.open(eventSearch(words));
  const found = new Map<string, EventCard>();
  let page = await readIn(job.tab);
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    for (const card of page.events ?? []) if (!found.has(card.url)) found.set(card.url, card);
    job.progress(`Reading the events for “${words}”… ${counted(found.size, 'event')} so far.`);
    if (screen >= SEARCH_SCREENS - 1 || job.stopped()) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-page' })).ok) break;
    await pause(paced(SCROLL_PACE_MS));
    page = await readIn(job.tab);
  }
  return [...found.values()];
}

/** One event's page, read a screen or two down for its guests: hosts and guests from every screen. */
async function readEvent(job: Job, card: EventCard): Promise<EventPage | null | JobEnd> {
  job.progress(`Opening “${card.name}”…`);
  await job.tab.open(card.url);
  await pause(DRAWN_MS);
  let event: EventPage | null = null;
  const hosts = new Map<string, EventGoer>();
  const guests = new Map<string, EventGoer>();
  for (let screen = 0; ; screen++) {
    const page = await readIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.event) {
      event ??= page.event;
      for (const h of page.event.hosts) hosts.set(profileKey(h.profile), h);
      for (const g of page.event.guests) guests.set(profileKey(g.profile), g);
    }
    if (screen >= EVENT_SCREENS - 1 || job.stopped()) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-page' })).ok) break;
    await pause(paced(SCROLL_PACE_MS));
  }
  if (!event) return null;
  return {
    ...event,
    hosts: [...hosts.values()],
    guests: [...guests.values()].filter((g) => !hosts.has(profileKey(g.profile))),
  };
}

/** This week's events near the person on Facebook, if it's due: up to 5 coming up, and who's hosting and going. */
export async function readFacebookEvents(
  job: Job,
  now: () => Date = () => new Date(),
): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS whether this week’s events near you are read…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-events-next',
      input: { workspaceId: job.businessId, platform: 'facebook' },
    }),
  );
  if (!next.due)
    return {
      line: 'The events near you were read this week. They’re read again a week after the last time.',
      warned: false,
    };
  if (!next.searches.length) return { line: NO_TOWN_FACEBOOK_EVENTS, warned: false, failed: true };
  const before = new Set(next.read);
  const listed = new Map<string, EventCard>();
  const comingUp = (card: EventCard) =>
    !card.startsAt || Date.parse(card.startsAt) >= now().getTime() - STARTED_MS;
  const fresh = () =>
    [...listed.values()]
      .filter((c) => !before.has(c.url) && comingUp(c))
      .slice(0, EVENTS_READ_MOST);
  for (const [i, words] of next.searches.entries()) {
    if (job.stopped() || fresh().length >= EVENTS_READ_MOST) break;
    if (i) await pause(paced(PAGE_PACE_MS));
    const cards = await searchEvents(job, words);
    if (ended(cards)) return cards;
    for (const card of cards) if (!listed.has(card.url)) listed.set(card.url, card);
  }
  if (!listed.size && !job.stopped())
    await job.report?.({ note: 'Facebook’s event search showed no events.', outline: true });
  const read: EventSeen[] = [];
  let shown = 0;
  for (const card of fresh()) {
    if (job.stopped()) break;
    await pause(paced(PAGE_PACE_MS));
    const page = await readEvent(job, card);
    if (page && ended(page)) return page;
    const seen = eventSeen(card, page);
    read.push(seen);
    const people = (seen.hosts?.length ?? 0) + (seen.guests?.length ?? 0);
    shown += people;
    job.progress(`Read “${seen.name}”: ${counted(people, 'person', 'people')} hosting or going.`);
    if (!people)
      await job.report?.({
        note: page
          ? 'Facebook showed nobody hosting or going to an event.'
          : 'An event’s page didn’t read as an event.',
        outline: true,
      });
  }
  // The week's read is done once it got through, even with nothing new; stopped before any, it's read next time.
  let added = 0;
  if (!job.stopped() || read.length)
    added = valueOf(
      await job.hfos({
        type: 'hfos-events-read',
        input: {
          workspaceId: job.businessId,
          platform: 'facebook',
          urls: read.map((e) => e.url),
          events: read,
        },
      }),
    ).added;
  const stopped = job.stopped() ? 'Stopped. ' : '';
  if (!read.length)
    return {
      line: `${stopped}${listed.size ? 'No new events near you on Facebook: every one listed was read before, or has been.' : 'Facebook’s event search showed no events near you.'} They’re read again next week.`,
      warned: false,
    };
  const parts = [
    `${stopped}Read ${counted(read.length, 'event')} near you on Facebook: ${counted(shown, 'person', 'people')} hosting or going, ${added.toLocaleString()} new who aren’t your friends.`,
    'The events are on Today so you can go in person.',
    added
      ? 'The AI checks the people like friends, and the good fits come onto Today for a friend request.'
      : null,
    NOTHING_PRESSED,
  ];
  return { line: parts.filter(Boolean).join(' '), warned: false };
}
