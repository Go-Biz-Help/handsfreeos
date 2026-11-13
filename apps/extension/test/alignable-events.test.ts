/**
 * Events near the person on Alignable (decision 112, 0.104.0): an event's own address from a link to it, the events a
 * town's page lists, and an event's page read for who's hosting and who's going. From Alignable's usual markup,
 * written here by hand with made-up businesses, till the owner's next Check Alignable outlines an events page.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { readEventsNear } from '../src/jobs/alignable/events';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';
import { KITS } from '../src/networks';
import { eventCards, eventOf, eventPage, readAlignable } from '../src/networks/alignable/read';

// A person's pace between pages, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const AL = 'https://www.alignable.com';
const page = (url: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;
const at = (path: string) => eventOf(new URL(`${AL}${path}`));

describe('an event’s own address', () => {
  it('is the event’s, in a town, a group or the site’s own, whatever comes after it', () => {
    expect(at('/austin-tx/events/101-spring-mixer?ref=feed')).toBe(
      `${AL}/austin-tx/events/101-spring-mixer`,
    );
    expect(at('/austin-tx/events/101-spring-mixer/attendees')).toBe(
      `${AL}/austin-tx/events/101-spring-mixer`,
    );
    expect(at('/groups/home-pros-network/events/77')).toBe(
      `${AL}/groups/home-pros-network/events/77`,
    );
    expect(at('/events/88')).toBe(`${AL}/events/88`);
    expect(at('/biz/events/99')).toBe(`${AL}/biz/events/99`);
  });

  it('is never a page of events, a business, or another site’s', () => {
    expect(at('/austin-tx/events')).toBeNull();
    expect(at('/austin-tx/events/upcoming')).toBeNull();
    expect(at('/events/search')).toBeNull();
    expect(at('/austin-tx/acme-roofing')).toBeNull();
    expect(at('/austin-tx/acme-roofing/events/1')).toBeNull();
    expect(eventOf(new URL('https://example.com/events/1'))).toBeNull();
  });
});

describe('a town’s events', () => {
  it('lists each event once, by its heading, with the line under it, never the menu’s', () => {
    const doc = page(
      `${AL}/austin-tx/events`,
      `<nav><a href="/events/1">Featured event</a></nav><main><h1>Events in Austin, TX</h1>
        <div><h3><a href="/austin-tx/events/101-spring-mixer">Spring Business Mixer</a></h3>
          <span>Thu, Nov 6 · 5:30 PM</span><a href="/austin-tx/events/101-spring-mixer">RSVP</a></div>
        <div><a href="/austin-tx/events/102-coffee">View event</a><a href="/austin-tx/events/102-coffee">Coffee Connect</a>
          <span>Fri, Nov 7</span></div></main>`,
    );
    expect(eventCards(doc, doc.location.href)).toEqual([
      {
        url: `${AL}/austin-tx/events/101-spring-mixer`,
        name: 'Spring Business Mixer',
        detail: 'Thu, Nov 6 · 5:30 PM',
      },
      { url: `${AL}/austin-tx/events/102-coffee`, name: 'Coffee Connect', detail: 'Fri, Nov 7' },
    ]);
    expect(readAlignable(doc, doc.location.href).events).toHaveLength(2);
    // Anywhere else, no events are read.
    const town = page(`${AL}/austin-tx`, doc.body.innerHTML);
    expect(readAlignable(town, town.location.href)).not.toHaveProperty('events');
  });
});

/** A host as Alignable's part for them draws one: picture, name (its title), business, town, and a Connect. */
const hostIn = (path: string, name: string, business: string, town: string, id: string) =>
  `<div><a href="${path}?user=9${id}"><div data-testid="avatar"><img data-testid="avatar-image"></div></a>
    <a href="${path}?user=9${id}"><div><span title="${name}">${name}</span>
      <div role="status" aria-label="Premium member badge" data-testid="premium-badge"><svg role="img"></svg></div></div>
      <span>${business}</span><span>${town}</span></a>
    <a href="/biz/connection_requests/make_connection?business_id=${id}&amp;cyattr=1"><svg role="img"></svg></a></div>`;
/** Alignable's part for an event's hosts, under its one-word label (not a heading). */
const hostsPart = (...hosts: string[]) =>
  `<div data-testid="hosts"><div><div>Hosts</div><div>${hosts.join('')}</div></div></div>`;
