/**
 * Birthdays and new jobs, once a day (docs/outreach.md decision 108, from 0.100.0): Facebook's Birthdays page read for
 * whose birthday it is today, and LinkedIn's Catch up for its birthdays and new jobs, then handed to HandsFreeOS, which
 * keeps those among the people already kept. Nothing is pressed or written; a warning stops it.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { OCCASION_WORDS } from '@hfos/core/addons/outreach/occasions';
import { LINKEDIN_DAILY } from '../src/auto/linkedin';
import { DAILY_JOBS } from '../src/auto/plan';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import {
  BIRTHDAYS_PAGE,
  birthdaysOn,
  CATCH_UP_PAGE,
  facebookOccasions,
  linkedInOccasions,
} from '../src/jobs/occasions';
import { readBirthdays, TODAY_SECTION } from '../src/networks/facebook/birthdays';
import { readPage as readFacebook } from '../src/networks/facebook/page';
import { classifyUrl as facebookKind } from '../src/networks/facebook/urls';
import { readPage as readLinkedIn } from '../src/networks/linkedin/page';
import { classifyUrl as linkedInKind } from '../src/networks/linkedin/urls';
import { load } from './load';

// A person's pace between screens, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const NOW = new Date('2026-10-28T12:00:00Z');
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const facebookRead = (doc = load('birthdays-2026-10.html', BIRTHDAYS_PAGE)) =>
  readFacebook(doc, BIRTHDAYS_PAGE, NOW);
const linkedInRead = () =>
  readLinkedIn(load('linkedin-catch-up-2026-10.html', CATCH_UP_PAGE), CATCH_UP_PAGE, NOW, {
    sideOf: () => null,
  });

/** A job whose tab shows `read` for every page it opens, and whose HandsFreeOS keeps what it's handed. */
function jobWith(read: () => unknown, warnings: string[] = []) {
  const opened: string[] = [];
  const saved: unknown[] = [];
  const warned: string[][] = [];
  const tab = {
    open: async (url: string) => void opened.push(url),
    ask: async (message: { type: string }) => {
      if (message.type === 'hfos-read')
        return { ok: true, result: { ...(read() as object), warnings } };
      if (message.type === 'hfos-scroll-list') return { ok: false, error: 'At the end.' };
      return { ok: false, error: `Not expected: ${message.type}` };
    },
  } as unknown as JobTab;
  const hfos = (async (message: { type: string; input: { occasions: unknown[] } }) => {
    if (message.type !== 'hfos-occasions-save') throw new Error(`Not expected: ${message.type}`);
    saved.push(message.input);
    return { ok: true, value: { kept: message.input.occasions.length, left: 0 } };
  }) as unknown as Hfos;
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: () => undefined,
    warn: async (words) => void warned.push([...words]),
  };
  return { job, opened, saved, warned };
}

