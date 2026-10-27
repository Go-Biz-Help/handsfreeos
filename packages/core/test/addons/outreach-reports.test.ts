/**
 * Check LinkedIn and Check Facebook (docs/outreach.md, decisions 74 and 77; ./src/addons/outreach/reports.ts), each
 * asked of a build that does it there; and what an ask on a network Chrome hasn't allowed says to press. What the extension saw is
 * core's problem reports now (../problem-reports.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASK_KINDS_FOR,
  askableOn,
  askedWords,
  askNameOn,
  askWaitingWords,
  tooOldFor,
} from '../../src/addons/outreach/asks';
import { allowedOn, REPORT_WORDS, TRY_STEP_NAMES } from '../../src/addons/outreach/reports';
import { outreachBusiness, runAs, runWith } from './outreach-fixture';

describe('Check LinkedIn and Check Facebook', () => {
  it('is each network’s, named for it, asked from Settings, of the build that first does it there', () => {
    expect(askableOn('linkedin', 'checkup')).toBe(true);
    expect(askableOn('facebook', 'checkup')).toBe(true);
    expect(askNameOn('checkup', 'linkedin')).toBe('Check LinkedIn');
    expect(askNameOn('checkup', 'facebook')).toBe('Check Facebook');
    // Each network's page asks Check, reads its profile and puts its words in (decision 80), and checks usernames are
    // free before one is picked (decision 84).
    expect(ASK_KINDS_FOR.settings).toEqual([
      'checkup',
      'profile_read',
      'profile_edit',
      'username_check',
    ]);
    expect(tooOldFor('0.47.0', 'checkup', 'linkedin')).toBe(true);
    expect(tooOldFor('0.48.0', 'checkup', 'linkedin')).toBe(false);
    // Check Facebook came nine builds after Check LinkedIn: a build between them is never asked it.
    expect(tooOldFor('0.56.0', 'checkup', 'facebook')).toBe(true);
    expect(tooOldFor('0.57.0', 'checkup', 'facebook')).toBe(false);
  });

  it('says on each network what it reads and tries there, and that it never presses the last button', () => {
    expect(REPORT_WORDS.checkupAbout('facebook')).toContain(
      'your bio, a post in a group, a comment, a friend request, a message, a like',
    );
    // Its links and username too, from 0.93.0 (decision 89).
    expect(REPORT_WORDS.checkupAbout('facebook')).toContain(
      'joining a group, your links, your username and your Facebook file',
    );
    expect(REPORT_WORDS.checkupAbout('linkedin')).toContain(
      'your headline, your About, a post, a comment',
    );
    for (const words of [
      REPORT_WORDS.checkupAbout('facebook'),
      REPORT_WORDS.checkupAbout('linkedin'),
    ])
      expect(words).toMatch(/It never saves, posts, sends, likes/);
    // Where people found by topic are read (decision 92): who liked or reacted, and Alignable's groups.
    expect(REPORT_WORDS.checkupAbout('instagram')).toContain(
      'its Likes box (opened and closed again)',
    );
    expect(REPORT_WORDS.checkupAbout('linkedin')).toContain('a post’s reactions box');
    expect(REPORT_WORDS.checkupAbout('alignable')).toContain(
      'a group’s Join (looked at, never pressed)',
    );
    expect(TRY_STEP_NAMES.reactors).toBe('reading who liked a post');
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

describe('which networks a computer may work', () => {
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
});