/**
 * A group's event as Alignable drew it for the owner (the problem check of 13 Nov 2026): its details with its name,
 * the same again for a narrow screen, a few faces and a count of who's going, its host's comment on it, and the part
 * for its hosts twice, a wide screen's and a narrow one's, beside its group's card.
 */
const groupEvent = (...hosts: string[]) =>
  `<header><nav><a href="/biz/events">Events</a></nav></header>
  <div><section><div><div>
    <div data-testid="event-details"><div><img><div><h1 title="Spring Business Mixer">Spring Business Mixer</h1>
      <div role="status">Recurring</div></div></div>
      <div><div><div data-testid="avatar"><img data-testid="avatar-image" alt="Jamie Pine" title="Jamie Pine"></div></div>
        <a data-testid="registeredCount" href="/events/5521/attendees/list">5 Attending</a></div></div>
    <div><img><div><h1>Spring Business Mixer</h1><div role="status">Recurring</div></div></div></div>
    <div><div><h3 data-testid="about-the-event">About the event</h3><div data-testid="truncate-text"><p>Come meet local owners.</p></div>
      <div data-testid="discussion-comment"><div><a href="/austin-tx/cole-bakery?user=91">Morgan Cole</a>
        <div data-testid="discussion-comment-body"><p>See you all there</p></div>
        <button>Like</button><a href="/biz/connection_requests/make_connection?business_id=4410">Connect</a></div></div></div>
      <div><div data-testid="groupCard"><a data-testid="groupTitleLink" href="/groups/austin-tx">Austin, TX</a></div>
        <div>${hostsPart(...hosts)}</div></div></div></div>
    <div><div data-testid="groupCard"><a data-testid="groupTitleLink" href="/groups/austin-tx">Austin, TX</a></div>
      <div>${hostsPart(...hosts)}</div></div>
  </section></div>`;

describe('an event’s page', () => {
  it('reads its hosts from Alignable’s own part for them, drawn twice, and keeps its name (the problem check of 13 Nov 2026)', () => {
    const cole = hostIn(
      '/austin-tx/cole-bakery',
      'Morgan Cole',
      'Cole Bakery',
      'Austin, TX',
      '4410',
    );
    const doc = page(`${AL}/groups/austin-tx/events/88-spring-mixer`, groupEvent(cole));
    const read = eventPage(doc, doc.location.href);
    expect(read).toEqual({
      url: `${AL}/groups/austin-tx/events/88-spring-mixer`,
      name: 'Spring Business Mixer',
      hosts: [
        {
          name: 'Morgan Cole',
          profile: {
            id: '4410',
            username: 'austin-tx-cole-bakery',
            url: `${AL}/austin-tx/cole-bakery`,
          },
          business: 'Cole Bakery',
          lines: ['Austin, TX'],
        },
      ],
      guests: [],
    });
    // Two hosts: each once, though both copies hold both.
    const pine = hostIn(
      '/austin-tx/pine-painting',
      'Jamie Pine',
      'Pine Painting',
      'Austin, TX',
      '4411',
    );
    const two = page(`${AL}/groups/austin-tx/events/88-spring-mixer`, groupEvent(cole, pine));
    expect(eventPage(two, two.location.href)).toMatchObject({
      name: 'Spring Business Mixer',
      hosts: [
        { name: 'Morgan Cole', business: 'Cole Bakery', profile: { id: '4410' } },
        { name: 'Jamie Pine', business: 'Pine Painting', profile: { id: '4411' } },
      ],
    });
  });

  it('is no event where its address lists events instead, which a list of them reads', () => {
    const doc = page(
      `${AL}/events/networking`,
      `<section><h2>Networking Events</h2><div data-testid="results">
        <div data-testid="wide-event-tile"><a href="/groups/austin-tx/events/88-spring-mixer"><img alt="A mixer"></a>
          <a data-testid="eventTitle" href="/groups/austin-tx/events/88-spring-mixer">Spring Business Mixer</a>
          <div data-testid="date">Thu, Nov 20 · 5:30 PM</div>
          <div data-testid="hosts" title="Hosted by Cole Bakery">Hosted by <a href="/austin-tx/cole-bakery">Cole Bakery</a></div></div>
        <div data-testid="wide-event-tile"><a data-testid="eventTitle" href="/groups/dallas-tx/events/89-coffee">Coffee Connect</a>
          <div data-testid="date">Fri, Nov 21</div>
          <div data-testid="hosts" title="Hosted by Pine Painting">Hosted by <a href="/dallas-tx/pine-painting">Pine Painting</a></div></div>
      </div></section>`,
    );
    expect(eventPage(doc, doc.location.href)).toBeNull();
    expect(eventCards(doc, doc.location.href).map((e) => [e.url, e.name])).toEqual([
      [`${AL}/groups/austin-tx/events/88-spring-mixer`, 'Spring Business Mixer'],
      [`${AL}/groups/dallas-tx/events/89-coffee`, 'Coffee Connect'],
    ]);
  });

  it('reads who’s hosting and who’s going, and nobody beside it', () => {
    const doc = page(
      `${AL}/austin-tx/events/101-spring-mixer`,
      `<main><h1>Spring Business Mixer</h1><button>RSVP</button>
        <div><span>Host</span><a href="/austin-tx/cole-bakery/morgan-cole">Morgan Cole</a>
          <a href="/austin-tx/cole-bakery">Cole Bakery</a></div>
        <h2>Attendees (2)</h2>
        <div><a href="/austin-tx/pine-painting/jamie-pine">Jamie Pine</a><a href="/austin-tx/pine-painting">Pine Painting</a>
          <span>Painter</span><button>Connect</button></div>
        <div><a href="/biz/businesses/5150?user=3">Sam Vale</a><span>Vale Books</span></div>
        <h2>People you may know</h2>
        <div><a href="/austin-tx/hill-realty/hana-hill">Hana Hill</a></div></main>`,
    );
    const read = eventPage(doc, doc.location.href);
    expect(read).toMatchObject({
      url: `${AL}/austin-tx/events/101-spring-mixer`,
      name: 'Spring Business Mixer',
      hosts: [{ name: 'Morgan Cole', business: 'Cole Bakery', lines: [] }],
      guests: [
        { name: 'Jamie Pine', business: 'Pine Painting', lines: ['Painter'] },
        { name: 'Sam Vale', profile: { id: '5150' } },
      ],
    });
    expect(readAlignable(doc, doc.location.href).event?.guests).toHaveLength(2);
  });
});