describe('the pages', () => {
  it('knows Facebook’s Birthdays page and LinkedIn’s Catch up by their addresses', () => {
    expect(facebookKind(BIRTHDAYS_PAGE).kind).toBe('birthdays');
    expect(facebookKind('https://www.facebook.com/events/birthdays').kind).toBe('birthdays');
    expect(linkedInKind(CATCH_UP_PAGE).kind).toBe('catch-up');
    expect(linkedInKind('https://www.linkedin.com/mynetwork/catch-up/birthday/').kind).toBe(
      'catch-up',
    );
  });

  it('reads whose birthday it is today on Facebook, and leaves the recent and upcoming ones', () => {
    const page = facebookRead();
    expect(page.people?.map(({ name, section }) => [name, section])).toEqual([
      ['Dana Reyes', TODAY_SECTION],
      ['Casey Moreno', TODAY_SECTION],
      ['Riley Stone', 'Recent birthdays'],
      ['Jo Nash', 'Upcoming birthdays'],
    ]);
    expect(birthdaysOn(page)).toEqual([
      expect.objectContaining({ name: 'Dana Reyes', kind: 'birthday', detail: null }),
      expect.objectContaining({
        name: 'Casey Moreno',
        kind: 'birthday',
        profile: expect.objectContaining({ id: '100004444444444' }),
      }),
    ]);
  });

  it('takes a box that says “today” as today’s, where the page shows no parts', () => {
    const doc = new JSDOM(
      `<!doctype html><html><body><div role="main">
        <div><a href="https://www.facebook.com/dana.reyes.72" role="link"><span>Dana Reyes</span></a><span>Today</span></div>
        <div><a href="https://www.facebook.com/riley.s.72" role="link"><span>Riley Stone</span></a><span>October 26</span></div>
      </div></body></html>`,
      { url: BIRTHDAYS_PAGE },
    ).window.document;
    expect(readBirthdays(doc.body, BIRTHDAYS_PAGE).map((p) => [p.name, p.section])).toEqual([
      ['Dana Reyes', TODAY_SECTION],
      ['Riley Stone', null],
    ]);
  });

  it('reads the birthdays and new jobs on Catch up, in LinkedIn’s words, and leaves the rest', () => {
    expect(linkedInRead().catchUp).toEqual([
      {
        name: 'Avery Brooks',
        profile: expect.objectContaining({ username: 'avery-brooks-72' }),
        kind: 'new_job',
        detail: 'Started a new position as Owner at Brooks Roofing',
      },
      {
        name: 'Quinn Harper',
        profile: expect.objectContaining({ username: 'quinn-harper-72' }),
        kind: 'birthday',
        detail: null,
      },
      {
        name: 'Sam Ortiz',
        profile: expect.objectContaining({ username: 'sam-ortiz-72' }),
        kind: 'new_job',
        detail: 'Starting a new role',
      },
    ]);
  });
});

describe('the once-a-day job', () => {
  it('runs after the requests and tidying, on Facebook and on LinkedIn', () => {
    expect(DAILY_JOBS.slice(0, 3)).toEqual(['requests', 'tidy', 'occasions']);
    expect(LINKEDIN_DAILY.slice(0, 3)).toEqual(['requests', 'tidy', 'occasions']);
  });

  it('hands today’s Facebook birthdays to HandsFreeOS', async () => {
    const { job, opened, saved } = jobWith(() => facebookRead());
    expect(await facebookOccasions(job)).toEqual({
      line: OCCASION_WORDS.saved(2),
      warned: false,
    });
    expect(opened).toEqual([BIRTHDAYS_PAGE]);
    expect(saved).toEqual([
      {
        workspaceId: BUSINESS,
        platform: 'facebook',
        occasions: [
          expect.objectContaining({ name: 'Dana Reyes', kind: 'birthday' }),
          expect.objectContaining({ name: 'Casey Moreno', kind: 'birthday' }),
        ],
      },
    ]);
  });

  it('hands LinkedIn’s birthdays and new jobs to HandsFreeOS', async () => {
    const { job, opened, saved } = jobWith(() => linkedInRead());
    expect((await linkedInOccasions(job)).line).toBe(OCCASION_WORDS.saved(3));
    expect(opened).toEqual([CATCH_UP_PAGE]);
    expect(saved).toEqual([
      expect.objectContaining({
        platform: 'linkedin',
        occasions: [
          expect.objectContaining({ kind: 'new_job', detail: expect.stringContaining('Brooks') }),
          expect.objectContaining({ kind: 'birthday', name: 'Quinn Harper' }),
          expect.objectContaining({ kind: 'new_job', name: 'Sam Ortiz' }),
        ],
      }),
    ]);
  });

  it('saves nothing when nobody has a birthday today, and stops on a warning', async () => {
    const none = jobWith(() => ({ ...facebookRead(), people: [] }));
    expect((await facebookOccasions(none.job)).line).toBe(OCCASION_WORDS.saved(0));
    expect(none.saved).toEqual([]);

    const blocked = jobWith(() => facebookRead(), ['You’re temporarily blocked']);
    expect(await facebookOccasions(blocked.job)).toMatchObject({ warned: true });
    expect(blocked.warned).toEqual([['You’re temporarily blocked']]);
    expect(blocked.saved).toEqual([]);
  });
});
