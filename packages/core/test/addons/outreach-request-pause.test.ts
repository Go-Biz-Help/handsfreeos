/**
 * Social Outreach: a network's own monthly limit on the person's requests (docs/outreach.md, decision 147). Alignable
 * says they reached their monthly connection limit, and new connection requests there wait till the 1st of next
 * month, with one line on Today saying so; Start again ends it sooner, after an upgrade. Nothing else slows or stops.
 */
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  requestsAgainWords,
  requestsHeldWords,
  requestsLimitLine,
} from '../../src/addons/outreach/network-words';
import { pauseEndsOn, PAUSE_AGAIN_DAYS } from '../../src/addons/outreach/request-pause';
import { requestsLimitHeld } from '../../src/addons/outreach/today';
import { localInstant } from '../../src/calendar/engine/zoned';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const DAY = 86_400_000;
const CHICAGO = 'America/Chicago';
const at = (date: string, clock = '12:00', zone = CHICAGO) => localInstant(date, clock, zone);

describe('when new requests start again after a monthly limit', () => {
  it('is the 1st of next month, on the business’s clock', () => {
    expect(pauseEndsOn(at('2026-11-02'), CHICAGO, null)).toBe('2026-12-01');
    expect(pauseEndsOn(at('2026-12-31', '23:30'), CHICAGO, null)).toBe('2027-01-01');
    // Still the 30th in Chicago, though it's the 1st in London already.
    expect(pauseEndsOn(at('2026-11-30', '22:00'), CHICAGO, null)).toBe('2026-12-01');
    expect(pauseEndsOn(at('2026-11-30', '22:00'), 'Europe/London', null)).toBe('2027-01-01');
  });

  it('is a week on, not a month, when the last pause ended less than a week ago', () => {
    const now = at('2026-12-01', '09:00');
    const ended = at('2026-12-01', '00:00');
    expect(pauseEndsOn(now, CHICAGO, ended)).toBe('2026-12-08');
    // The 1st comes sooner than a week on: the 1st it is.
    expect(pauseEndsOn(at('2026-12-28'), CHICAGO, at('2026-12-27'))).toBe('2027-01-01');
    // Ended a week ago or more: the 1st of next month again.
    expect(pauseEndsOn(now, CHICAGO, now - PAUSE_AGAIN_DAYS * DAY)).toBe('2027-01-01');
  });

  it('says till when on Today, and that likes, comments and messages go on', () => {
    expect(requestsHeldWords(requestsLimitHeld('2026-12-01'), 'alignable')).toBe(
      'No new connection requests on Alignable till Dec 1: Alignable says you’ve reached your monthly limit. Likes, comments and messages go on. Upgraded on Alignable? Start them again.',
    );
    expect(requestsLimitLine('alignable', '2026-12-01')).toBe(
      'Alignable says you’ve reached your monthly limit, so new connection requests wait till Dec 1. Likes, comments and messages go on.',
    );
    expect(requestsLimitLine('alignable', null)).toContain('wait till the 1st');
    expect(requestsAgainWords('alignable').button).toBe('Start again');
  });
});

describe('Alignable’s monthly connection limit', () => {
  let owner: TestUser;
  let ws: string;
  const held = async (platform = 'alignable') =>
    (await runAs(owner, ws, 'outreach.today', { platform })).requestsHeld as {
      why: string;
      until: string | null;
    } | null;
  const pause = () =>
    runAs(owner, ws, 'outreach.requests.pause', {
      platform: 'alignable',
      words: ['You’ve reached your monthly connection limit'],
    });

  beforeAll(async () => {
    owner = await createTestUser('outpause-owner', { fullName: 'Morgan Owner' });
    ws = await outreachBusiness(owner, 'Outreach Pause Co');
  }, 60_000);

  afterAll(closeTestDbs);

  it('holds new connection requests on Alignable alone till the 1st, seen again or not', async () => {
    expect(await held()).toBeNull();
    const first = await pause();
    const until = pauseEndsOn(Date.now(), CHICAGO, null);
    expect(first).toEqual({ until, already: false });
    expect(await held()).toMatchObject({ why: 'limit', until });
    // Seen again on another computer: left as it was.
    expect(await pause()).toEqual({ until, already: true });
    // Facebook's list goes on.
    expect(await held('facebook')).toBeNull();
  });

  it('starts them again on Start again, and waits a week, not a month, when hit again', async () => {
    expect(
      await runAs(owner, ws, 'outreach.requests.start_again', { platform: 'alignable' }),
    ).toEqual({ ended: true });
    expect(await held()).toBeNull();
    expect(
      await runAs(owner, ws, 'outreach.requests.start_again', { platform: 'alignable' }),
    ).toEqual({ ended: false });
    const again = await pause();
    expect(again).toEqual({ until: pauseEndsOn(Date.now(), CHICAGO, Date.now()), already: false });
    expect(await held()).toMatchObject({ why: 'limit', until: again.until });
  });

  it('pauses nothing on a follow network, whose follows wait for nobody', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.requests.pause', {
          platform: 'instagram',
          words: ['You’ve reached your monthly limit'],
        }),
      ),
    ).toBe('outreach_pause_follows');
  });
});
