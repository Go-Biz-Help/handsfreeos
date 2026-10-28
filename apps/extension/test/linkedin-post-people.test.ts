/**
 * A good post's people on LinkedIn (docs/outreach.md, decision 92: src/networks/linkedin/compose.ts and
 * src/jobs/linkedin/post-people.ts), on hand-written pages of made-up people, in both layouts, each as written and
 * again with a bare box around every element: who commented, with what they said, the line under their name and how
 * far they are; who reacted, from the box the post's reactions count opens, read as it opens and closed again with its
 * Dismiss; never the person, the post's writer or a 1st-degree connection, and nothing else pressed ("Load more
 * comments" never). And the job, with LinkedIn and HandsFreeOS stood in for: today's good posts opened one at a time,
 * their people sent as found with the post they're the people of, a post with nobody (or one LinkedIn no longer shows)
 * still counted as read, a LinkedIn warning stopping the day, even one shown while the box was open, and a box of who
 * reacted that didn't open or read nobody noted with the page's outline, once a run; then the people found, each
 * checked by the AI from their own profile (`found_checks`).
 */
import { describe, expect, it, vi } from 'vitest';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';
import {
  postPeopleOn,
  readComments,
  readCommenters,
  readReactors,
} from '../src/networks/linkedin/compose';
import { readPage } from '../src/networks/linkedin/page';
import type { ProfileRef } from '../src/networks/linkedin/types';
import { boxEverything, load } from './load';

// A person's pace between posts is seconds; here, none.
const paused: number[] = [];
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: (ms: number) => {
    paused.push(ms);
    return Promise.resolve();
  },
}));

const { readPostPeople } = await import('../src/jobs/linkedin/post-people');
const { checkFound } = await import('../src/jobs/found-checks');
const { readThemOnLinkedIn } = await import('../src/jobs/linkedin/checks');

// Each test builds a post's page in jsdom, and a box closing is waited on: past vitest's 5 seconds on a busy runner.
vi.setConfig({ testTimeout: 30_000 });

const LI = 'https://www.linkedin.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NOW = new Date('2026-10-27T12:00:00Z');
const OLDER = `${LI}/feed/update/urn:li:activity:7380000000000000611/`;
const NEWER = `${LI}/feed/update/urn:li:activity:7380000000000000777/`;

const byName = (username: string): ProfileRef => ({
  id: null,
  username,
  url: `${LI}/in/${username}/`,
});
const DANA = byName('dana-reyes-4b2a1c');
const PRIYA = byName('priya-dalton-hvac');

/** Each layout: the post's page, the box its count opens, its writer, and its count as the page draws it. */
const LAYOUTS = [
  {
    layout: 'the older layout',
    fixture: 'linkedin-post.html',
    box: 'linkedin-reactions.html',
    url: OLDER,
    writer: DANA,
    count: (doc: Document) => doc.querySelector('[aria-label="42 reactions"]'),
  },
  {
    layout: 'the newer layout',
    fixture: 'linkedin-post-2026-10.html',
    box: 'linkedin-reactions-2026-10.html',
    url: NEWER,
    writer: PRIYA,
    count: (doc: Document) =>
      [...doc.querySelectorAll('main a')].find((a) =>
        /^55\s*reactions$/.test(a.textContent!.replace(/\s+/g, ' ').trim()),
      ) ?? null,
  },
] as const;
type Layout = (typeof LAYOUTS)[number];

const SHAPES = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

const EACH = LAYOUTS.flatMap((layout) =>
  SHAPES.map(([shape, boxed]) => [layout.layout, shape, layout, boxed] as const),
);

/**
 * How the post's page differs from its fixture: no reactions count, a box of who reacted whose rows name nobody, or
 * one that drew no row yet (`empty`: in a window hidden behind another, LinkedIn draws none, `hidden`).
 */
interface PageAs {
  readonly closes?: boolean;
  readonly count?: false;
  readonly nobody?: true;
  readonly empty?: true;
  readonly hidden?: true;
  /** The box ends with its own Show more results, which draws a screen more of these each press (decision 116). */
  readonly more?: readonly (readonly [username: string, name: string])[][];
}

