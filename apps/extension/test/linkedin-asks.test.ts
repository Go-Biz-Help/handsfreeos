/**
 * What the person asks of their computer on LinkedIn (src/jobs/linkedin/, src/networks/linkedin/work.ts;
 * HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 4), on hand-written pages of made-up
 * people (test/fixtures/linkedin-*.html), each read as written and again with a bare box around every element:
 *
 * - in the tab: their own profile read for the AI's check; the headline put in through Edit intro, typed only into
 *   Headline, and nothing guessed when the box isn't as expected; an invitation withdrawn from Sent invitations, by
 *   the profile on its row; a company's page read for a look-up;
 * - the jobs, with the tab and HandsFreeOS stood in for: connections and invitations saved as LinkedIn's, connections
 *   checked on LinkedIn's own count, a look-up of a profile and its company's page, chats read in LinkedIn messaging,
 *   the profile read and the headline put in, old invitations withdrawn, posts found by LinkedIn's post search, a post
 *   that waits for a later build, and a LinkedIn warning that ends any of them in LinkedIn's words.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AskTaken } from '@hfos/core/addons/outreach/asks';
import type { HfosAsk } from '../src/hfos/messages';
import type { HandOverReply, Hfos, Job, JobTab } from '../src/jobs/job';
import { readCompany } from '../src/networks/linkedin/company';
import { mainOf } from '../src/networks/linkedin/dom';
import { headlineOf, readOwnProfile, writeHeadline } from '../src/networks/linkedin/own-profile';
import { readPage } from '../src/networks/linkedin/page';
import type { ProfileRef } from '../src/networks/linkedin/types';
import { withdraw } from '../src/networks/linkedin/withdraw';
import { boxEverything, load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { runAsk } = await import('../src/asks/run');
const { LINKEDIN_POST_LATER } = await import('../src/jobs/linkedin');
const { warnedLine } = await import('../src/jobs/job');

const store = new Map<string, unknown>();
beforeAll(() =>
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
        },
      },
    },
  }),
);
afterAll(() => vi.unstubAllGlobals());
afterEach(() => vi.useRealTimers());

const LI = 'https://www.linkedin.com';
const OWN = `${LI}/in/chris-gee-12/`;
const SENT = `${LI}/mynetwork/invitation-manager/sent/`;
const RECEIVED = `${LI}/mynetwork/invitation-manager/received/`;
const CONNECTIONS = `${LI}/mynetwork/invite-connect/connections/`;
const DANA = `${LI}/in/dana-reyes-4b2a1c/`;
const COMPANY_ABOUT = `${LI}/company/acme-plumbing-atx/about/`;
const MESSAGING = `${LI}/messaging/`;
const DANA_THREAD = `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`;
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NOW = new Date('2026-10-15T12:00:00Z');

const morgan: ProfileRef = {
  id: null,
  username: 'morgan-ellis-3',
  url: `${LI}/in/morgan-ellis-3/`,
};

const asWrittenAndBoxed = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

/** Copies a box LinkedIn draws over the page (its `#modal-outlet`) from a test page into `doc`. */
function overThePage(doc: Document, fixture: string, boxed: boolean): Element {
  const from = load(fixture, doc.location.href);
  if (boxed) boxEverything(from);
  const outlet = doc.importNode(from.getElementById('modal-outlet')!, true);
  doc.body.append(outlet);
  return outlet;
}

const buttonSaying = (root: ParentNode, words: string) =>
  [...root.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === words)!;

// ------------------------------------------------------------------------------------------------- in the tab

