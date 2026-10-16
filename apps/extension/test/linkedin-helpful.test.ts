/**
 * The helpful post on LinkedIn (src/networks/linkedin/compose.ts, src/jobs/linkedin/helpful.ts), on hand-written pages
 * of made-up people, each as written and again with a bare box around every element: put up on the person's own feed
 * through Start a post and the box's own Post, with its link from View post or the top of the feed; who commented and
 * who reacted read from one of their posts, never the person themselves; and the jobs, with LinkedIn and HandsFreeOS
 * stood in for, each call saying LinkedIn.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { readComments, readReactions, writeFeedPost } from '../src/networks/linkedin/compose';
import { readPage } from '../src/networks/linkedin/page';
import { boxEverything, load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { runAsk } = await import('../src/asks/run');
const { FEED, LINKEDIN_POST_NONE, OWN_POSTS, linkedInHelpfulDaily, readLinkedInEngaged } =
  await import('../src/jobs/linkedin/helpful');

beforeAll(() =>
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  }),
);
afterAll(() => vi.unstubAllGlobals());

const LI = 'https://www.linkedin.com';
const POST_URL = `${LI}/feed/update/urn:li:activity:7380000000000000500/`;
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const HELPFUL = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const TEXT =
  'Three things to check before you call a plumber: the shut-off valve, the water heater’s pilot, and the trap under the sink. What would you add?';
const NOW = new Date('2026-10-15T12:00:00Z');

const asWrittenAndBoxed = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

const page = (fixture: string, url: string, boxed: boolean) => {
  const doc = load(fixture, url);
  return boxed ? boxEverything(doc) : doc;
};

/** Copies the box LinkedIn draws over the page (its `#modal-outlet`) from a test page into `doc`. */
function overThePage(doc: Document, fixture: string, boxed: boolean): Element {
  const from = load(fixture, doc.location.href);
  if (boxed) boxEverything(from);
  const outlet = doc.importNode(from.getElementById('modal-outlet')!, true);
  doc.body.append(outlet);
  return outlet;
}

/**
 * The feed as LinkedIn behaves: Start a post opens the box to write in, writing turns its Post on, and Post closes the
 * box, then says View post (or, with `toast` false, only puts the post at the top of the feed when `onFeed`).
 */
function behaveOnFeed(
  doc: Document,
  boxed: boolean,
  more: { toast?: boolean; onFeed?: boolean } = {},
) {
  const typed: string[] = [];
  let into: Element | null = null;
  doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
    if (!into) return false;
    into.textContent = text ?? '';
    typed.push(text ?? '');
    doc.getElementById('share-post')?.removeAttribute('disabled');
    return true;
  };
  const start = [...doc.querySelectorAll('main button')].find(
    (b) => b.textContent?.trim() === 'Start a post',
  );
  start?.addEventListener('click', () => {
    const outlet = overThePage(doc, 'linkedin-share-box.html', boxed);
    const box = outlet.querySelector('[role="textbox"]')!;
    box.addEventListener('click', () => (into = box));
    outlet.querySelector('#share-post')!.addEventListener('click', () => {
      outlet.remove();
      if (more.toast !== false)
        doc.body.insertAdjacentHTML(
          'beforeend',
          `<div role="alert"><p>Post successful.</p><a href="${POST_URL}?utm_source=share">View post</a></div>`,
        );
      if (more.onFeed)
        doc
          .querySelector('main')!
          .insertAdjacentHTML(
            'afterbegin',
            `<div data-urn="urn:li:activity:7380000000000000500"><a href="${LI}/in/chris-gee-12"><span>Chris Gee</span></a><div><span aria-hidden="true">now • </span></div><div><span dir="ltr">${into?.textContent ?? ''}</span></div><div><button type="button" aria-label="React Like"><span>Like</span></button><button type="button" aria-label="Send in a private message"><span>Send</span></button></div></div>`,
          );
    });
  });
  return { typed };
}

