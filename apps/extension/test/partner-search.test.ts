/**
 * Finding partners by search in the extension (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 4): who LinkedIn's
 * and Facebook's people and post searches show, with the lines under their names; Find partners doing today's
 * searches first and sending who each found, then reading the next people; and a LinkedIn warning (its monthly limit
 * on people searches) ending the day before anyone's read. On made-up pages.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { readPage as readFacebook } from '../src/networks/facebook/page';
import { readPage as readLinkedIn } from '../src/networks/linkedin/page';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { checkPartners } = await import('../src/jobs/partners');
const { facebookFound, followersIn, searchFacebook } = await import('../src/jobs/partner-search');
const { linkedInFound, peopleSearchUrl, searchLinkedIn } =
  await import('../src/jobs/linkedin/partner-search');
const { readThemOnLinkedIn } = await import('../src/jobs/linkedin/checks');

const FB = 'https://www.facebook.com';
const LI = 'https://www.linkedin.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('who a search shows', () => {
  it('on LinkedIn: people search’s people with their headline and place, and post search’s writers, never a company', () => {
    const peopleAt = `${LI}/search/results/people/?keywords=plumber`;
    const people = linkedInFound(
      readLinkedIn(load('linkedin-search-people.html', peopleAt), peopleAt),
      'business',
    );
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) {
      expect(p.profile.url).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
      expect(p.lines.length).toBeGreaterThan(0);
      expect(p.followers).toBeNull();
    }
    const postsAt = `${LI}/search/results/content/?keywords=plumber`;
    const page = readLinkedIn(load('linkedin-search-posts.html', postsAt), postsAt);
    const writers = linkedInFound(page, 'creator');
    expect(writers.length).toBe(
      (page.posts ?? []).filter((p) => !p.company && p.author?.profile).length,
    );
    expect(writers.length).toBeGreaterThan(0);
  });

  it('on Facebook: people search’s people with the lines under them, and post search’s writers', () => {
    const peopleAt = `${FB}/search/people/?q=realtor`;
    const people = facebookFound(
      readFacebook(load('group-members-2026.html', peopleAt), peopleAt),
      'business',
    );
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((p) => p.profile.url.startsWith(FB))).toBe(true);
    const postsAt = `${FB}/search/posts/?q=realtor`;
    const writers = facebookFound(
      readFacebook(load('feed-2026.html', postsAt), postsAt),
      'creator',
    );
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.every((w) => w.lines.length === 0)).toBe(true);
  });

  it('reads a following from the lines under someone’s name', () => {
    expect(followersIn(['Realtor in Austin', '12K followers'])).toBe(12_000);
    expect(followersIn(['Realtor in Austin'])).toBeNull();
  });

  it('pages LinkedIn’s people search by its address', () => {
    expect(peopleSearchUrl('Austin homeowners')).toBe(
      `${LI}/search/results/people/?keywords=Austin%20homeowners`,
    );
    expect(peopleSearchUrl('Austin homeowners', 2)).toBe(
      `${LI}/search/results/people/?keywords=Austin%20homeowners&page=2`,
    );
  });
});

describe('Find partners with today’s searches', () => {
  /** A window that shows the page each address is, by `pages`, and has nothing more to scroll to. */
  const tab = (opened: string[], pages: (url: string) => unknown) =>
    ({
      async open(url: string) {
        opened.push(url);
        return 1;
      },
      async loaded() {
        return 1;
      },
      async ask(message: { readonly type: string }) {
        if (message.type === 'hfos-read') return { ok: true, result: pages(opened.at(-1)!) };
        return { ok: false };
      },
    }) as unknown as JobTab;
  const hfos = (searches: unknown[], sent: HfosAsk[]) =>
    (async (ask: HfosAsk) => {
      sent.push(ask);
      if (ask.type === 'hfos-partner-searches')
        return { ok: true, value: { searches, today: 0, perDay: 2, waiting: 0 } };
      if (ask.type === 'hfos-partner-leads')
        return { ok: true, value: { kept: ask.input.people?.length ?? 0 } };
      if (ask.type === 'hfos-partners-next')
        return { ok: true, value: { people: [], today: 0, perDay: 15 } };
      if (ask.type === 'hfos-warning') return { ok: true, value: {} };
      throw new Error(`Not expected: ${ask.type}`);
    }) as unknown as Hfos;
  const jobWith = (t: JobTab, h: Hfos, warned: string[][] = []): Job => ({
    tab: t,
    hfos: h,
    businessId: BUSINESS,
    stopped: () => false,
    progress: () => undefined,
    warn: async (warnings: readonly string[]) => {
      warned.push([...warnings]);
    },
  });

  it('searches Facebook’s people and posts, sends who each found, then reads the next people', async () => {
    const opened: string[] = [];
    const sent: HfosAsk[] = [];
    const end = await checkPartners(
      jobWith(
        tab(opened, (url) =>
          url.includes('/search/people/')
            ? readFacebook(load('group-members-2026.html', url), url)
            : readFacebook(load('feed-2026.html', url), url),
        ),
        hfos(
          [
            { kind: 'business', words: 'Austin homeowners' },
            { kind: 'creator', words: 'Austin homeowners' },
          ],
          sent,
        ),
      ),
      15,
    );
    expect(opened).toEqual([
      `${FB}/search/people/?q=Austin%20homeowners`,
      `${FB}/search/posts/?q=Austin%20homeowners`,
    ]);
    const leads = sent.filter(
      (a): a is Extract<HfosAsk, { type: 'hfos-partner-leads' }> => a.type === 'hfos-partner-leads',
    );
    expect(leads.map((l) => [l.input.platform, l.input.kind, l.input.words])).toEqual([
      ['facebook', 'business', 'Austin homeowners'],
      ['facebook', 'creator', 'Austin homeowners'],
    ]);
    expect(leads[0]!.input.people?.length).toBeGreaterThan(0);
    // Then who's next, as before.
    expect(sent.at(-1)!.type).toBe('hfos-partners-next');
    const kept = leads.reduce((n, l) => n + (l.input.people?.length ?? 0), 0);
    expect(end.line).toBe(
      `Searched Facebook 2 times and found ${kept} new people who could partner. Nobody to read as a partner today. A playbook whose goal is Find partners has your computer look for them.`,
    );
  });

  it('searches LinkedIn’s people a page at a time, and stops the day on its search limit before reading anyone', async () => {
    const opened: string[] = [];
    const sent: HfosAsk[] = [];
    const warned: string[][] = [];
    const end = await checkPartners(
      jobWith(
        tab(opened, (url) =>
          readLinkedIn(
            load(
              url.includes('page=2') ? 'linkedin-search-limit.html' : 'linkedin-search-people.html',
              url,
            ),
            url,
          ),
        ),
        hfos([{ kind: 'business', words: 'Austin homeowners' }], sent),
        warned,
      ),
      15,
      { platform: 'linkedin', read: readThemOnLinkedIn, search: searchLinkedIn },
    );
    expect(opened).toEqual([
      peopleSearchUrl('Austin homeowners'),
      peopleSearchUrl('Austin homeowners', 2),
    ]);
    expect(warned).toEqual([['You’ve reached the monthly limit for profile searches']]);
    expect(end.warned).toBe(true);
    // Nothing sent for a search cut short, and nobody read.
    expect(sent.map((a) => a.type)).toEqual(['hfos-partner-searches']);
  });

  it('sends a search that found nobody, so it counts as done', async () => {
    const sent: HfosAsk[] = [];
    const empty = { kind: 'search', url: `${FB}/search/people/?q=x`, warnings: [], notes: [] };
    const found = await searchFacebook(
      jobWith(
        tab([], () => ({ ...empty, people: [], groups: [], posts: [] })),
        hfos([], sent),
      ),
      'business',
      'nobody here',
    );
    expect(found).toEqual([]);
  });
});