describe('your own LinkedIn profile, read for the AI’s check', () => {
  it.each(asWrittenAndBoxed)(
    'reads the headline, About, Experience, Featured and posts, %s',
    (_, boxed) => {
      const doc = load('linkedin-own-profile-full.html', OWN);
      if (boxed) boxEverything(doc);
      expect(readOwnProfile(doc, OWN)).toEqual({
        platform: 'linkedin',
        url: 'https://www.linkedin.com/in/chris-gee-12/',
        name: 'Chris Gee',
        picture: 'A profile photo LinkedIn didn’t describe',
        cover: 'A banner image LinkedIn didn’t describe',
        bio: 'Helping home service businesses answer every lead | Founder, Gee Consulting',
        about:
          'I help plumbers, roofers and cleaners answer every call.\nBook a 15-minute call and I’ll show you where the leads go.',
        intro: [
          'Founder at Gee Consulting · 2019 - Present · 6 yrs',
          'Sales Manager at Hill Country Answering · Mar 2012 - Dec 2018 · 6 yrs 10 mos',
        ],
        featured: [
          'How a roofer answered 1,200 calls in a month',
          'Book a 15-minute call geeconsulting.example',
        ],
        posts: [
          'Missed calls are missed jobs. Here’s the one script that fixes it.',
          'Three things every plumber’s voicemail should say.',
        ],
      });
    },
  );

  it('reads the smaller profile too: no photo or banner it can tell, and nothing featured', () => {
    const url = `${LI}/in/me/`;
    expect(readOwnProfile(load('linkedin-own-profile.html', url), url)).toMatchObject({
      platform: 'linkedin',
      name: 'Chris Gee',
      picture: null,
      cover: null,
      bio: 'Helping home service businesses answer every lead | Founder, Gee Consulting',
      intro: ['Founder at Gee Consulting · 2019 - Present · 6 yrs'],
      featured: [],
      posts: [],
    });
  });
});

describe('putting the headline in', () => {
  const NEW = 'I help plumbers and roofers answer every lead | Founder, Gee Consulting';

  /**
   * The profile as LinkedIn behaves: Edit intro opens its box over the page; Save puts what's in Headline under the
   * name and closes the box (or, `stays`, leaves it open).
   */
  function editable(boxed: boolean, save: 'closes' | 'stays' = 'closes') {
    const doc = load('linkedin-own-profile-full.html', OWN);
    if (boxed) boxEverything(doc);
    const typed: string[] = [];
    doc.querySelector('[aria-label="Edit intro"]')!.addEventListener('click', (event) => {
      event.preventDefault();
      const outlet = overThePage(doc, 'linkedin-edit-intro.html', boxed);
      for (const field of outlet.querySelectorAll('input, textarea'))
        field.addEventListener('input', () => typed.push(field.id));
      buttonSaying(outlet, 'Save').addEventListener('click', () => {
        if (save === 'stays') return;
        const headline = outlet.querySelector<HTMLTextAreaElement>('#f-headline')!.value;
        doc.getElementById('headline')!.textContent = headline;
        outlet.remove();
      });
    });
    return { doc, typed };
  }

  it.each(asWrittenAndBoxed)(
    'opens Edit intro, types only into Headline, presses Save and sees it under the name, %s',
    async (_, boxed) => {
      const { doc, typed } = editable(boxed);
      expect(await writeHeadline(doc, OWN, NEW)).toBe('done');
      expect(headlineOf(doc, OWN)).toBe(NEW);
      expect(typed).toEqual(['f-headline']);
    },
  );

  it('presses nothing with no Edit intro, and says so for the person to do it', async () => {
    const doc = load('linkedin-own-profile-full.html', OWN);
    doc.querySelector('[aria-label="Edit intro"]')!.remove();
    expect(await writeHeadline(doc, OWN, NEW)).toBe('none');
  });

  it('guesses nothing when the box isn’t as expected: two Headline fields, or no Save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    for (const change of [
      (outlet: Element) =>
        outlet
          .querySelector('form')!
          .insertAdjacentHTML(
            'beforeend',
            '<label for="f-headline-2">Headline</label><input id="f-headline-2" />',
          ),
      (outlet: Element) => buttonSaying(outlet, 'Save').remove(),
    ]) {
      const doc = load('linkedin-own-profile-full.html', OWN);
      let saved = false;
      doc.querySelector('[aria-label="Edit intro"]')!.addEventListener('click', (event) => {
        event.preventDefault();
        const outlet = overThePage(doc, 'linkedin-edit-intro.html', false);
        change(outlet);
        buttonSaying(outlet, 'Save')?.addEventListener('click', () => (saved = true));
      });
      const wrote = writeHeadline(doc, OWN, NEW);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await wrote).toBe('none');
      expect(saved).toBe(false);
      // Nothing was typed: the headline in the box is as it was.
      expect(doc.querySelector<HTMLTextAreaElement>('#f-headline')!.value).toBe(
        'Helping home service businesses answer every lead | Founder, Gee Consulting',
      );
    }
  });

  it('says it wasn’t saved when the box stays open after Save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { doc } = editable(false, 'stays');
    const wrote = writeHeadline(doc, OWN, NEW);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await wrote).toBe('not_saved');
  });
});

