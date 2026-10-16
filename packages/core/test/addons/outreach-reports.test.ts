/**
 * Check LinkedIn (docs/outreach.md, decision 74; ./src/addons/outreach/reports.ts), asked only on LinkedIn and of a
 * build that does it; and what an ask on a network Chrome hasn't allowed says to press. What the extension saw is
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
import { allowedOn, REPORT_WORDS } from '../../src/addons/outreach/reports';
import { outreachBusiness, runAs, runWith } from './outreach-fixture';

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
