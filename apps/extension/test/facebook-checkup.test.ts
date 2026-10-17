/**
 * Check Facebook (src/jobs/checkup.ts, docs/outreach.md decision 77): one press reads the person's main Facebook pages,
 * one at a time with its window in front, and tries each step on the page it's for (the tries themselves are
 * test/facebook-tries.test.ts), noting each page and each step, then says what works, what doesn't, and what had
 * nothing to try on, in one line.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { DOWNLOAD_PAGE } from '../src/networks/facebook/fetch';
import { outlinePage } from '../src/networks/facebook/outline';
import { readOwnProfile } from '../src/networks/facebook/own-profile';
import { readPage } from '../src/networks/facebook/page';
import { classifyUrl } from '../src/networks/facebook/urls';
import type { StepTry, TryStep } from '../src/networks/tries';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';
import { load } from './load';

// A person's pace between pages, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const FB = 'https://www.facebook.com';
const OWN = `${FB}/casey.owner.7`;
const REQUESTS = `${FB}/friends/requests`;
const MESSENGER = `${FB}/messages/`;
const NOW = new Date('2026-10-17T12:00:00Z');

/** A page written here: the groups search with a group they aren't in, and Download your information. */
const html = (body: string) =>
  `<!doctype html><html><body><div role="main">${body}</div></body></html>`;
const PAGES_HERE: Record<string, string> = {
  groupSearch: html(
    '<div role="feed"><div role="article"><a href="/groups/plumbersofaustin/" role="link"><span>Plumbers of Austin</span></a><span>Public · 2K members</span></div></div>',
  ),
  file: html('<div role="button" aria-label="Create export"><span>Create export</span></div>'),
};

/** Facebook's pages by address, as the made-up 2026 pages draw them. */
function facebookPage(
  url: string,
  sent: boolean,
): { fixture: string; at: string } | { html: string } {
  if (url === `${FB}/me`) return { fixture: 'own-profile.html', at: OWN };
  if (url === `${FB}/`) return { fixture: 'feed-2026.html', at: url };
  if (url === REQUESTS)
    return {
      fixture: sent ? 'friend-requests-sent-2026.html' : 'friend-requests-2026.html',
      at: url,
    };
  if (url === `${FB}/me/friends`) return { fixture: 'friends-list.html', at: `${FB}/friends/list` };
  if (url === `${FB}/groups/joins/`) return { fixture: 'groups-joined.html', at: url };
  if (url.startsWith(`${FB}/search/people/`))
    return { fixture: 'group-members-2026.html', at: url };
  if (url.startsWith(`${FB}/search/groups/`)) return { html: PAGES_HERE.groupSearch! };
  if (url === `${FB}/groups/plumbersofaustin/`) return { fixture: 'group-join-2026.html', at: url };
  if (classifyUrl(url).kind === 'group') return { fixture: 'group-feed.html', at: url };
  if (classifyUrl(url).kind === 'post') return { fixture: 'group-post-2026.html', at: url };
  if (url === MESSENGER) return { fixture: 'chat-2026.html', at: url };
  if (url === `${FB}/notifications`) return { fixture: 'notifications.html', at: url };
  if (url === DOWNLOAD_PAGE) return { html: PAGES_HERE.file! };
  if (classifyUrl(url).kind === 'profile') return { fixture: 'profile-2026.html', at: url };
  throw new Error(`Not expected: ${url}`);
}

/**
 * A Facebook tab that opens the pages above by address. View sent requests shows the requests sent; each try answers
 * as planned (each of a step's tries in turn), or works.
 */
function fakeTab(tries: Partial<Record<TryStep, StepTry | StepTry[]>> = {}) {
  let doc: Document | null = null;
  let reading = '';
  let sent = false;
  const opened: string[] = [];
  const asked: string[] = [];
  const tried: (readonly [TryStep, string])[] = [];
  const order: string[] = [];
  const show = (url: string) => {
    const page = facebookPage(url, sent);
    if ('html' in page) {
      reading = url;
      doc = new JSDOM(page.html, { url }).window.document;
    } else {
      reading = page.at;
      doc = load(page.fixture, page.at);
    }
  };
  const tab = {
    async open(url: string) {
      opened.push(url);
      sent = false;
      show(url);
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      order.push('in front');
      const out = await work();
      order.push('back');
      return out;
    },
    async ask(message: Record<string, unknown> & { readonly type: string }) {
      asked.push(message.type);
      if (!doc) return { ok: false, error: 'The Facebook tab was closed.' };
      switch (message.type) {
        case 'hfos-read':
          return { ok: true, result: readPage(doc, reading, NOW) };
        case 'hfos-outline':
          return {
            ok: true,
            result: readPage(doc, reading, NOW),
            outline: outlinePage(doc, reading, { version: '0.57.0' }),
            shown: true,
          };
        case 'hfos-own-profile':
          return { ok: true, read: readOwnProfile(doc, reading, classifyUrl(reading)) };
        case 'hfos-fetch-step':
          // View sent requests, on the requests page: the ones sent show.
          sent = true;
          show(REQUESTS);
          return { ok: true, result: 'done' };
        case 'hfos-try': {
          const step = message.step as TryStep;
          tried.push([step, reading]);
          const works: StepTry = { step, tried: true, works: true, found: {}, missing: [] };
          const planned = tries[step];
          return { ok: true, tried: (Array.isArray(planned) ? planned.shift() : planned) ?? works };
        }
        default:
          return { ok: false, error: `Not expected: ${message.type}` };
      }
    },
  } as unknown as JobTab;
  return { tab, opened, asked, tried, order };
}