describe('withdrawing an invitation you sent', () => {
  /** Sent invitations as LinkedIn behaves: Withdraw asks to be sure; the box's Withdraw takes the row away. */
  function sentPage(boxed: boolean, sure = true) {
    const doc = load('linkedin-invitations-sent.html', SENT);
    if (boxed) boxEverything(doc);
    const pressed: string[] = [];
    for (const button of doc.querySelectorAll('button[aria-label^="Withdraw invitation sent to"]'))
      button.addEventListener('click', () => {
        pressed.push(button.getAttribute('aria-label')!);
        if (!sure) return;
        const row = button.closest('li')!;
        const outlet = overThePage(doc, 'linkedin-withdraw-invitation.html', boxed);
        buttonSaying(outlet, 'Withdraw').addEventListener('click', () => {
          pressed.push('Withdraw, to be sure');
          row.remove();
          outlet.remove();
        });
      });
    return { doc, pressed };
  }
  const sentTo = (doc: Document) =>
    (readPage(doc, SENT, NOW).invitations ?? []).map((i) => i.profile.username);

  it.each(asWrittenAndBoxed)(
    'presses Withdraw on their row, then the box’s Withdraw, and sees the row gone, %s',
    async (_, boxed) => {
      const { doc, pressed } = sentPage(boxed);
      expect(await withdraw(doc, SENT, morgan)).toBe('done');
      expect(pressed).toEqual(['Withdraw invitation sent to Morgan Ellis', 'Withdraw, to be sure']);
      expect(sentTo(doc)).toEqual(['quinnharper']);
    },
  );

  it('finds the row by the link to their profile, never by a name alone', async () => {
    const { doc, pressed } = sentPage(false);
    // Jesse Moore's row links to nobody.
    const jesse = { id: null, username: 'jesse-moore', url: `${LI}/in/jesse-moore/` };
    expect(await withdraw(doc, SENT, jesse)).toBe('not_found');
    // By LinkedIn's id alone, when that's all both have.
    expect(
      await withdraw(doc, SENT, { id: 'ACoAAFakeSomebody9', username: null, url: `${LI}/in/x/` }),
    ).toBe('not_found');
    expect(pressed).toEqual([]);
    // Off Sent invitations, nothing at all.
    expect(await withdraw(load('linkedin-invitations.html', RECEIVED), RECEIVED, morgan)).toBe(
      'not_found',
    );
  });

  it('says so when no box asks to be sure and the row stays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { doc, pressed } = sentPage(false, false);
    const went = withdraw(doc, SENT, morgan);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await went).toBe('not_sure');
    expect(pressed).toEqual(['Withdraw invitation sent to Morgan Ellis']);
  });
});

describe('a company’s page, for a look-up', () => {
  it.each(asWrittenAndBoxed)(
    'reads its name, tagline and what its Overview says, %s',
    (_, boxed) => {
      const doc = load('linkedin-company.html', COMPANY_ABOUT);
      if (boxed) boxEverything(doc);
      expect(readCompany(mainOf(doc), COMPANY_ABOUT)).toEqual({
        name: 'Acme Plumbing',
        company: { id: 'acme-plumbing-atx', url: `${LI}/company/acme-plumbing-atx/` },
        tagline: 'Fast, honest plumbing for Austin homes',
        lines: [
          'Plumbing · Austin, Texas · 11-50 employees',
          'Family-run since 1987. We fix leaks, replace water heaters and answer emergency calls day and night.',
          'Website: https://acmeplumbing.example/',
          'Industry: Plumbing',
          'Company size: 11-50 employees',
          'Headquarters: Austin, Texas',
          'Founded: 1987',
        ],
      });
      expect(readPage(doc, COMPANY_ABOUT, NOW)).toMatchObject({ kind: 'company', notes: [] });
    },
  );
});

// ------------------------------------------------------------------------------------------------- the jobs

/**
 * A LinkedIn tab that opens made-up pages by address, each kept as it is until opened again. It starts unopened, as a
 * new WorkTab does. Scrolls answer in turn, then no more; a conversation opens as clicking it would; and the profile's
 * and the invitations' steps are done on the page, as the tab does them.
 */
