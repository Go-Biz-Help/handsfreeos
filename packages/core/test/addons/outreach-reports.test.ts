/**
 * What the extension saw (docs/outreach.md, decision 74; ./src/addons/outreach/reports.ts): a note of each page a job
 * read, the person's own, with what was found as counts and the network's own words only; **Check LinkedIn**, asked
 * only on LinkedIn and of a build that does it; and what an ask on a network Chrome hasn't allowed says to press.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASK_KINDS_FOR,
  askableOn,
  askedWords,
  askNameOn,
  askWaitingWords,
  tooOldFor,
} from '../../src/addons/outreach/asks';
import {
  allowedOn,
  PageReport,
  REPORT_OUTLINE_MOST,
  REPORT_WORDS,
} from '../../src/addons/outreach/reports';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const admin = () => testDbs().admin.db;

describe('a note of what the extension saw', () => {
  const report = {
    platform: 'linkedin',
    job: 'profile_read',
    page: 'own-profile',
    path: '/in/{1}/',
  } as const;

  it('takes counts, yes or no and section names as found, and an empty note as none', () => {
    const got = PageReport.parse({
      ...report,
      found: { roles: 4, about: true, sections: ['About', 'Activity', 'Experience'] },
      note: ' ',
    });
    expect(got).toMatchObject({ askId: null, shown: null, note: null, outline: null });
    expect(got.found).toEqual({
      roles: 4,
      about: true,
      sections: ['About', 'Activity', 'Experience'],
    });
  });

  it('refuses what found can’t hold: words as a value, a key that isn’t a plain name, an outline too long', () => {
    expect(PageReport.safeParse({ ...report, found: { about: 'I help roofers' } }).success).toBe(
      false,
    );
    expect(PageReport.safeParse({ ...report, found: { 'Dana Reyes': 1 } }).success).toBe(false);
    expect(
      PageReport.safeParse({ ...report, outline: 'x'.repeat(REPORT_OUTLINE_MOST + 1) }).success,
    ).toBe(false);
  });
});

describe('Check LinkedIn', () => {
  it('is LinkedIn’s alone, named for it, asked from Settings, of 0.48.0 or later', () => {
    expect(askableOn('linkedin', 'checkup')).toBe(true);
    expect(askableOn('facebook', 'checkup')).toBe(false);
    expect(askNameOn('checkup', 'linkedin')).toBe('Check LinkedIn');
    expect(ASK_KINDS_FOR.settings).toEqual(['checkup']);
    expect(tooOldFor('0.47.0', 'checkup', 'linkedin')).toBe(true);
    expect(tooOldFor('0.48.0', 'checkup', 'linkedin')).toBe(false);
  });
});

describe('an ask on a network Chrome hasn’t allowed', () => {
  const computer = (allowed: ('facebook' | 'linkedin')[] | null) => ({
    name: 'Chrome on Mac 12',
    online: true,
    signedOut: false,
    lastSeenAt: new Date().toISOString(),
    allowed,
  });

  it('says what to press, on that network only', () => {
    const now = Date.now();
    expect(askWaitingWords(computer(['facebook']), 'UTC', now, 'linkedin')).toBe(
      `${REPORT_WORDS.notAllowed('Chrome on Mac 12', 'linkedin')} It does this then.`,
    );
    expect(REPORT_WORDS.notAllowed('Chrome on Mac 12', 'linkedin')).toContain(
      'press Allow on LinkedIn, then Allow in Chrome’s box',
    );
    expect(askWaitingWords(computer(['facebook']), 'UTC', now, 'facebook')).toBe(
      'Chrome on Mac 12 starts on it in a moment.',
    );
    // A build that doesn't say is taken at its word.
    expect(askWaitingWords(computer(null), 'UTC', now, 'linkedin')).toBe(
      'Chrome on Mac 12 starts on it in a moment.',
    );
    expect(
      askedWords(
        { fresh: true, ask: { kind: 'checkup', platform: 'linkedin' } },
        {
          computer: { ...computer(['facebook']), computerId: randomUUID(), version: '0.48.0' },
          timezone: 'UTC',
        },
        now,
      ),
    ).toContain('isn’t allowed on LinkedIn yet');
  });

  it('may when Chrome allows it, or the build doesn’t say', () => {
    expect(allowedOn(['facebook', 'linkedin'], 'linkedin')).toBe(true);
    expect(allowedOn(['facebook'], 'linkedin')).toBe(false);
    expect(allowedOn(null, 'linkedin')).toBe(true);
    expect(allowedOn(undefined, 'facebook')).toBe(true);
  });
});

describe('saving a note', () => {
  let owner: TestUser;
  let other: TestUser;
  let ws: string;
  let otherWs: string;
  const beat = (u: TestUser, w: string, allowed: string[] | null) =>
    runWith(
      u,
      w,
      'outreach.live.beat',
      {
        computer: { id: randomUUID(), name: 'Chrome on Mac', version: '0.48.0', allowed },
        active: true,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );

  beforeAll(async () => {
    [owner, other] = await Promise.all([
      createTestUser('outreports-owner', { fullName: 'Pat Owner' }),
      createTestUser('outreports-other', { fullName: 'Sam Other' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Reports Co');
    otherWs = await outreachBusiness(other, 'Outreach Reports Other Co');
    await Promise.all([beat(owner, ws, ['facebook']), beat(other, otherWs, null)]);
  }, 60_000);
  afterAll(closeTestDbs);

  it('says which networks the computer may work, as it last said', async () => {
    const got = (await runAs(owner, ws, 'outreach.asks', {})) as {
      computer: { allowed: string[] | null };
    };
    expect(got.computer.allowed).toEqual(['facebook']);
    const theirs = (await runAs(other, otherWs, 'outreach.asks', {})) as {
      computer: { allowed: string[] | null };
    };
    expect(theirs.computer.allowed).toBeNull();
  });

  it('keeps a note of the person’s own ask, outline and all, and never one of someone else’s', async () => {
    const made = (await runWith(
      owner,
      ws,
      'outreach.ask.make',
      { ask: { kind: 'profile_read' } },
      { channel: 'web' },
    )) as { ask: { askId: string } };
    const askId = made.ask.askId;
    const outline = 'HandsFreeOS Social 0.48.0 · page outline\nbody\n  h2 "Experience"';
    const saved = (await runAs(owner, ws, 'outreach.report.save', {
      report: {
        platform: 'facebook',
        askId,
        job: 'profile_read',
        version: '0.48.0',
        page: 'own-profile',
        path: '/me/',
        shown: false,
        found: { intro: 0, posts: 2 },
        note: 'No intro was read.',
        outline,
      },
    })) as { reportId: string };
    const [row] = await rows<{
      user_id: string;
      ask_id: string;
      shown: boolean;
      found: unknown;
      outline: string;
    }>(
      admin(),
      sql`select user_id, ask_id, shown, found, outline from addon_outreach.reports where id = ${saved.reportId}`,
    );
    expect(row).toMatchObject({
      user_id: owner.id,
      ask_id: askId,
      shown: false,
      found: { intro: 0, posts: 2 },
      outline,
    });
    // Someone else's ask: not kept.
    expect(
      await refused(
        runAs(other, otherWs, 'outreach.report.save', {
          report: {
            platform: 'facebook',
            askId,
            job: 'profile_read',
            page: 'own-profile',
            path: '/me/',
          },
        }),
      ),
    ).toBe('not_found');
    // A day's step has no ask.
    const step = (await runAs(owner, ws, 'outreach.report.save', {
      report: {
        platform: 'linkedin',
        job: 'like',
        page: 'activity',
        path: '/in/{1}/recent-activity/all/',
      },
    })) as { reportId: string };
    expect(step.reportId).toBeTruthy();
    // It goes with its ask.
    await rows(admin(), sql`delete from addon_outreach.asks where id = ${askId}`);
    expect(
      await rows(admin(), sql`select id from addon_outreach.reports where id = ${saved.reportId}`),
    ).toEqual([]);
  });
});