describe('the week’s read of events near them', () => {
  /** Alignable in a tab: each address opens its page, which the kit reads as the tab's script does. */
  function alignableTab(pages: Record<string, () => Document>) {
    const kit = KITS.alignable;
    const opened: string[] = [];
    let doc: Document | null = null;
    const tab = {
      async open(url: string) {
        const path = new URL(url).pathname;
        const make = pages[path];
        if (!make) throw new Error(`Not expected: ${url}`);
        opened.push(path);
        doc = make();
        return 1;
      },
      async inFront<T>(work: () => Promise<T>) {
        return work();
      },
      async close() {},
      async ask(message: { readonly type: string }) {
        const at = doc!.location.href;
        if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc!, at) };
        // Nothing more to scroll to.
        return { ok: false, error: 'nothing more' };
      },
    } as unknown as JobTab;
    return { tab, opened };
  }
  function eventsJob(tab: JobTab) {
    const sent: { type: string; input: unknown }[] = [];
    const reported: ReportNote[] = [];
    const job: Job = {
      tab,
      hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
        sent.push({ type: ask.type, input: ask.input });
        if (ask.type === 'hfos-events-next') return { ok: true, value: { due: true, read: [] } };
        if (ask.type === 'hfos-finds-save') return { ok: true, value: { added: 1 } };
        return { ok: true, value: {} };
      }) as unknown as Hfos,
      businessId: 'b',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
      report: async (note?: ReportNote) => void reported.push(note!),
    };
    return { job, sent, reported };
  }
  /** Their own profile, at their business's address in their town. */
  const mine = () =>
    page(`${AL}/columbus-oh/summit-roofing?user=77`, '<main><h1>Casey Owner</h1></main>');
  /** What the town's two addresses showed the owner (6 Nov 2026): the town's group, with no events on it. */
  const townGroup = (path: string) => () =>
    page(
      `${AL}${path}`,
      `<main><h1>Columbus, OH</h1><a href="/biz/groups/columbus-oh/members">Members</a>
        <div><a href="/columbus-oh/reyes-plumbing"><span>Dana Reyes</span></a><div>Hello all</div>
          <a href="/biz/discussions/501">Comment</a></div></main>`,
    );
  const town = {
    '/biz/businesses/my_profile': mine,
    '/columbus-oh/events': townGroup('/columbus-oh/events'),
    '/groups/columbus-oh/events': townGroup('/groups/columbus-oh/events'),
  };

  it('reads Alignable’s own Events page, the menu’s, when the town’s show none (the problem check of 6 Nov 2026)', async () => {
    const { tab, opened } = alignableTab({
      ...town,
      '/biz/events': () =>
        page(
          `${AL}/biz/events`,
          `<main><h1>Events</h1><div><h3><a href="/biz/events/4401">Columbus Business Mixer</a></h3>
            <span>Tue, Nov 11 · 5:30 PM</span></div></main>`,
        ),
      '/biz/events/4401': () =>
        page(
          `${AL}/biz/events/4401`,
          `<main><h1>Columbus Business Mixer</h1>
            <div><span>Host</span><a href="/columbus-oh/cole-bakery/morgan-cole">Morgan Cole</a>
              <a href="/columbus-oh/cole-bakery">Cole Bakery</a></div></main>`,
        ),
    });
    const { job, sent, reported } = eventsJob(tab);
    const end = await readEventsNear(job);
    expect(opened).toEqual([
      '/biz/businesses/my_profile',
      '/columbus-oh/events',
      '/groups/columbus-oh/events',
      '/biz/events',
      '/biz/events/4401',
    ]);
    expect(reported).toEqual([]);
    expect(sent.find((s) => s.type === 'hfos-events-read')?.input).toMatchObject({
      urls: [`${AL}/biz/events/4401`],
    });
    expect(end.line).toContain(
      'Read 1 event near you in Columbus, OH: 1 business hosting or going',
    );
  });

  it('reads an event’s hosts as Alignable draws them, and passes over a link to a list of events (the problem check of 13 Nov 2026)', async () => {
    const { tab, opened } = alignableTab({
      ...town,
      '/biz/events': () =>
        page(
          `${AL}/biz/events`,
          `<main><h1>Events</h1><div><h3><a href="/events/networking">Networking events</a></h3><span>See all</span></div>
            <div><h3><a href="/groups/columbus-oh/events/88-spring-mixer">Spring Business Mixer</a></h3>
            <span>Thu, Nov 20 · 5:30 PM</span></div></main>`,
        ),
      '/events/networking': () =>
        page(
          `${AL}/events/networking`,
          `<section><h2>Networking Events</h2><div data-testid="results"><div data-testid="wide-event-tile">
            <a data-testid="eventTitle" href="/groups/columbus-oh/events/88-spring-mixer">Spring Business Mixer</a>
            <div data-testid="hosts">Hosted by <a href="/columbus-oh/cole-bakery">Cole Bakery</a></div></div></div></section>`,
        ),
      '/groups/columbus-oh/events/88-spring-mixer': () =>
        page(
          `${AL}/groups/columbus-oh/events/88-spring-mixer`,
          groupEvent(
            hostIn(
              '/columbus-oh/cole-bakery',
              'Morgan Cole',
              'Cole Bakery',
              'Columbus, OH',
              '4410',
            ),
          ),
        ),
    });
    const { job, sent, reported } = eventsJob(tab);
    const end = await readEventsNear(job);
    expect(opened.slice(-2)).toEqual([
      '/events/networking',
      '/groups/columbus-oh/events/88-spring-mixer',
    ]);
    expect(reported).toEqual([]);
    expect(sent.find((s) => s.type === 'hfos-events-read')?.input).toMatchObject({
      urls: [`${AL}/groups/columbus-oh/events/88-spring-mixer`, `${AL}/events/networking`],
    });
    expect(sent.find((s) => s.type === 'hfos-finds-save')?.input).toMatchObject({
      words: 'Spring Business Mixer',
    });
    expect(end.line).toContain(
      'Read 1 event near you in Columbus, OH: 1 business hosting or going',
    );
  });

  it('reports the Events page with its outline when it shows none either', async () => {
    const { tab, opened } = alignableTab({
      ...town,
      '/biz/events': () =>
        page(`${AL}/biz/events`, '<main><h1>Events</h1><p>No upcoming events</p></main>'),
    });
    const { job, reported } = eventsJob(tab);
    await readEventsNear(job);
    expect(opened.at(-1)).toBe('/biz/events');
    expect(reported).toEqual([
      { note: 'Alignable showed no events in their town.', outline: true },
    ]);
  });
});