function fakeTab(
  pages: (url: string) => { readonly fixture: string; readonly at?: string } | string,
  more: {
    scrolls?: Record<string, boolean[]>;
    headline?: 'done' | 'none';
    onOpen?: (doc: Document, url: string) => void;
  } = {},
) {
  let at: string | null = null;
  let doc: Document | null = null;
  let reading = '';
  const opened: string[] = [];
  const asked: string[] = [];
  let closed = 0;
  const open = (url: string) => {
    at = url;
    opened.push(url);
    const page = pages(url);
    const { fixture, at: as = url } = typeof page === 'string' ? { fixture: page } : page;
    reading = as;
    doc = load(fixture, as);
    more.onOpen?.(doc, url);
  };
  const tab = {
    async open(url: string) {
      open(url);
      return 1;
    },
    async close() {
      closed++;
    },
    async ask(message: Record<string, unknown> & { readonly type: string }) {
      asked.push(message.type);
      if (at === null || !doc) return { ok: false, error: 'The LinkedIn tab was closed.' };
      switch (message.type) {
        case 'hfos-read':
          return { ok: true, result: readPage(doc, reading, NOW, { sideOf: () => null }) };
        case 'hfos-open-chat':
          open(`${LI}/messaging/thread/${message.threadId as string}/`);
          return { ok: true };
        case 'hfos-own-profile':
          return { ok: true, read: readOwnProfile(doc, reading) };
        case 'hfos-write-bio':
          return { ok: true, result: more.headline ?? 'done' };
        case 'hfos-withdraw':
          return { ok: true, result: await withdraw(doc, reading, message.profile as ProfileRef) };
        default:
          return { ok: more.scrolls?.[message.type]?.shift() ?? false };
      }
    },
  } as unknown as JobTab;
  return { tab, opened, asked, closed: () => closed };
}

/** HandsFreeOS, answering as it would, and keeping what it was sent. */
function fakeHfos(answers: Partial<Record<HfosAsk['type'], (ask: HfosAsk) => unknown>> = {}) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    const answer = answers[ask.type];
    if (answer) return { ok: true, value: answer(ask) };
    switch (ask.type) {
      case 'hfos-collect-chats':
        return { ok: true, value: { saved: 1, waiting: 1 } };
      case 'hfos-save-friends':
        return {
          ok: true,
          value: { saved: ask.input.people.length, added: ask.input.people.length, changed: 0 },
        };
      case 'hfos-friend-end':
      case 'hfos-check-look':
      case 'hfos-profile-check':
        return { ok: true, value: {} };
      case 'hfos-save-posts':
        return {
          ok: true,
          value: { groupId: null, posts: [], checking: ask.input.posts.length },
        };
      default:
        throw new Error(`Not expected: ${ask.type}`);
    }
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, more: Partial<Job> = {}) {
  const lines: string[] = [];
  const warned: string[][] = [];
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: (line) => lines.push(line),
    warn: async (words) => void warned.push([...words]),
    ...more,
  };
  return { job, lines, warned };
}

const onLinkedIn = (task: AskTaken['task'], job: Job) => runAsk(task, job, 'linkedin');
const sentOf = <T extends HfosAsk['type']>(sent: HfosAsk[], type: T) =>
  sent.filter((a): a is Extract<HfosAsk, { type: T }> => a.type === type);