/** One of the person's posts as LinkedIn behaves: its reactions count opens who reacted, and Dismiss closes it. */
function behaveOnPost(doc: Document, boxed: boolean) {
  const count = doc.querySelector('[aria-label="3 reactions"]')!;
  count.addEventListener('click', () => {
    const outlet = overThePage(doc, 'linkedin-reactions.html', boxed);
    outlet
      .querySelector('[aria-label="Dismiss"]')!
      .addEventListener('click', () => outlet.remove());
  });
}

describe('putting the helpful post up on your feed', () => {
  it.each(asWrittenAndBoxed)(
    'presses Start a post, types it in the box, presses its Post, and takes the link LinkedIn shows, %s',
    async (_, boxed) => {
      const doc = page('linkedin-feed.html', FEED, boxed);
      const { typed } = behaveOnFeed(doc, boxed);
      expect(await writeFeedPost(doc, FEED, TEXT)).toEqual({ result: 'done', url: POST_URL });
      expect(typed).toEqual([TEXT]);
      expect(doc.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it('finds the post at the top of the feed when LinkedIn shows no View post', async () => {
    const doc = page('linkedin-feed.html', FEED, false);
    behaveOnFeed(doc, false, { toast: false, onFeed: true });
    expect(await writeFeedPost(doc, FEED, TEXT)).toEqual({ result: 'done', url: POST_URL });
  });

  it('leaves a box with writing in it alone, and presses nothing', async () => {
    const doc = page('linkedin-feed.html', FEED, false);
    const { typed } = behaveOnFeed(doc, false);
    const outlet = overThePage(doc, 'linkedin-share-box.html', false);
    outlet.querySelector('[role="textbox"]')!.textContent = 'Half a thought';
    let posted = false;
    outlet.querySelector('#share-post')!.addEventListener('click', () => (posted = true));
    expect(await writeFeedPost(doc, FEED, TEXT)).toEqual({ result: 'not_sent', url: null });
    expect([typed, posted]).toEqual([[], false]);
  });

  it('says so when there’s no Start a post', async () => {
    const doc = page('linkedin-profile.html', `${LI}/in/dana-reyes-4b2a1c/`, false);
    expect(await writeFeedPost(doc, FEED, TEXT)).toEqual({ result: 'none', url: null });
  });
});

describe('who engaged with your post', () => {
  const sam = { id: null, username: 'sam-lee-77', url: `${LI}/in/sam-lee-77/` };

  it.each(asWrittenAndBoxed)(
    'reads each comment’s writer and words, never yours, %s',
    (_, boxed) => {
      const doc = page('linkedin-own-post.html', POST_URL, boxed);
      expect(readComments(doc, POST_URL)).toEqual([
        {
          name: 'Sam Lee',
          profile: sam,
          comment: 'Great list. Our shut-off valve was stuck last winter.',
        },
        {
          name: 'Avery Lane',
          profile: { id: null, username: 'averylane', url: `${LI}/in/averylane/` },
          comment: 'Saving this for later.',
        },
      ]);
    },
  );

  it.each(asWrittenAndBoxed)(
    'opens who reacted from its count, reads them but you, and closes the box, %s',
    async (_, boxed) => {
      const doc = page('linkedin-own-post.html', POST_URL, boxed);
      behaveOnPost(doc, boxed);
      expect(await readReactions(doc, POST_URL)).toEqual([
        { name: 'Sam Lee', profile: sam, comment: null },
        {
          name: 'Riley Park',
          profile: { id: null, username: 'riley-park-9', url: `${LI}/in/riley-park-9/` },
          comment: null,
        },
      ]);
      expect(doc.querySelector('[role="dialog"]')).toBeNull();
    },
  );
});

// ------------------------------------------------------------------------------------------------- the jobs

/** A LinkedIn tab that opens made-up pages by address, and does the helpful post's steps on them as the tab does. */
function fakeTab(
  pages: (url: string) => { fixture: string; at?: string },
  behave: (doc: Document, url: string) => void = () => undefined,
) {
  let doc: Document | null = null;
  let at = '';
  const opened: string[] = [];
  const tab = {
    async open(url: string) {
      opened.push(url);
      const found = pages(url);
      at = found.at ?? url;
      doc = load(found.fixture, at);
      behave(doc, url);
      return 1;
    },
    async ask(message: Record<string, unknown> & { readonly type: string }) {
      if (!doc) return { ok: false, error: 'The LinkedIn tab was closed.' };
      switch (message.type) {
        case 'hfos-read':
          return { ok: true, result: readPage(doc, at, NOW, { sideOf: () => null }) };
        case 'hfos-feed-post':
          return { ok: true, ...(await writeFeedPost(doc, at, message.text as string)) };
        case 'hfos-engaged':
          return {
            ok: true,
            comments: readComments(doc, at),
            reactions: await readReactions(doc, at),
          };
        default:
          return { ok: false, error: `Not expected: ${message.type}` };
      }
    },
  } as unknown as JobTab;
  return { tab, opened };
}

const pagesOf = (url: string) =>
  url === FEED
    ? { fixture: 'linkedin-feed.html' }
    : url === OWN_POSTS
      ? // LinkedIn takes /in/me/ to their own: their posts, the latest first.
        { fixture: 'linkedin-own-post.html', at: `${LI}/in/chris-gee-12/recent-activity/all/` }
      : { fixture: 'linkedin-own-post.html' };

/** HandsFreeOS, answering as it would, and keeping what it was sent. */
function fakeHfos(answers: Partial<Record<HfosAsk['type'], (ask: HfosAsk) => unknown>>) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    const answer = answers[ask.type];
    if (!answer) throw new Error(`Not expected: ${ask.type}`);
    return { ok: true, value: answer(ask) };
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos): Job {
  return {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
  };
}

const inputOf = (sent: HfosAsk[], type: HfosAsk['type']) =>
  (sent.find((a) => a.type === type) as { input?: unknown } | undefined)?.input;

const toPost = { helpfulId: HELPFUL, groupName: null, groupUrl: null, text: TEXT };

describe('putting up the helpful post you OK’d on LinkedIn', () => {
  it('puts it on your feed, and notes it up with its link, as LinkedIn’s', async () => {
    const { tab, opened } = fakeTab(
      pagesOf,
      (doc, url) => url === FEED && behaveOnFeed(doc, false),
    );
    const { hfos, sent } = fakeHfos({
      'hfos-helpful-next': () => ({ post: toPost, read: [] }),
      'hfos-helpful-posted': () => ({ helpfulId: HELPFUL, state: 'posted' }),
    });
    const end = await runAsk({ kind: 'post', helpfulId: HELPFUL }, jobWith(tab, hfos), 'linkedin');
    expect(end).toEqual({
      line: 'Put your helpful post up on your LinkedIn feed.',
      warned: false,
      posted: true,
    });
    expect(opened).toEqual([FEED]);
    expect(inputOf(sent, 'hfos-helpful-next')).toEqual({
      workspaceId: BUSINESS,
      platform: 'linkedin',
      helpfulId: HELPFUL,
    });
    expect(inputOf(sent, 'hfos-helpful-posted')).toEqual({
      workspaceId: BUSINESS,
      helpfulId: HELPFUL,
      posted: true,
      url: POST_URL,
      why: null,
    });
  });

  // LinkedIn is given a few seconds to show the link first.
  it(
    'finds its link among your own posts when LinkedIn doesn’t show it',
    { timeout: 15_000 },
    async () => {
      const { tab, opened } = fakeTab(
        pagesOf,
        (doc, url) => url === FEED && behaveOnFeed(doc, false, { toast: false }),
      );
      const { hfos, sent } = fakeHfos({
        'hfos-helpful-next': () => ({ post: toPost, read: [] }),
        'hfos-helpful-posted': () => ({ helpfulId: HELPFUL, state: 'posted' }),
      });
      await runAsk({ kind: 'post', helpfulId: HELPFUL }, jobWith(tab, hfos), 'linkedin');
      expect(opened).toEqual([FEED, OWN_POSTS]);
      expect(inputOf(sent, 'hfos-helpful-posted')).toMatchObject({ posted: true, url: POST_URL });
    },
  );

  it('notes why it couldn’t, when LinkedIn shows no Start a post', async () => {
    const { tab } = fakeTab(pagesOf, (doc) =>
      [...doc.querySelectorAll('main button')]
        .find((b) => b.textContent?.trim() === 'Start a post')
        ?.remove(),
    );
    const { hfos, sent } = fakeHfos({
      'hfos-helpful-next': () => ({ post: toPost, read: [] }),
      'hfos-helpful-posted': () => ({ helpfulId: HELPFUL, state: 'failed' }),
    });
    const end = await runAsk({ kind: 'post', helpfulId: HELPFUL }, jobWith(tab, hfos), 'linkedin');
    expect(end).toEqual({
      line: `Couldn’t post on your LinkedIn feed: ${LINKEDIN_POST_NONE}`,
      warned: false,
      failed: true,
    });
    expect(inputOf(sent, 'hfos-helpful-posted')).toMatchObject({
      posted: false,
      why: LINKEDIN_POST_NONE,
    });
  });

  it('opens nothing when it isn’t OK’d any more', async () => {
    const { tab, opened } = fakeTab(pagesOf);
    const { hfos } = fakeHfos({ 'hfos-helpful-next': () => ({ post: null, read: [] }) });
    const end = await runAsk({ kind: 'post', helpfulId: HELPFUL }, jobWith(tab, hfos), 'linkedin');
    expect(end.line).toBe('That helpful post isn’t OK’d any more, or it’s up already.');
    expect(opened).toEqual([]);
  });
});

describe('reading who engaged on LinkedIn', () => {
  it('finds each post up lately, reads who commented and reacted, and sends them as LinkedIn’s', async () => {
    const { tab, opened } = fakeTab(
      pagesOf,
      (doc, url) => url === POST_URL && behaveOnPost(doc, false),
    );
    const { hfos, sent } = fakeHfos({
      'hfos-helpful-next': () => ({
        post: null,
        read: [{ helpfulId: HELPFUL, groupName: null, groupUrl: null, postUrl: null, text: TEXT }],
      }),
      'hfos-helpful-engaged': () => ({ helpfulId: HELPFUL, added: 3 }),
    });
    const end = await readLinkedInEngaged(jobWith(tab, hfos));
    expect(opened).toEqual([OWN_POSTS, POST_URL]);
    expect(inputOf(sent, 'hfos-helpful-next')).toEqual({
      workspaceId: BUSINESS,
      platform: 'linkedin',
    });
    expect(inputOf(sent, 'hfos-helpful-engaged')).toMatchObject({
      helpfulId: HELPFUL,
      url: POST_URL,
      comments: [
        { name: 'Sam Lee', comment: 'Great list. Our shut-off valve was stuck last winter.' },
        { name: 'Avery Lane', comment: 'Saving this for later.' },
      ],
      reactions: [{ name: 'Sam Lee' }, { name: 'Riley Park' }],
    });
    expect(end.line).toBe(
      'Read 1 post: 3 new people engaged. They’re on your LinkedIn list for today.',
    );
  });

  it('asks for today’s LinkedIn post once a day, then reads', async () => {
    const { tab } = fakeTab(pagesOf);
    const { hfos, sent } = fakeHfos({
      'hfos-helpful-ask': () => ({ helpfulId: HELPFUL, groupName: null, fresh: true }),
      'hfos-helpful-next': () => ({ post: null, read: [] }),
    });
    const end = await linkedInHelpfulDaily(jobWith(tab, hfos));
    expect(inputOf(sent, 'hfos-helpful-ask')).toEqual({
      workspaceId: BUSINESS,
      platform: 'linkedin',
    });
    expect(end.line).toBe(
      'The AI is writing today’s helpful post for your LinkedIn feed. No helpful posts up on LinkedIn lately to read.',
    );
  });
});