/** A row of the box like Bianca Holt's, for someone else. */
function rowLike(row: Element, username: string, name: string): Element {
  const copy = row.cloneNode(true) as Element;
  copy.querySelector('a')!.setAttribute('href', `/in/${username}/`);
  const walker = copy.ownerDocument.createTreeWalker(copy, 4);
  for (let text = walker.nextNode(); text; text = walker.nextNode())
    text.textContent = text.textContent!.replaceAll('Bianca Holt', name);
  copy.querySelector('img')?.setAttribute('alt', `View ${name}’s profile`);
  return copy;
}

/**
 * The post's page as LinkedIn behaves: its reactions count opens the box of who reacted over it, and the box's
 * Dismiss closes it (unless `closes` is false). What's pressed is kept, by its label or its words.
 */
function postPage(layout: Layout, boxed: boolean, more: PageAs = {}) {
  const doc = load(layout.fixture, layout.url);
  if (boxed) boxEverything(doc);
  if (more.hidden) Object.defineProperty(doc, 'visibilityState', { value: 'hidden' });
  const pressed: string[] = [];
  doc.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element;
      const control = target.closest('button, a, [role="button"]') ?? target;
      pressed.push(
        control.getAttribute('aria-label') ?? control.textContent!.replace(/\s+/g, ' ').trim(),
      );
    },
    true,
  );
  layout.count(doc)?.addEventListener('click', (event) => {
    event.preventDefault();
    const from = load(layout.box, layout.url);
    if (boxed) boxEverything(from);
    const outlet = doc.importNode(from.getElementById('modal-outlet')!, true);
    // Its rows' links with no name in them: LinkedIn's box drawn some other way.
    if (more.nobody)
      for (const a of outlet.querySelectorAll('a[href*="/in/"]'))
        a.replaceChildren(doc.createElement('figure'));
    // Each row is the box around a link to someone.
    if (more.empty)
      for (const a of outlet.querySelectorAll('a[href*="/in/"]')) a.parentElement!.remove();
    if (more.more) {
      const row = outlet.querySelector('a[href="/in/bianca-holt-dental/"]')!.parentElement!;
      const screens = [...more.more];
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = 'Show more results';
      button.addEventListener('click', () => {
        for (const [username, name] of screens.shift() ?? [])
          button.before(rowLike(row, username, name));
        if (!screens.length) button.remove();
      });
      row.parentElement!.append(button);
    }
    doc.body.append(outlet);
    if (more.closes !== false)
      outlet
        .querySelector('[aria-label="Dismiss"]')!
        .addEventListener('click', () => outlet.remove());
  });
  if (more.count === false) layout.count(doc)!.remove();
  return { doc, pressed };
}

/** Who each layout's post shows, as read: never you, the writer or a 1st-degree connection. */
const COMMENTERS = {
  // Avery Lane's has no Like or Reply of its own, so it's no more a comment than a link's preview would be.
  'the older layout': [
    {
      name: 'Sam Lee',
      profile: byName('sam-lee-77'),
      headline: null,
      degree: null,
      said: 'Good reminder. Ours is 11 years old, booking a check now.',
    },
  ],
  'the newer layout': [
    {
      name: 'Hector Ruiz',
      profile: byName('hector-ruiz-pm'),
      headline: 'Property manager at Ruiz Rentals | 40 doors in San Marcos',
      degree: '2nd',
      said: 'Following. We need the same for our units on Hopkins Street.',
    },
    {
      name: 'Jade Moreno',
      profile: byName('jade-moreno-events'),
      headline: 'Event planner | Weddings and company parties in Central Texas',
      degree: '3rd',
      said: 'Same question for a venue after events. Following along.',
    },
  ],
} as const;

const REACTORS = {
  'the older layout': {
    count: true,
    opened: true,
    rows: 3,
    people: [
      {
        name: 'Riley Park',
        profile: byName('riley-park-9'),
        headline: 'Property manager, Austin',
        degree: '2nd',
        said: null,
      },
    ],
    closed: true,
  },
  'the newer layout': {
    count: true,
    opened: true,
    rows: 5,
    people: [
      {
        name: 'Bianca Holt',
        profile: byName('bianca-holt-dental'),
        headline: 'Office manager at Holt Family Dental | Round Rock',
        degree: '2nd',
        said: null,
      },
      {
        name: 'Marcus Webb',
        profile: byName('marcus-webb-facilities'),
        headline: 'Facilities director at Riverbend Schools',
        degree: '3rd',
        said: null,
      },
    ],
    closed: true,
  },
} as const;