describe('saving your LinkedIn lists', () => {
  it('scrolls your connections to the end and saves them as LinkedIn’s friends list', async () => {
    const { tab, opened, asked } = fakeTab(() => 'linkedin-connections.html', {
      scrolls: { 'hfos-scroll-list': [true, false] },
    });
    const { hfos, sent } = fakeHfos();
    const end = await onLinkedIn({ kind: 'friends' }, jobWith(tab, hfos).job);
    expect(opened).toEqual([CONNECTIONS]);
    expect(asked.filter((a) => a === 'hfos-scroll-list')).toHaveLength(2);
    const [saved] = sentOf(sent, 'hfos-save-friends');
    expect(saved!.input).toMatchObject({ platform: 'linkedin', list: 'friends' });
    expect(saved!.input.people.length).toBeGreaterThan(0);
    for (const person of saved!.input.people)
      expect(person.profile.url).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
    expect(end).toMatchObject({ warned: false, whole: true });
    expect(end.line).toMatch(/^Saved \d+ connections?, \d+ new\.$/);
  });

  it('saves the invitations you’ve got, then the ones you’ve sent', async () => {
    const { tab, opened } = fakeTab((url) =>
      url === SENT ? 'linkedin-invitations-sent.html' : 'linkedin-invitations.html',
    );
    const { hfos, sent } = fakeHfos();
    const end = await onLinkedIn({ kind: 'requests' }, jobWith(tab, hfos).job);
    expect(opened).toEqual([RECEIVED, SENT]);
    const saves = sentOf(sent, 'hfos-save-friends').map((a) => a.input);
    expect(saves.map((s) => [s.platform, s.list])).toEqual([
      ['linkedin', 'requests'],
      ['linkedin', 'sent'],
    ]);
    expect(saves[1]!.people.map((p) => p.profile.username)).toEqual([
      'morgan-ellis-3',
      'quinnharper',
    ]);
    expect(end.line).toMatch(
      /^Saved \d+ invitations? you’ve got and 2 invitations you’ve sent, \d+ new\.$/,
    );
  });

  it('stops on a LinkedIn warning, in LinkedIn’s words, and notes it', async () => {
    const { tab } = fakeTab(() => ({ fixture: 'linkedin-warning.html', at: CONNECTIONS }));
    const { hfos, sent } = fakeHfos();
    const { job, warned } = jobWith(tab, hfos);
    const end = await onLinkedIn({ kind: 'friends' }, job);
    expect(end.warned).toBe(true);
    expect(warned).toHaveLength(1);
    expect(end.line).toBe(warnedLine(warned[0]!, 'LinkedIn'));
    expect(end.line).toContain('The extension stops on LinkedIn for today');
    expect(sent).toEqual([]);
  });
});

describe('checking your connections, and research', () => {
  const next = (people: { profileId: string; name: string; url: string }[]) => () => ({
    people: people.map((p) => ({ ...p, reason: 'chatted' })),
    today: 3,
    perDay: 40,
  });

  it('opens each profile, checks it’s them, and sends what it says on LinkedIn’s count', async () => {
    const { tab, opened } = fakeTab((url) =>
      url === DANA ? 'linkedin-profile.html' : { fixture: 'linkedin-profile.html', at: DANA },
    );
    const { hfos, sent } = fakeHfos({
      'hfos-checks-next': next([
        { profileId: 'p-dana', name: 'Dana Reyes', url: DANA },
        // LinkedIn showed Dana for Sam's link: someone else, so missing.
        { profileId: 'p-sam', name: 'Sam Lee', url: `${LI}/in/sam-lee-77/` },
      ]),
    });
    const end = await onLinkedIn({ kind: 'checks' }, jobWith(tab, hfos).job);
    expect(sentOf(sent, 'hfos-checks-next')[0]!.input).toMatchObject({ platform: 'linkedin' });
    expect(opened).toEqual([DANA, `${LI}/in/sam-lee-77/`]);
    const looks = sentOf(sent, 'hfos-check-look').map((a) => a.input);
    expect(looks[0]).toMatchObject({ profileId: 'p-dana', missing: false });
    expect(looks[0]!.lines).toEqual([
      'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
      'Owner at Acme Plumbing · Jan 2015 - Present · 10 yrs 10 mos',
      'Based in Austin, Texas, United States',
      'Third-generation plumber serving Austin since 2009.',
      'We fix leaks, replace water heaters and take emergency calls 24/7.',
    ]);
    expect(looks[1]).toMatchObject({ profileId: 'p-sam', lines: [], missing: true });
    expect(end.line).toBe(
      'Done. Checked 1 person for the AI. LinkedIn didn’t show 1 profile. The good fits show under Good fits on the Friends tab once it has read them.',
    );
  });

  it('researches one person on LinkedIn, and says so when the day’s profiles are used up', async () => {
    const { tab } = fakeTab(() => 'linkedin-profile.html');
    const { hfos, sent } = fakeHfos({
      'hfos-checks-next': () => ({ people: [], today: 40, perDay: 40 }),
    });
    const end = await onLinkedIn(
      { kind: 'research', profileId: 'p-dana', name: 'Dana Reyes' },
      jobWith(tab, hfos).job,
    );
    expect(sentOf(sent, 'hfos-checks-next')[0]!.input).toEqual({
      workspaceId: BUSINESS,
      most: 1,
      profileId: 'p-dana',
      platform: 'linkedin',
    });
    expect(end).toMatchObject({ result: { queued: true } });
  });
});