async function checkWith(tries: Partial<Record<TryStep, StepTry | StepTry[]>> = {}) {
  const { tab, opened, asked, tried, order } = fakeTab(tries);
  const notes: ReportNote[] = [];
  const hfos = (async () => {
    throw new Error('Check Facebook saves nothing in HandsFreeOS but its notes.');
  }) as unknown as Hfos;
  const job: Job = {
    tab,
    hfos,
    businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    report: async (note = {}) => void notes.push(note),
  };
  const end = await runAsk({ kind: 'checkup' }, job, 'facebook');
  return { end, notes, opened, asked, tried, order };
}

describe('Check Facebook', () => {
  it('reads your main pages and tries each step on its own page, with its window in front', async () => {
    const { end, notes, opened, asked, tried, order } = await checkWith();
    expect(order).toEqual(['in front', 'back']);
    // The job only reads, and presses View sent requests as Check your friend requests does; the tab tries.
    expect(new Set(asked)).toEqual(
      new Set(['hfos-read', 'hfos-own-profile', 'hfos-try', 'hfos-fetch-step']),
    );
    expect(tried.map(([step]) => step)).toEqual([
      'bio',
      'confirm',
      'post',
      'comment',
      'request',
      'join',
      'like',
      'unfriend',
      'message',
      'cancel',
      'file',
    ]);
    expect(opened.slice(0, 5)).toEqual([
      `${FB}/me`,
      `${FB}/`,
      REQUESTS,
      `${FB}/me/friends`,
      `${FB}/groups/joins/`,
    ]);
    expect(opened).toContain(`${FB}/search/people/?q=small%20business`);
    expect(opened).toContain(`${FB}/search/groups/?q=small%20business`);
    expect(opened).toContain(`${FB}/groups/plumbersofaustin/`);
    expect(opened.slice(-3)).toEqual([expect.any(String), `${FB}/notifications`, DOWNLOAD_PAGE]);
    // Each step on the kind of page it's for.
    const on = Object.fromEntries(tried.map(([step, at]) => [step, classifyUrl(at).kind]));
    expect(on).toMatchObject({
      bio: 'profile',
      post: 'group',
      comment: 'post',
      request: 'profile',
      join: 'group',
      like: 'profile',
      unfriend: 'profile',
      message: 'profile',
      cancel: 'profile',
    });
    expect(tried.find(([step]) => step === 'confirm')![1]).toBe(REQUESTS);
    expect(tried.find(([step]) => step === 'file')![1]).toBe(DOWNLOAD_PAGE);
    // Steps that work keep no outline; pages always do.
    expect(notes.filter((n) => n.job?.startsWith('checkup.')).every((n) => !n.outline)).toBe(true);
    expect(notes.filter((n) => !n.job).every((n) => n.outline)).toBe(true);
    const summary = notes.at(-1)!;
    expect(summary.job).toBe('checkup.summary');
    expect(summary.found).toMatchObject({ steps: 11, working: 11 });
    expect(end).toEqual({
      line: `Read ${summary.found!.pages as number} Facebook pages and tried 11 steps up to their last press. Everything works.`,
      warned: false,
    });
  });

  it('says which steps don’t work, and which had nothing to try on, all in one go', async () => {
    const { end, notes } = await checkWith({
      bio: {
        step: 'bio',
        tried: true,
        works: false,
        found: { button: true, box: false },
        missing: ['Edit bio opened no box to write the bio in'],
      },
      confirm: {
        step: 'confirm',
        tried: false,
        works: false,
        found: { requests: 0 },
        missing: ['no friend requests waiting for you'],
      },
    });
    expect(notes.find((n) => n.job === 'checkup.bio')).toMatchObject({
      note: 'Your bio: Edit bio opened no box to write the bio in.',
      outline: true,
    });
    expect(notes.find((n) => n.job === 'checkup.confirm')).toMatchObject({
      note: 'Confirming requests: not tried, no friend requests waiting for you.',
    });
    expect(notes.at(-1)!.found).toMatchObject({
      steps: 11,
      working: 9,
      notWorking: ['bio'],
      nothingToTry: ['confirm'],
    });
    expect(end.line).toMatch(
      /^Read \d+ Facebook pages and tried 11 steps up to their last press\. Not working: your bio\. Nothing to try on: confirming requests\.$/,
    );
  });

  it('tries a friend request on the next person from the search when the first is a friend', async () => {
    const friend: StepTry = {
      step: 'request',
      tried: false,
      works: false,
      found: {},
      missing: ['you’re friends with them already'],
    };
    const { tried, end } = await checkWith({ request: [friend] });
    expect(tried.filter(([step]) => step === 'request')).toHaveLength(2);
    expect(end.line).toContain('Everything works.');
  });
});