describe.each(EACH)('a good post’s people in %s, %s', (name, _, layout, boxed) => {
  it('reads who commented, with what they said, never you, the writer or a 1st-degree connection', () => {
    const { doc, pressed } = postPage(layout, boxed);
    expect(readCommenters(doc, layout.url, { skip: [layout.writer] })).toEqual(COMMENTERS[name]);
    expect(pressed).toEqual([]);
  });

  it('opens who reacted from its count, reads its rows but you, the writer and 1st-degree connections, and closes it', async () => {
    const { doc, pressed } = postPage(layout, boxed);
    expect(await readReactors(doc, layout.url, { skip: [layout.writer] })).toEqual(REACTORS[name]);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
    // The count, then the box's Dismiss: nothing else.
    expect(pressed.slice(1)).toEqual(['Dismiss']);
  });

  it('leaves out the writer the page names, when the job named none, and presses no "Load more comments"', async () => {
    const { doc, pressed } = postPage(layout, boxed);
    const read = await postPeopleOn(doc, layout.url, null);
    expect(read).toEqual({ commenters: COMMENTERS[name], reactors: REACTORS[name] });
    expect(pressed).toHaveLength(2);
    expect(pressed.some((p) => /more comments/i.test(p))).toBe(false);
  });
});

describe('a good post’s people, when the page isn’t as hoped', () => {
  const newer = LAYOUTS[1];

  it('reads the writer’s reply among the comments only when nobody says to leave them out', () => {
    const { doc } = postPage(newer, false);
    expect(readComments(doc, NEWER).map((c) => c.name)).toEqual([
      'Hector Ruiz',
      'Priya Dalton',
      'Sam Lee',
      'Jade Moreno',
    ]);
    expect(readComments(doc, NEWER, { skip: [PRIYA] }).map((c) => c.name)).toEqual([
      'Hector Ruiz',
      'Sam Lee',
      'Jade Moreno',
    ]);
  });

  it('reads up to 3 screens of the box of who reacted, with its own Show more results, never a 4th (decision 116)', async () => {
    const screen = (n: number) =>
      [1, 2].map((i) => [`made-up-${n}${i}`, `Made Up Person ${n}${i}`] as const);
    const { doc, pressed } = postPage(newer, false, { more: [screen(1), screen(2), screen(3)] });
    const read = await readReactors(doc, NEWER, { skip: [PRIYA] });
    expect(read.people.map((p) => p.name)).toEqual([
      'Bianca Holt',
      'Marcus Webb',
      'Made Up Person 11',
      'Made Up Person 12',
      'Made Up Person 21',
      'Made Up Person 22',
    ]);
    expect(read).toMatchObject({ rows: 9, closed: true });
    expect(pressed.slice(1)).toEqual(['Show more results', 'Show more results', 'Dismiss']);
  });

  it('says so when the box of who reacted doesn’t close again', async () => {
    const { doc } = postPage(newer, false, { closes: false });
    const read = await readReactors(doc, NEWER, { skip: [PRIYA] });
    expect(read).toMatchObject({ opened: true, rows: 5, closed: false });
    expect(read.people.map((p) => p.name)).toEqual(['Bianca Holt', 'Marcus Webb']);
  });

  it('reads nobody from a box whose rows name nobody, and keeps its outline from while it was open', async () => {
    const { doc } = postPage(newer, false, { nobody: true });
    const read = await readReactors(doc, NEWER, { skip: [PRIYA] });
    expect(read).toMatchObject({ count: true, opened: true, rows: 0, people: [], closed: true });
    expect(read.outline).toMatch(/role="dialog"/);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes a box that drew no row, and says when its window was behind another', async () => {
    for (const hidden of [false, true] as const) {
      const { doc } = postPage(newer, false, { empty: true, ...(hidden ? { hidden } : {}) });
      const read = await readReactors(doc, NEWER, { skip: [PRIYA] });
      expect(read).toMatchObject({ count: true, opened: true, rows: 0, people: [], closed: true });
      expect(read.hidden).toBe(hidden || undefined);
      expect(read.outline).toMatch(/role="dialog"/);
      expect(doc.querySelector('[role="dialog"]')).toBeNull();
    }
  });

  it('never takes something else over the page for the box, nor closes it', async () => {
    const { doc } = postPage(newer, false);
    // Its count opens a box LinkedIn put up for something else: one with only a heading and a Dismiss.
    const shown = newer.count(doc)!;
    const count = shown.cloneNode(true) as Element;
    shown.replaceWith(count);
    count.addEventListener('click', (event) => {
      event.preventDefault();
      doc.body.insertAdjacentHTML(
        'beforeend',
        '<div role="dialog"><h2>Let’s do a quick check</h2><button type="button" aria-label="Dismiss"></button></div>',
      );
    });
    const read = await readReactors(doc, NEWER, { skip: [PRIYA] });
    expect(read).toMatchObject({ count: true, opened: false, rows: 0 });
    expect(doc.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('reads nobody, and opens nothing, when the post shows no reactions count', async () => {
    const { doc, pressed } = postPage(newer, false);
    newer.count(doc)!.remove();
    expect(await readReactors(doc, NEWER)).toEqual({
      count: false,
      opened: false,
      rows: 0,
      people: [],
      closed: true,
    });
    expect(pressed).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------- the job

const POST_ID = (n: number) => `5e6f7081-92a3-44b5-86c7-d8e9f0a1b2c${n}`;
const good = (n: number, url: string, name: string, profileUrl: string) => ({
  postId: POST_ID(n),
  url,
  name,
  profileUrl,
  words: 'cleaning crew recommendations',
  strong: n === 1,
  comments: 12,
  reactions: 55,
});
const GONE = `${LI}/feed/update/urn:li:activity:7380000000000000999/`;

/** LinkedIn's tab: each address opens a made-up page, and the tab answers the job's asks on it as it would. */
function fakeTab(
  pages: Record<string, ({ layout: Layout } & PageAs) | { fixture: string; at?: string }>,
) {
  let doc: Document | null = null;
  let at = '';
  const opened: string[] = [];
  const asked: string[] = [];
  const tab = {
    async open(url: string) {
      opened.push(url);
      const page = pages[url];
      if (!page) throw new Error(`Not expected: ${url}`);
      if ('layout' in page) {
        doc = postPage(page.layout, false, page).doc;
        at = page.layout.url;
      } else {
        at = page.at ?? url;
        doc = load(page.fixture, at);
      }
      return 1;
    },
    async ask(message: Record<string, unknown> & { readonly type: string }) {
      asked.push(message.type);
      if (!doc) return { ok: false, error: 'The LinkedIn tab was closed.' };
      switch (message.type) {
        case 'hfos-read':
          return { ok: true, result: readPage(doc, at, NOW, { sideOf: () => null }) };
        case 'hfos-post-people':
          return {
            ok: true,
            ...(await postPeopleOn(doc, at, message.writer as ProfileRef | null)),
          };
        default:
          return { ok: false, error: `Not expected: ${message.type}` };
      }
    },
  } as unknown as JobTab;
  return { tab, opened, asked, page: () => doc! };
}

/** HandsFreeOS: today's good posts, and each save, answering how many were new (or that the post's gone). */
function fakeHfos(
  next: { posts: ReturnType<typeof good>[]; today?: number; perDay?: number },
  gone: readonly string[] = [],
) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    if (ask.type === 'hfos-posts-people-next')
      return { ok: true, value: { today: 0, perDay: 5, ...next } };
    if (ask.type === 'hfos-finds-save') {
      if (gone.includes(ask.input.postId ?? ''))
        return {
          ok: false,
          problem: {
            message: 'That post isn’t kept any more.',
            rule: 'outreach_find_post',
            status: 404,
          },
        };
      return { ok: true, value: { added: ask.input.people?.length ?? 0, skipped: 0 } };
    }
    throw new Error(`Not expected: ${ask.type}`);
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, warned: unknown[] = [], notes?: ReportNote[]): Job {
  return {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: () => undefined,
    warn: async (warnings: unknown) => void warned.push(warnings),
    ...(notes ? { report: async (note: ReportNote = {}) => void notes.push(note) } : {}),
  };
}

const saves = (sent: HfosAsk[]) =>
  sent
    .filter((a): a is Extract<HfosAsk, { type: 'hfos-finds-save' }> => a.type === 'hfos-finds-save')
    .map((a) => a.input);

describe('reading today’s good posts’ people on LinkedIn', () => {
  it('reads each post’s people on its own page and sends them as found with the post, commenters then who reacted', async () => {
    paused.length = 0;
    const { tab, opened, asked } = fakeTab({
      [OLDER]: { layout: LAYOUTS[0] },
      [NEWER]: { layout: LAYOUTS[1] },
    });
    const { hfos, sent } = fakeHfos({
      posts: [
        good(1, NEWER, 'Priya Dalton', PRIYA.url),
        good(2, `${OLDER}?utm_source=share`, 'Dana Reyes', DANA.url),
      ],
    });
    const end = await readPostPeople(jobWith(tab, hfos));
    expect(sent[0]).toEqual({
      type: 'hfos-posts-people-next',
      input: { workspaceId: BUSINESS, platform: 'linkedin' },
    });
    // Each post at its own address, without what was added to it.
    expect(opened).toEqual([NEWER, OLDER]);
    expect(asked.filter((a) => a === 'hfos-post-people')).toHaveLength(2);
    expect(saves(sent)).toEqual([
      {
        workspaceId: BUSINESS,
        platform: 'linkedin',
        how: 'commented',
        postId: POST_ID(1),
        group: null,
        words: null,
        place: null,
        people: [
          {
            name: 'Hector Ruiz',
            profile: { id: null, username: 'hector-ruiz-pm', url: `${LI}/in/hector-ruiz-pm/` },
            lines: ['Property manager at Ruiz Rentals | 40 doors in San Marcos'],
            said: 'Following. We need the same for our units on Hopkins Street.',
            place: null,
          },
          {
            name: 'Jade Moreno',
            profile: {
              id: null,
              username: 'jade-moreno-events',
              url: `${LI}/in/jade-moreno-events/`,
            },
            lines: ['Event planner | Weddings and company parties in Central Texas'],
            said: 'Same question for a venue after events. Following along.',
            place: null,
          },
        ],
      },
      expect.objectContaining({
        how: 'liked',
        postId: POST_ID(1),
        people: [
          expect.objectContaining({
            name: 'Bianca Holt',
            lines: ['Office manager at Holt Family Dental | Round Rock'],
            said: null,
          }),
          expect.objectContaining({
            name: 'Marcus Webb',
            lines: ['Facilities director at Riverbend Schools'],
            said: null,
          }),
        ],
      }),
      expect.objectContaining({
        how: 'commented',
        postId: POST_ID(2),
        people: [expect.objectContaining({ name: 'Sam Lee', lines: [] })],
      }),
      expect.objectContaining({
        how: 'liked',
        postId: POST_ID(2),
        people: [expect.objectContaining({ name: 'Riley Park' })],
      }),
    ]);
    // A person's pace between posts, none after the last.
    expect(paused).toHaveLength(1);
    expect(paused[0]).toBeGreaterThanOrEqual(15_000);
    expect(paused[0]).toBeLessThanOrEqual(30_000);
    expect(end).toEqual({
      line: 'Done. Read who reacted to and commented on 2 good posts: 6 new people for the AI to check.',
      warned: false,
    });
  });

  it('counts a post with nobody new, or one LinkedIn no longer shows, as read, and skips one HandsFreeOS no longer keeps', async () => {
    const { tab, asked } = fakeTab({
      [NEWER]: { layout: LAYOUTS[1] },
      // LinkedIn took the post away: its address shows the feed.
      [GONE]: { fixture: 'linkedin-feed.html', at: `${LI}/feed/` },
    });
    const { hfos, sent } = fakeHfos(
      {
        posts: [
          good(1, GONE, 'Noel Brandt', `${LI}/in/noel-brandt-7/`),
          good(2, NEWER, 'Priya Dalton', PRIYA.url),
        ],
      },
      [POST_ID(2)],
    );
    const end = await readPostPeople(jobWith(tab, hfos));
    // The post LinkedIn didn't show: never asked of, and one save of nobody, so it counts as read.
    expect(asked.filter((a) => a === 'hfos-post-people')).toHaveLength(1);
    expect(saves(sent)).toEqual([
      expect.objectContaining({ how: 'liked', postId: POST_ID(1), people: [] }),
      // HandsFreeOS no longer keeps the second: its commenters refused, and nothing more sent for it.
      expect.objectContaining({ how: 'commented', postId: POST_ID(2) }),
    ]);
    expect(end).toEqual({
      line: 'Done. Read who reacted to and commented on 0 good posts: 0 new people for the AI to check. LinkedIn didn’t show 1 post.',
      warned: false,
    });
  });

  it('says why there’s nothing to read: today’s posts all read, or none waiting', async () => {
    const { tab, opened } = fakeTab({});
    const done = await readPostPeople(
      jobWith(tab, fakeHfos({ posts: [], today: 5, perDay: 5 }).hfos),
    );
    expect(done.line).toBe('That’s today’s 5 good posts on LinkedIn. It carries on tomorrow.');
    const none = await readPostPeople(
      jobWith(tab, fakeHfos({ posts: [], today: 0, perDay: 5 }).hfos),
    );
    expect(none.line).toMatch(/^No good post on LinkedIn waits for its people to be read/);
    expect(opened).toEqual([]);
  });

  it('stops for the day on a LinkedIn warning, sending nothing from the post it showed on', async () => {
    const WARNED = `${LI}/feed/update/urn:li:activity:7380000000000000888/`;
    const { tab, opened } = fakeTab({
      [OLDER]: { layout: LAYOUTS[0] },
      [WARNED]: { fixture: 'linkedin-warning.html', at: WARNED },
      [NEWER]: { layout: LAYOUTS[1] },
    });
    const { hfos, sent } = fakeHfos({
      posts: [
        good(1, OLDER, 'Dana Reyes', DANA.url),
        good(2, WARNED, 'Noel Brandt', `${LI}/in/noel-brandt-7/`),
        good(3, NEWER, 'Priya Dalton', PRIYA.url),
      ],
    });
    const warned: unknown[] = [];
    const end = await readPostPeople(jobWith(tab, hfos, warned));
    expect(opened).toEqual([OLDER, WARNED]);
    expect(warned).toHaveLength(1);
    expect(saves(sent).map((s) => s.postId)).toEqual([POST_ID(1), POST_ID(1)]);
    expect(end.warned).toBe(true);
    expect(end.line).toMatch(
      /Read who reacted to and commented on 1 good post: 2 new people for the AI to check\.$/,
    );
  });

  it('stops for the day on a warning LinkedIn showed while the box of who reacted was open', async () => {
    const { tab, page } = fakeTab({ [NEWER]: { layout: LAYOUTS[1] } });
    const { hfos, sent } = fakeHfos({ posts: [good(1, NEWER, 'Priya Dalton', PRIYA.url)] });
    const job = jobWith(tab, hfos);
    // The box opened, and LinkedIn put a warning over the page as it closed.
    const ask = tab.ask.bind(tab);
    tab.ask = (async (message: { type: string }) => {
      const answer = await ask(message as never);
      if (message.type === 'hfos-post-people') {
        const warning = load('linkedin-warning.html', NEWER).querySelector('[role="dialog"]')!;
        page().body.append(page().importNode(warning, true));
      }
      return answer;
    }) as never;
    const end = await readPostPeople(job);
    expect(end.warned).toBe(true);
    expect(saves(sent)).toEqual([]);
  });
});

describe('noting what a good post’s page didn’t show on LinkedIn (decision 74)', () => {
  it('notes once a run, with the page’s outline, a reactions count that opened no box, and goes on', async () => {
    const { tab } = fakeTab({ [OLDER]: { layout: LAYOUTS[0] }, [NEWER]: { layout: LAYOUTS[1] } });
    // LinkedIn's box drawn some other way: neither post's count opens one the reader knows.
    const ask = tab.ask.bind(tab);
    tab.ask = (async (message: { type: string }) => {
      const answer = await ask(message as never);
      return message.type === 'hfos-post-people'
        ? {
            ...answer,
            reactors: { count: true, opened: false, rows: 0, people: [], closed: true },
          }
        : answer;
    }) as never;
    const { hfos, sent } = fakeHfos({
      posts: [good(1, NEWER, 'Priya Dalton', PRIYA.url), good(2, OLDER, 'Dana Reyes', DANA.url)],
    });
    const notes: ReportNote[] = [];
    const end = await readPostPeople(jobWith(tab, hfos, [], notes));
    expect(notes).toEqual([
      {
        job: 'post_people.reactors',
        note: 'The post’s reactions count opened no box of who reacted.',
        found: { count: true, box: false },
        outline: true,
      },
    ]);
    // Each post's commenters still go, and both count as read.
    expect(saves(sent).map((s) => [s.how, s.postId])).toEqual([
      ['commented', POST_ID(1)],
      ['commented', POST_ID(2)],
    ]);
    expect(end.line).toBe(
      'Done. Read who reacted to and commented on 2 good posts: 3 new people for the AI to check.',
    );
  });

  it('notes a box that read nobody with its own outline, taken while it was open', async () => {
    const { tab, page } = fakeTab({ [NEWER]: { layout: LAYOUTS[1], nobody: true } });
    const { hfos, sent } = fakeHfos({ posts: [good(1, NEWER, 'Priya Dalton', PRIYA.url)] });
    const notes: ReportNote[] = [];
    await readPostPeople(jobWith(tab, hfos, [], notes));
    expect(notes).toEqual([
      {
        job: 'post_people.reactors',
        note: 'Nobody read in the box of who reacted.',
        found: { count: true, box: true, rows: 0 },
        outline: true,
        outlineText: expect.stringMatching(/role="dialog"/),
      },
    ]);
    // Closed again by its Dismiss, and its commenters sent.
    expect(page().querySelector('[role="dialog"]')).toBeNull();
    expect(saves(sent).map((s) => s.how)).toEqual(['commented']);
  });

  it('reads each post with its window in front, and says when the box drew nobody behind another window', async () => {
    const { tab } = fakeTab({ [NEWER]: { layout: LAYOUTS[1], empty: true, hidden: true } });
    const seen: string[] = [];
    const open = tab.open.bind(tab);
    tab.open = async (url: string) => (seen.push('open'), open(url));
    tab.inFront = async <T>(work: () => Promise<T>) => {
      seen.push('front');
      try {
        return await work();
      } finally {
        seen.push('back');
      }
    };
    const { hfos, sent } = fakeHfos({ posts: [good(1, NEWER, 'Priya Dalton', PRIYA.url)] });
    const notes: ReportNote[] = [];
    await readPostPeople(jobWith(tab, hfos, [], notes));
    expect(seen).toEqual(['front', 'open', 'back']);
    expect(notes).toEqual([
      {
        job: 'post_people.reactors',
        note: 'Nobody read in the box of who reacted: its window was behind another, and LinkedIn draws its rows only on screen.',
        found: { count: true, box: true, rows: 0, shown: false },
        outline: true,
        outlineText: expect.stringMatching(/role="dialog"/),
      },
    ]);
    expect(saves(sent).map((s) => s.how)).toEqual(['commented']);
  });

  it('notes a post with no reactions count only when HandsFreeOS saw reactions on it', async () => {
    const run = async (reactions: number) => {
      const { tab } = fakeTab({ [NEWER]: { layout: LAYOUTS[1], count: false } });
      const { hfos } = fakeHfos({
        posts: [{ ...good(1, NEWER, 'Priya Dalton', PRIYA.url), reactions }],
      });
      const notes: ReportNote[] = [];
      await readPostPeople(jobWith(tab, hfos, [], notes));
      return notes;
    };
    expect(await run(0)).toEqual([]);
    expect(await run(55)).toEqual([
      {
        job: 'post_people.count',
        note: 'No reactions count on the post to open who reacted.',
        found: { count: false },
        outline: true,
      },
    ]);
  });

  it('notes a post’s own page with no post it could read, and goes on to the next', async () => {
    const ODD = `${LI}/feed/update/urn:li:activity:7380000000000000555/`;
    const { tab, asked } = fakeTab({
      // Its own address, drawn some other way: no post the reader knows.
      [ODD]: { fixture: 'linkedin-profile.html' },
      [NEWER]: { layout: LAYOUTS[1] },
    });
    const { hfos } = fakeHfos({
      posts: [
        good(1, ODD, 'Noel Brandt', `${LI}/in/noel-brandt-7/`),
        good(2, NEWER, 'Priya Dalton', PRIYA.url),
      ],
    });
    const notes: ReportNote[] = [];
    const end = await readPostPeople(jobWith(tab, hfos, [], notes));
    expect(notes).toEqual([
      {
        job: 'post_people.post',
        note: 'Couldn’t read the post.',
        found: { post: 0 },
        outline: true,
      },
    ]);
    expect(asked.filter((a) => a === 'hfos-post-people')).toHaveLength(1);
    expect(end.line).toMatch(/LinkedIn didn’t show 1 post\.$/);
  });

  it('notes nothing when each post’s people are read', async () => {
    const { tab } = fakeTab({ [OLDER]: { layout: LAYOUTS[0] }, [NEWER]: { layout: LAYOUTS[1] } });
    const { hfos } = fakeHfos({
      posts: [good(1, NEWER, 'Priya Dalton', PRIYA.url), good(2, OLDER, 'Dana Reyes', DANA.url)],
    });
    const notes: ReportNote[] = [];
    await readPostPeople(jobWith(tab, hfos, [], notes));
    expect(notes).toEqual([]);
  });
});

describe('checking the people found on LinkedIn', () => {
  it('reads each one’s own profile for the AI’s found check, and says who LinkedIn didn’t show', async () => {
    const MORGAN = `${LI}/in/morgan-ellis-3/`;
    const { tab, opened } = fakeTab({
      [DANA.url]: { fixture: 'linkedin-profile.html' },
      // Gone from LinkedIn: its address shows the feed.
      [MORGAN]: { fixture: 'linkedin-feed.html', at: `${LI}/feed/` },
    });
    const found = (n: number, name: string, url: string) => ({
      profileId: `0d1e2f30-4152-4637-8849-5a6b7c8d9e0${n}`,
      name,
      url,
      how: 'commented' as const,
      words: 'cleaning crew recommendations',
      postUrl: NEWER,
    });
    const sent: HfosAsk[] = [];
    const hfos = (async (ask: HfosAsk) => {
      sent.push(ask);
      if (ask.type === 'hfos-finds-next')
        return {
          ok: true,
          value: {
            people: [found(1, 'Dana Reyes', DANA.url), found(2, 'Morgan Ellis', MORGAN)],
            today: 0,
            perDay: 30,
          },
        };
      if (ask.type === 'hfos-check-look')
        return { ok: true, value: { profileId: ask.input.profileId, fit: 'waiting' } };
      throw new Error(`Not expected: ${ask.type}`);
    }) as unknown as Hfos;
    const end = await checkFound(jobWith(tab, hfos), {
      platform: 'linkedin',
      read: readThemOnLinkedIn,
    });
    expect(opened).toEqual([DANA.url, MORGAN]);
    const looks = sent
      .filter(
        (a): a is Extract<HfosAsk, { type: 'hfos-check-look' }> => a.type === 'hfos-check-look',
      )
      .map((a) => a.input);
    expect(looks).toEqual([
      expect.objectContaining({ profileId: found(1, '', '').profileId, missing: false }),
      { workspaceId: BUSINESS, profileId: found(2, '', '').profileId, lines: [], missing: true },
    ]);
    expect(looks[0]!.lines?.length).toBeGreaterThan(0);
    expect(end.line).toMatch(/LinkedIn didn’t show 1 profile\./);
  });
});