describe('looking someone up on LinkedIn before drafting', () => {
  it('reads their profile and their company’s page, two pages, closes the window, then drafts', async () => {
    const { tab, opened, closed } = fakeTab((url) =>
      url === COMPANY_ABOUT ? 'linkedin-company.html' : 'linkedin-profile.html',
    );
    const { hfos, sent } = fakeHfos({
      'hfos-draft': () => ({
        drafts: ['Hi Dana, saw Acme Plumbing’s been at it since 1987.'],
        kind: 'opener',
        opener: null,
        simple: false,
      }),
    });
    const end = await onLinkedIn(
      {
        kind: 'lookup',
        draft: { kind: 'opener', profileId: 'p-dana', chatId: null, postId: null },
        profileUrl: DANA,
        name: 'Dana Reyes',
      },
      jobWith(tab, hfos).job,
    );
    expect(opened).toEqual([DANA, COMPANY_ABOUT]);
    expect(closed()).toBe(1);
    const [draft] = sentOf(sent, 'hfos-draft');
    expect(draft!.input.lookup).toEqual([
      'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
      'Owner at Acme Plumbing · Jan 2015 - Present · 10 yrs 10 mos',
      'Based in Austin, Texas, United States',
      'Third-generation plumber serving Austin since 2009.',
      'We fix leaks, replace water heaters and take emergency calls 24/7.',
      'Their business page: Acme Plumbing',
      'Acme Plumbing: Fast, honest plumbing for Austin homes',
      'Acme Plumbing: Plumbing · Austin, Texas · 11-50 employees',
      'Acme Plumbing: Family-run since 1987. We fix leaks, replace water heaters and answer emergency calls day and night.',
      'Acme Plumbing: Website: https://acmeplumbing.example/',
      'Acme Plumbing: Industry: Plumbing',
      'Acme Plumbing: Company size: 11-50 employees',
      'Acme Plumbing: Headquarters: Austin, Texas',
      'Acme Plumbing: Founded: 1987',
    ]);
    expect(end).toMatchObject({
      line: 'Wrote a draft after looking Dana Reyes up on LinkedIn.',
      result: { lookedUp: true },
    });
  });

  it('drafts from what HandsFreeOS knows when there’s no LinkedIn profile to open', async () => {
    const { tab, opened } = fakeTab(() => 'linkedin-profile.html');
    const { hfos } = fakeHfos({
      'hfos-draft': () => ({ drafts: ['Hi Dana'], kind: null, opener: null, simple: true }),
    });
    const end = await onLinkedIn(
      {
        kind: 'lookup',
        draft: { kind: 'opener', profileId: 'p-dana', chatId: null, postId: null },
        profileUrl: 'https://www.facebook.com/dana.reyes',
        name: 'Dana Reyes',
      },
      jobWith(tab, hfos).job,
    );
    expect(opened).toEqual([]);
    expect(end.line).toBe(
      'Wrote a draft from what HandsFreeOS knows: LinkedIn didn’t show their profile.',
    );
  });
});

describe('reading your LinkedIn chats', () => {
  it('opens each conversation from messaging’s list and sends it as LinkedIn’s', async () => {
    const { tab, opened } = fakeTab((url) =>
      url === DANA_THREAD || url === MESSAGING
        ? 'linkedin-chat.html'
        : // LinkedIn didn't open the others: the list stays.
          { fixture: 'linkedin-chat.html', at: MESSAGING },
    );
    const { hfos, sent } = fakeHfos();
    const end = await onLinkedIn({ kind: 'chats' }, jobWith(tab, hfos).job);
    expect(opened[0]).toBe(MESSAGING);
    const collected = sentOf(sent, 'hfos-collect-chats').map((a) => a.input);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      platform: 'linkedin',
      chats: [{ name: 'Dana Reyes', thread: { id: '2-MadeUpThreadDana0001==', encrypted: false } }],
    });
    expect(end.line).toMatch(/^Done: 1 chat sent for the AI to read\./);
  });
});

