/**
 * **Events near you** on Alignable (docs/outreach.md decision 112; `events`, once a week while the extension works on
 * its own there). The owner's pick: "Once a week it reads events near you, and their hosts and attendees go to the AI
 * to check. It never signs you up."
 *
 * HandsFreeOS says whether this week's read is due, and which events were read lately (`outreach.events.next`). The
 * person's own town comes from their business page's address; its events page lists what's on near them. Up to 5
 * events not read before are opened in turn, at a person's pace, and each one's hosts and guests go to HandsFreeOS as
 * found (`event`, with the event's name and the town) for the AI's found check (../found-checks.ts): only a good check
 * puts one on Today. Never the person's own business. Nothing is pressed on an event, so they're never signed up: no
 * RSVP, Going or Interested. It stops on any Alignable warning.
 *
 * The events page's address and its readers are guesses till the owner's next Check Alignable outlines them: a page
 * that showed no events, or an event that showed nobody, is noted with its outline so they can be tuned.
 */
import { EVENTS_READ_MOST } from '@hfos/core/addons/outreach/events-near';
import { findsSave } from '../../hfos/saves';
import type { EventCard, Member } from '../../networks/alignable/read';
import { townOf } from '../../networks/alignable/site';
import { counted } from '../../words';
import { paced, pause, valueOf, type Job, type JobEnd } from '../job';
import { ALIGNABLE, ended, gather, mine, notMine, PAGE_PACE_MS, townPlace } from './read';

/**
 * The events in a town, at each of the addresses they may be at, in turn: under the town's address (/austin-tx/events),
 * then under its own group's, where Alignable opens a town (/groups/austin-tx/events, the owner's Check, 0.66.0).
 * Guesses till the owner's next Check Alignable reads the real one.
 */
export const EVENTS_AT = [
  (town: string) => `${ALIGNABLE}/${town}/events`,
  (town: string) => `${ALIGNABLE}/groups/${town}/events`,
] as const;
/** Screens of the town's events read, and of an event's people. */
const LIST_SCREENS = 2;
const PEOPLE_SCREENS = 2;
/** While an event's page draws who's going. */
const DRAWN_MS = 1_500;

/** With no town known, there are no events near them to read: what the person does about it. */
export const NO_TOWN_EVENTS =
  'Alignable didn’t show your town, so the events near you weren’t read. Check your business page’s address in Alignable; they’re read next time.';

type Person = Omit<Member, 'leader'>;
const personKey = (m: Person) =>
  (m.profile.username ?? m.profile.id ?? m.profile.url).toLowerCase();
const placeOf = (m: Person) => {
  const town = townOf(m.profile.url);
  return town ? townPlace(town) : null;
};

/** This week's events near the person, if it's due: up to 5 not read before, and who's hosting and going to each. */
export async function readEventsNear(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS whether this week’s events near you are read…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-events-next',
      input: { workspaceId: job.businessId, platform: 'alignable' },
    }),
  );
  if (!next.due)
    return {
      line: 'The events near you were read this week. They’re read again a week after the last time.',
      warned: false,
    };
  const own = await mine(job);
  if (ended(own)) return own;
  if (!own.town) return { line: NO_TOWN_EVENTS, warned: false, failed: true };
  const town = own.town;
  const where = townPlace(town);
  const someoneElse = notMine(own.business);
  let listed: EventCard[] = [];
  for (const at of EVENTS_AT) {
    if (job.stopped()) break;
    await pause(paced(PAGE_PACE_MS));
    job.progress(`Opening the events in ${where}…`);
    await job.tab.open(at(town));
    const list = await gather(
      job,
      LIST_SCREENS - 1,
      (page) => page.found.events ?? [],
      (e: EventCard) => e.url,
      (n) => `Reading the events in ${where}… ${counted(n, 'event')} so far.`,
    );
    if (ended(list)) return list;
    listed = list.items;
    if (listed.length) break;
  }
  if (!listed.length && !job.stopped())
    await job.report?.({ note: 'Alignable showed no events in their town.', outline: true });
  const before = new Set(next.read);
  const fresh = listed.filter((e) => !before.has(e.url)).slice(0, EVENTS_READ_MOST);
  const read: string[] = [];
  let shown = 0;
  let added = 0;
  for (const event of fresh) {
    if (job.stopped()) break;
    await pause(paced(PAGE_PACE_MS));
    job.progress(`Opening “${event.name}”… ${counted(read.length, 'event')} read so far.`);
    await job.tab.open(event.url);
    await pause(DRAWN_MS);
    const got = await gather(
      job,
      PEOPLE_SCREENS - 1,
      (page) => (page.found.event ? [...page.found.event.hosts, ...page.found.event.guests] : []),
      personKey,
      (n) =>
        `Reading who’s hosting and going to “${event.name}”… ${counted(n, 'business', 'businesses')} so far.`,
    );
    if (ended(got)) return got;
    read.push(event.url);
    const theirs = got.items.filter((m) => someoneElse(m.profile));
    if (!got.items.length) {
      await job.report?.({
        note: 'Alignable showed nobody hosting or going to an event.',
        outline: true,
      });
      continue;
    }
    shown += theirs.length;
    const built = findsSave(
      theirs.map((m) => ({
        name: m.name,
        profile: m.profile,
        lines: [m.business, ...m.lines].filter((l): l is string => !!l),
        place: placeOf(m),
      })),
      'event',
      'alignable',
      job.businessId,
      { words: got.page.found.event?.name ?? event.name, place: where },
    );
    if (built.ok)
      for (const input of built.input)
        added += valueOf(await job.hfos({ type: 'hfos-finds-save', input })).added;
  }
  // The week's read is done once it got through, even with nothing new; stopped before any, it's read next time.
  if (!job.stopped() || read.length)
    valueOf(
      await job.hfos({
        type: 'hfos-events-read',
        input: { workspaceId: job.businessId, platform: 'alignable', urls: read },
      }),
    );
  const stopped = job.stopped() ? 'Stopped. ' : '';
  if (!read.length)
    return {
      line: `${stopped}${listed.length ? `No new events near you in ${where}: every one listed was read before.` : `Alignable showed no events near you in ${where}.`} They’re read again next week.`,
      warned: false,
    };
  const parts = [
    `${stopped}Read ${counted(read.length, 'event')} near you in ${where}: ${counted(shown, 'business', 'businesses')} hosting or going, ${added.toLocaleString()} new to check.`,
    shown ? 'The good fits come onto Today once the AI has read their pages.' : null,
    'Nothing on an event was pressed, so you’re never signed up.',
  ];
  return { line: parts.filter(Boolean).join(' '), warned: false };
}
