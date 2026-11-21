/**
 * Events near you on Facebook (src/jobs/events.ts, src/networks/facebook/events.ts; docs/outreach.md decision 188):
 * read once a week before the followers and the day's checks, from Facebook's event search for the person's town, up
 * to 5 events coming up that weren't read before, each one's name, day, place, hosts and guests sent to HandsFreeOS.
 * Nothing is pressed. On made-up pages (test/fixtures/facebook-event-search-2026-11.html and
 * facebook-event-2026-11.html).
 */
import { EventsReadInput } from '@hfos/core/addons/outreach/events-near';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { calmCase, isWhenLine, startsAtOf } from '../src/networks/event-when';
import { readEventCards, readEventPage } from '../src/networks/facebook/events';
import { readPage } from '../src/networks/facebook/page';
import { classifyUrl, eventFromUrl } from '../src/networks/facebook/urls';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { boxEverything, load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { readFacebookEvents, eventSearch, eventSeen, NO_TOWN_FACEBOOK_EVENTS } =
  await import('../src/jobs/events');
const { DAILY_JOBS } = await import('../src/auto/plan');
const { alignableEventSeen } = await import('../src/jobs/alignable/events');

const FB = 'https://www.facebook.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const event = (n: number) => `${FB}/events/100000${n}/`;
/** The person's morning: Saturday 21 November 2026, 9 AM on their computer's clock. */
const NOW = new Date(2026, 10, 21, 9, 0);
const local = (...parts: [number, number, number, number, number]) =>
  new Date(...parts).toISOString();

const SEARCH = `${FB}/search/events/?q=${encodeURIComponent('networking Boise, ID')}`;
const searchPage = () => load('facebook-event-search-2026-11.html', SEARCH);
const eventPage = (url = event(1)) => load('facebook-event-2026-11.html', url);
/** An event's page that shows its name and nobody. */
const bareEvent = (url: string) =>
  new JSDOM(
    `<!doctype html><html><head><title>Meridian Chamber Lunch | Facebook</title></head><body><div role="main"><div><span dir="auto">Tomorrow at 12 PM</span></div><h1><span dir="auto">Meridian Chamber Lunch</span></h1><div><span dir="auto">Meridian, ID</span></div></div></body></html>`,
    { url },
  ).window.document;

describe('an event’s day as Facebook writes it', () => {
  it('knows a day’s line from any other', () => {
    for (const line of [
      'THU, DEC 4 AT 7:30 AM MST',
      'Thursday, December 4, 2026 at 7:30 AM – 9:00 AM MST',
      'Tomorrow at 12 PM',
      'Today',
      'Saturday at 10 AM',
      'Happening now',
      'Every Tuesday',
      'Dec 4 – Dec 6',
    ])
      expect(isWhenLine(line), line).toBe(true);
    for (const line of [
      'Boise Business Mixer',
      'May 2026 Business Expo',
      'Boise Centre',
      '32 interested · 5 going',
      'Saturday Market',
    ])
      expect(isWhenLine(line), line).toBe(false);
  });

  it('writes a line in capitals in everyday ones, and leaves any other as it was', () => {
    expect(calmCase('THU, DEC 4 AT 7:30 AM MST')).toBe('Thu, Dec 4 at 7:30 AM MST');
    expect(calmCase('SAT, OCT 3 FROM 6 PM TO 9 PM')).toBe('Sat, Oct 3 from 6 PM to 9 PM');
    expect(calmCase('Thursday, December 4 at 7:30 AM')).toBe('Thursday, December 4 at 7:30 AM');
  });

  it('reads when it starts, on the person’s own clock: next year’s when this year’s went by', () => {
    expect(startsAtOf('THU, DEC 4 AT 7:30 AM MST', NOW)).toBe(local(2026, 11, 4, 7, 30));
    expect(startsAtOf('Thursday, December 4, 2027 at 6 PM', NOW)).toBe(local(2027, 11, 4, 18, 0));
    expect(startsAtOf('Tomorrow at 12 PM', NOW)).toBe(local(2026, 10, 22, 12, 0));
    expect(startsAtOf('Tonight', NOW)).toBe(local(2026, 10, 21, 18, 0));
    expect(startsAtOf('Monday at 8:15 AM', NOW)).toBe(local(2026, 10, 23, 8, 15));
    // A day with no time is midday; a day gone by more than two months ago is next year's.
    expect(startsAtOf('Jan 9', NOW)).toBe(local(2027, 0, 9, 12, 0));
    expect(startsAtOf('Every Tuesday', NOW)).toBeNull();
    expect(startsAtOf(null, NOW)).toBeNull();
  });
});

describe('Facebook’s events, read (decision 188)', () => {
  it('knows an event’s page by its address, and makes its link plain', () => {
    expect(classifyUrl(event(1)).kind).toBe('event');
    expect(classifyUrl(`${FB}/events/1000001/discussion/`).kind).toBe('event');
    expect(classifyUrl(`${FB}/events/birthdays/`).kind).toBe('birthdays');
    expect(classifyUrl(`${FB}/events/`).kind).toBe('other');
    expect(eventFromUrl(new URL(`${FB}/events/1000001/1000099/?acontext=x`))).toBe(event(1));
    expect(eventFromUrl(new URL(`${FB}/events/search/?q=x`))).toBeNull();
  });

  it('lists the events a search shows, each once, with when and where its card says', () => {
    for (const doc of [searchPage(), boxEverything(searchPage())])
      expect(readEventCards(doc.body, SEARCH, NOW)).toEqual([
        {
          url: event(1),
          name: 'Boise Business Mixer',
          when: 'Thu, Dec 4 at 7:30 AM MST',
          startsAt: local(2026, 11, 4, 7, 30),
          place: 'Boise Centre',
        },
        {
          url: event(2),
          name: 'Small Business Coffee',
          when: 'Every Tuesday',
          startsAt: null,
          place: null,
        },
        {
          url: event(3),
          name: 'Meridian Chamber Lunch',
          when: 'Tomorrow at 12 PM',
          startsAt: local(2026, 10, 22, 12, 0),
          place: 'Meridian, ID',
        },
      ]);
    const read = readPage(searchPage(), SEARCH, NOW);
    expect(read.kind).toBe('search');
    expect(read.events).toHaveLength(3);
    expect(read.people).toBeUndefined();
  });

  it('reads an event’s page: its name, day, place, hosts and the guests it shows, never anyone beside them', () => {
    for (const doc of [eventPage(), boxEverything(eventPage())]) {
      const read = readEventPage(doc.querySelector('[role="main"]')!, event(1), doc.title, NOW);
      expect(read).toEqual({
        url: event(1),
        name: 'Boise Business Mixer',
        when: 'Thursday, December 4, 2026 at 7:30 AM – 9:00 AM MST',
        startsAt: local(2026, 11, 4, 7, 30),
        place: 'Boise Centre',
        hosts: [
          {
            name: 'Morgan Hale',
            profile: { id: null, username: 'boise.chamber.host', url: `${FB}/boise.chamber.host` },
          },
          {
            name: 'Boise Chamber',
            profile: { id: null, username: 'BoiseChamber', url: `${FB}/BoiseChamber` },
          },
          {
            name: 'Pat Lee',
            profile: expect.objectContaining({ id: '100008888888888' }),
          },
        ],
        guests: [
          {
            name: 'Dana Reyes',
            profile: expect.objectContaining({ username: 'dana.reyes.31' }),
          },
          {
            name: 'Milo Park',
            profile: expect.objectContaining({ id: '100007777777777' }),
          },
        ],
      });
    }
    const page = readPage(eventPage(), event(1), NOW);
    expect(page.kind).toBe('event');
    expect(page.event?.name).toBe('Boise Business Mixer');
    expect(page.notes).toEqual([]);
  });

  it('sends what HandsFreeOS takes: the page’s words, the card’s where the page said nothing', () => {
    const [card] = readEventCards(searchPage().body, SEARCH, NOW);
    const doc = eventPage();
    const page = readEventPage(doc.body, event(1), doc.title, NOW);
    const seen = eventSeen(card!, page);
    expect(
      EventsReadInput.safeParse({
        workspaceId: BUSINESS,
        platform: 'facebook',
        urls: [seen.url],
        events: [seen],
      }).success,
    ).toBe(true);
    expect(eventSeen(card!, null)).toEqual({ ...card, hosts: [], guests: [] });
  });
});

/** The tab: the search, then each event, as opened; it scrolls no further than the first screen. */
function fakeTab(pages: Record<string, () => Document> = {}) {
  const opened: string[] = [];
  const asked: string[] = [];
  const tab = {
    async open(url: string) {
      opened.push(url);
    },
    async ask(message: { readonly type: string }) {
      asked.push(message.type);
      const at = opened.at(-1)!;
      if (message.type === 'hfos-read') {
        const doc = pages[at]?.() ?? (at.includes('/search/') ? searchPage() : bareEvent(at));
        return { ok: true, result: readPage(doc, at, NOW) };
      }
      return { ok: false };
    },
  } as unknown as JobTab;
  return { tab, opened, asked };
}

function fakeHfos(next: { due: boolean; read?: string[]; searches?: string[] }) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    if (ask.type === 'hfos-events-next')
      return {
        ok: true,
        value: { due: next.due, read: next.read ?? [], searches: next.searches ?? [] },
      };
    if (ask.type === 'hfos-events-read')
      return { ok: true, value: { readAt: NOW.toISOString(), added: 2 } };
    throw new Error(`Not expected: ${ask.type}`);
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, stopped = () => false) {
  const notes: unknown[] = [];
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped,
    progress: () => {},
    warn: async () => {},
    report: async (note) => void notes.push(note),
  };
  return { job, notes };
}