describe('your own LinkedIn profile, asked from Get ready', () => {
  it('opens it, checks it’s yours, and sends it for the AI’s check as LinkedIn’s', async () => {
    const { tab, opened } = fakeTab(() => ({ fixture: 'linkedin-own-profile-full.html', at: OWN }));
    const { hfos, sent } = fakeHfos();
    const end = await onLinkedIn({ kind: 'profile_read' }, jobWith(tab, hfos).job);
    expect(opened).toEqual([`${LI}/in/me/`]);
    expect(sentOf(sent, 'hfos-profile-check')[0]!.input).toMatchObject({
      platform: 'linkedin',
      bio: 'Helping home service businesses answer every lead | Founder, Gee Consulting',
    });
    expect(end).toEqual({ line: 'Read your profile. The AI’s checked it.', warned: false });
  });

  it('won’t read someone else’s profile as yours', async () => {
    const { tab } = fakeTab(() => ({ fixture: 'linkedin-profile.html', at: DANA }));
    const { hfos, sent } = fakeHfos();
    const end = await onLinkedIn({ kind: 'profile_read' }, jobWith(tab, hfos).job);
    expect(end).toMatchObject({ failed: true });
    expect(end.line).toBe(
      'LinkedIn didn’t open your own profile. Check you’re signed in to LinkedIn in this browser, then ask again.',
    );
    expect(sent).toEqual([]);
  });

  it('puts the headline in, then reads it again for a new check', async () => {
    const { tab, asked } = fakeTab(() => ({ fixture: 'linkedin-own-profile-full.html', at: OWN }));
    const { hfos, sent } = fakeHfos();
    const end = await onLinkedIn(
      { kind: 'profile_edit', bio: 'I help roofers answer every lead' },
      jobWith(tab, hfos).job,
    );
    expect(asked).toContain('hfos-write-bio');
    expect(sentOf(sent, 'hfos-profile-check')).toHaveLength(1);
    expect(end).toEqual({
      line: 'Your headline now says “I help roofers answer every lead”.',
      warned: false,
    });
  });

  it('hands the headline to you when anything’s unexpected, and reads it again after Carry on', async () => {
    const { tab } = fakeTab(() => ({ fixture: 'linkedin-own-profile-full.html', at: OWN }), {
      headline: 'none',
    });
    const { hfos, sent } = fakeHfos();
    const handed: string[] = [];
    const { job } = jobWith(tab, hfos, {
      handOver: async (says): Promise<HandOverReply> => (handed.push(says), 'carry_on'),
    });
    const end = await onLinkedIn({ kind: 'profile_edit', bio: 'I help roofers' }, job);
    expect(handed).toEqual([
      'Put your new headline in: press the pencil by your name on your LinkedIn profile, write “I help roofers” under Headline, and press Save. Then press Carry on.',
    ]);
    expect(sentOf(sent, 'hfos-profile-check')).toHaveLength(1);
    expect(end.line).toBe('Your headline now says “I help roofers”.');
  });
});

describe('withdrawing old invitations', () => {
  const candidate = (profileId: string, name: string, username: string) => ({
    profileId,
    name,
    url: `${LI}/in/${username}/`,
    platformId: null,
    username,
    since: '2026-09-01T00:00:00.000Z',
    lastContact: null,
    intro: [],
    mutualFriends: null,
    groupName: null,
  });
  const tidy = () => ({
    cancel: [
      candidate('p-morgan', 'Morgan Ellis', 'morgan-ellis-3'),
      candidate('p-avery', 'Avery Lane', 'averylane'),
    ],
    unfriend: [],
    totals: { cancel_request: 2, unfriend: 0 },
    cancelAfterWeeks: 3,
    needsFile: false,
    limits: { cancel_request: { done: 0, most: 20 }, unfriend: { done: 0, most: 0 } },
    warning: null,
  });

  /** Sent invitations as LinkedIn behaves, on the tab's own page. */
  const behaves = (doc: Document) => {
    for (const button of doc.querySelectorAll('button[aria-label^="Withdraw invitation sent to"]'))
      button.addEventListener('click', () => {
        const row = button.closest('li')!;
        const outlet = overThePage(doc, 'linkedin-withdraw-invitation.html', false);
        buttonSaying(outlet, 'Withdraw').addEventListener('click', () => {
          row.remove();
          outlet.remove();
        });
      });
  };

  it('withdraws the ones still waiting, by their profile, and notes the ones answered already', async () => {
    const { tab, opened } = fakeTab(() => 'linkedin-invitations-sent.html', { onOpen: behaves });
    const { hfos, sent } = fakeHfos({ 'hfos-tidy': tidy });
    const end = await onLinkedIn(
      { kind: 'cancel', profileIds: ['p-morgan', 'p-avery', 'p-gone'] },
      jobWith(tab, hfos).job,
    );
    expect(opened).toEqual([SENT]);
    expect(sentOf(sent, 'hfos-tidy')[0]).toMatchObject({ platform: 'linkedin' });
    expect(sentOf(sent, 'hfos-friend-end').map((a) => a.input)).toEqual([
      expect.objectContaining({
        platform: 'linkedin',
        kind: 'cancel_request',
        name: 'Morgan Ellis',
        already: false,
      }),
      // Avery isn't on the list, read to its end: answered or withdrawn already.
      expect.objectContaining({ name: 'Avery Lane', already: true }),
    ]);
    expect(end.line).toBe(
      'Done. Invitations withdrawn: 1 person. Answered or withdrawn already: 1. No longer on the list: 1.',
    );
  });

  it('hands it to you when LinkedIn didn’t take the row away, and skips them on Skip', async () => {
    const { tab } = fakeTab(() => 'linkedin-invitations-sent.html');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { hfos, sent } = fakeHfos({ 'hfos-tidy': tidy });
    const handed: string[] = [];
    const { job } = jobWith(tab, hfos, {
      handOver: async (says): Promise<HandOverReply> => (handed.push(says), 'skip'),
    });
    const going = onLinkedIn({ kind: 'cancel', profileIds: ['p-morgan'] }, job);
    await vi.advanceTimersByTimeAsync(20_000);
    const end = await going;
    expect(handed).toEqual([
      'Couldn’t withdraw the invitation to Morgan Ellis. On Sent invitations, press Withdraw beside their name, then Withdraw in the box LinkedIn opens. Then press Carry on, or Skip.',
    ]);
    expect(sentOf(sent, 'hfos-friend-end')).toEqual([]);
    expect(end.line).toBe('Done. Invitations withdrawn: 0 people. Skipped: 1.');
  });
});

describe('finding posts with LinkedIn’s post search', () => {
  it('searches the playbooks’ words, the latest first, and sends the posts by people in no group', async () => {
    const { tab, opened } = fakeTab(() => 'linkedin-search-posts.html');
    const { hfos, sent } = fakeHfos();
    const end = await onLinkedIn(
      { kind: 'posts', groups: null, words: ['recommend a plumber', 'handyman'] },
      jobWith(tab, hfos).job,
    );
    expect(opened).toEqual([
      `${LI}/search/results/content/?keywords=recommend%20a%20plumber&sortBy=%22date_posted%22`,
      `${LI}/search/results/content/?keywords=handyman&sortBy=%22date_posted%22`,
    ]);
    const saves = sentOf(sent, 'hfos-save-posts').map((a) => a.input);
    expect(saves[0]).toMatchObject({ platform: 'linkedin', group: null, found: 'search' });
    expect(saves[0]!.posts.map((p) => p.name)).toEqual(['Jordan Blake', 'Renée Park']);
    // The same posts again for the second words: not sent twice.
    expect(saves).toHaveLength(1);
    expect(end.line).toBe(
      'Searched LinkedIn’s posts for 2 phrases: 2 posts sent for the AI to check. The good ones go on your list for today.',
    );
  });

  it('says what to add when the playbooks have no words to search with', async () => {
    const { tab, opened } = fakeTab(() => 'linkedin-search-posts.html');
    const end = await onLinkedIn(
      { kind: 'posts', groups: null, words: [] },
      jobWith(tab, fakeHfos().hfos).job,
    );
    expect(opened).toEqual([]);
    expect(end).toMatchObject({ failed: true });
    expect(end.line).toContain('On the Playbooks tab, add some under Words to search for groups');
  });
});

describe('a post on LinkedIn', () => {
  it('waits for a later build: it ends at once saying so, with nothing opened', async () => {
    const { tab, opened } = fakeTab(() => 'linkedin-feed.html');
    const end = await onLinkedIn(
      { kind: 'post', helpfulId: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' },
      jobWith(tab, fakeHfos().hfos).job,
    );
    expect(opened).toEqual([]);
    expect(end).toEqual({ line: LINKEDIN_POST_LATER, warned: false, failed: true });
  });
});