const reads = (sent: HfosAsk[]) =>
  sent.flatMap((a) => (a.type === 'hfos-events-read' ? [a.input] : []));
const SEARCHES = ['networking Boise, ID', 'business Boise, ID'];

describe('events near you on Facebook, once a week (decision 188)', () => {
  it('are read once a week, before the followers and the day’s checks', () => {
    expect(DAILY_JOBS.indexOf('events')).toBe(DAILY_JOBS.indexOf('followers') - 1);
    expect(DAILY_JOBS.indexOf('followers')).toBe(DAILY_JOBS.indexOf('checks') - 1);
  });

  it('searches near them, opens the events coming up not read before and sends each, nothing pressed', async () => {
    const { tab, opened, asked } = fakeTab({ [event(1)]: () => eventPage() });
    const { hfos, sent } = fakeHfos({ due: true, read: [event(2)], searches: SEARCHES });
    const { job, notes } = jobWith(tab, hfos);
    const end = await readFacebookEvents(job, () => NOW);
    expect(sent[0]).toEqual({
      type: 'hfos-events-next',
      input: { workspaceId: BUSINESS, platform: 'facebook' },
    });
    // Both searches, as the first found fewer than five new; the coffee was read before.
    expect(opened).toEqual([
      eventSearch(SEARCHES[0]!),
      eventSearch(SEARCHES[1]!),
      event(1),
      event(3),
    ]);
    expect([...new Set(asked)].sort()).toEqual(['hfos-read', 'hfos-scroll-page']);
    const [input] = reads(sent);
    expect(input).toMatchObject({
      workspaceId: BUSINESS,
      platform: 'facebook',
      urls: [event(1), event(3)],
    });
    expect(input!.events).toEqual([
      expect.objectContaining({
        url: event(1),
        name: 'Boise Business Mixer',
        place: 'Boise Centre',
        hosts: [
          expect.objectContaining({ name: 'Morgan Hale' }),
          expect.objectContaining({ name: 'Boise Chamber' }),
          expect.objectContaining({ name: 'Pat Lee' }),
        ],
        guests: [
          expect.objectContaining({ name: 'Dana Reyes' }),
          expect.objectContaining({ name: 'Milo Park' }),
        ],
      }),
      {
        url: event(3),
        name: 'Meridian Chamber Lunch',
        when: 'Tomorrow at 12 PM',
        startsAt: local(2026, 10, 22, 12, 0),
        place: 'Meridian, ID',
        hosts: [],
        guests: [],
      },
    ]);
    expect(EventsReadInput.safeParse(input).success).toBe(true);
    // The lunch showed nobody: noted with its outline.
    expect(notes).toEqual([
      { note: 'Facebook showed nobody hosting or going to an event.', outline: true },
    ]);
    expect(end).toEqual({
      line: 'Read 2 events near you on Facebook: 5 people hosting or going, 2 new who aren’t your friends. The events are on Today so you can go in person. The AI checks the people like friends, and the good fits come onto Today for a friend request. Nothing on an event was pressed, so you’re never signed up.',
      warned: false,
    });
  });

  it('reads nothing when this week’s read is done', async () => {
    const { tab, opened } = fakeTab();
    const { hfos, sent } = fakeHfos({ due: false, searches: SEARCHES });
    const end = await readFacebookEvents(jobWith(tab, hfos).job, () => NOW);
    expect(opened).toEqual([]);
    expect(reads(sent)).toEqual([]);
    expect(end.line).toBe(
      'The events near you were read this week. They’re read again a week after the last time.',
    );
  });

  it('says how to set their town when HandsFreeOS doesn’t know it, and tries next time', async () => {
    const { tab, opened } = fakeTab();
    const { hfos, sent } = fakeHfos({ due: true, searches: [] });
    const end = await readFacebookEvents(jobWith(tab, hfos).job, () => NOW);
    expect(opened).toEqual([]);
    expect(reads(sent)).toEqual([]);
    expect(end).toEqual({ line: NO_TOWN_FACEBOOK_EVENTS, warned: false, failed: true });
  });

  it('keeps the week’s read done when every event was read before', async () => {
    const { tab, opened } = fakeTab();
    const { hfos, sent } = fakeHfos({
      due: true,
      read: [event(1), event(2), event(3)],
      searches: SEARCHES,
    });
    const end = await readFacebookEvents(jobWith(tab, hfos).job, () => NOW);
    expect(opened).toEqual(SEARCHES.map(eventSearch));
    expect(reads(sent)).toEqual([
      { workspaceId: BUSINESS, platform: 'facebook', urls: [], events: [] },
    ]);
    expect(end.line).toBe(
      'No new events near you on Facebook: every one listed was read before, or has been. They’re read again next week.',
    );
  });

  it('leaves out the events gone by', async () => {
    const { tab, opened } = fakeTab();
    const { hfos } = fakeHfos({ due: true, read: [event(2)], searches: SEARCHES.slice(0, 1) });
    // On 5 December the mixer of the 4th and the lunch of the 22nd are gone by, and the coffee was read before.
    await readFacebookEvents(jobWith(tab, hfos).job, () => new Date(2026, 11, 5, 9, 0));
    expect(opened).toEqual([eventSearch(SEARCHES[0]!)]);
  });
});

describe('Alignable’s events on Today (decision 188)', () => {
  it('sends its card’s line as when it is, else as where, and its hosts by name', () => {
    const host = {
      name: 'Jordan Fox',
      profile: { id: '42', username: 'fox-co', url: 'https://www.alignable.com/boise-id/fox-co' },
      business: 'Fox & Co',
      lines: [],
    };
    const card = {
      url: 'https://www.alignable.com/events/123',
      name: 'Spring Mixer',
      detail: 'THU, DEC 4 AT 5 PM',
    };
    expect(alignableEventSeen(card, 'Spring Mixer', [host])).toEqual({
      url: card.url,
      name: 'Spring Mixer',
      when: 'Thu, Dec 4 at 5 PM',
      startsAt: expect.any(String),
      place: null,
      hosts: [{ profile: host.profile, name: 'Jordan Fox' }],
    });
    expect(alignableEventSeen({ ...card, detail: 'Boise, ID' }, 'Spring Mixer', [])).toMatchObject({
      when: null,
      startsAt: null,
      place: 'Boise, ID',
    });
  });
});
