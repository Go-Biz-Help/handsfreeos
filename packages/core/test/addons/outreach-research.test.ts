/**
 * Social Outreach: **Research** on a person's row (docs/outreach.md, decision 46a). It asks the person's computer to
 * check that one person for fit next, ahead of the daily order; it counts toward the day's checks, and with those
 * used up it ends at once, saying they go first tomorrow. Never for someone not pitched, nor someone checked already.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askedWords,
  askTarget,
  researchAskState,
  researchTarget,
  tooOldFor,
} from '../../src/addons/outreach/asks';
import { CHECKS_PER_DAY, RESEARCH_WORDS, researchShown } from '../../src/addons/outreach/checks';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const admin = () => testDbs().admin.db;

describe('what a row shows for Research', () => {
  const shown = (
    verdict: 'waiting' | 'good' | 'maybe' | 'not' | 'failed' | null,
    ask: 'open' | 'tomorrow' | 'failed' | null = null,
    neverPitched = false,
  ) => researchShown({ check: verdict ? { verdict } : null, neverPitched, ask });

  it('shows the button only for someone not researched', () => {
    expect(shown(null)).toBe('button');
    expect(shown('failed')).toBe('button');
    expect(shown(null, 'failed')).toBe('button');
    expect(shown('good')).toBe('result');
    expect(shown('maybe')).toBe('result');
    expect(shown('not')).toBe('result');
  });

  it('says Researching… while asked or read and waiting for the AI, and tomorrow when the day is used up', () => {
    expect(shown(null, 'open')).toBe('researching');
    expect(shown('waiting')).toBe('researching');
    expect(shown(null, 'tomorrow')).toBe('tomorrow');
  });

  it('never offers it for someone not pitched', () => {
    expect(shown(null, null, true)).toBe('hidden');
    expect(shown(null, 'open', true)).toBe('hidden');
  });

  it('reads the ask: open, ended for tomorrow, failed, or nothing to say', () => {
    const r = (queued: boolean) => ({
      drafts: [],
      kind: null,
      opener: null,
      simple: false,
      lookedUp: false,
      queued,
    });
    expect(researchAskState(null)).toBeNull();
    expect(researchAskState({ state: 'waiting', result: null })).toBe('open');
    expect(researchAskState({ state: 'working', result: null })).toBe('open');
    expect(researchAskState({ state: 'done', result: r(true) })).toBe('tomorrow');
    expect(researchAskState({ state: 'done', result: null })).toBeNull();
    expect(researchAskState({ state: 'failed', result: null })).toBe('failed');
    expect(researchAskState({ state: 'lost', result: null })).toBe('failed');
    expect(researchAskState({ state: 'cancelled', result: null })).toBeNull();
  });

  it('is about the person, and needs a new enough extension', () => {
    const id = randomUUID();
    expect(askTarget({ kind: 'research', profileId: id })).toBe(researchTarget(id));
    expect(tooOldFor('0.26.0', 'research')).toBe(true);
    expect(tooOldFor('0.27.0', 'research')).toBe(false);
  });

  it('says what came of a press that ended at once', () => {
    const line = RESEARCH_WORDS.tomorrow('Dana Reyes', 40);
    expect(line).toBe(
      'That’s today’s 40 checks. Dana Reyes goes first when checking carries on tomorrow.',
    );
    expect(
      askedWords(
        { fresh: true, ask: { kind: 'research', state: 'done', line } },
        { computer: null, timezone: 'UTC' },
        Date.now(),
      ),
    ).toBe(line);
  });
});

describe('researching someone', () => {
  let owner: TestUser;
  let ws: string;
  const person = (username: string, name: string) => ({
    profile: { id: null, username, url: `https://www.facebook.com/${username}` },
    name,
    mutualFriends: null,
  });
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const ask = (profileId: string) =>
    runWith(
      owner,
      ws,
      'outreach.ask.make',
      { ask: { kind: 'research', profileId } },
      {
        channel: 'web',
      },
    ) as Promise<{
      fresh: boolean;
      ask: {
        askId: string;
        state: string;
        line: string | null;
        result: { queued: boolean } | null;
      };
    }>;
  const next = (input: Record<string, unknown> = {}) =>
    runAs(owner, ws, 'outreach.checks.next', input) as Promise<{
      people: { name: string; reason: string; profileId: string }[];
      today: number;
      perDay: number;
    }>;
  const look = (profileId: string) =>
    runAs(owner, ws, 'outreach.check.look', { profileId, lines: ['Owner at a shop'] });

  beforeAll(async () => {
    owner = await createTestUser('outres-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Research Co');
    await runWith(
      owner,
      ws,
      'outreach.live.beat',
      {
        computer: { id: randomUUID(), name: 'Chrome on Windows', version: '0.27.0' },
        active: true,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [
        person('avery.lane.5', 'Avery Lane'),
        person('blake.cho.2', 'Blake Cho'),
        person('drew.park.4', 'Drew Park'),
        ...Array.from({ length: CHECKS_PER_DAY }, (_, i) => person(`filler.${i}`, `Filler ${i}`)),
      ],
    });
    await runAs(owner, ws, 'outreach.friend.set', {
      profileId: await idOf('drew.park.4'),
      dontPitch: true,
    });
  }, 60_000);
  afterAll(closeTestDbs);

  it('puts them first in the checks, and lists them alone for the computer', async () => {
    const blake = await idOf('blake.cho.2');
    const made = await ask(blake);
    expect(made).toMatchObject({ fresh: true, ask: { state: 'waiting' } });
    // Pressed twice: the same ask.
    expect((await ask(blake)).fresh).toBe(false);
    const got = await next();
    expect(got.people[0]).toMatchObject({ name: 'Blake Cho', reason: 'asked' });
    const only = await next({ most: 1, profileId: blake });
    expect(only.people.map((p) => p.name)).toEqual(['Blake Cho']);
    // Read: off the list, and Research has nothing more to do for them.
    await look(blake);
    expect((await next({ most: 1, profileId: blake })).people).toEqual([]);
    expect(await refused(ask(randomUUID()))).toBe('not_found');
  });

  it('refuses someone not pitched', async () => {
    expect(await refused(ask(await idOf('drew.park.4')))).toBe('outreach_research_not_pitched');
  });

  it('counts toward the day, and with it used up says they go first tomorrow', async () => {
    for (let i = 0; i < CHECKS_PER_DAY; i++) await look(await idOf(`filler.${i}`));
    const avery = await idOf('avery.lane.5');
    const made = await ask(avery);
    expect(made.ask).toMatchObject({
      state: 'done',
      line: RESEARCH_WORDS.tomorrow('Avery Lane', CHECKS_PER_DAY),
      result: { queued: true },
    });
    expect((await next({ most: 1, profileId: avery })).people).toEqual([]);
    // Tomorrow: the day's checks are yesterday's, and they go first.
    await rows(
      admin(),
      sql`update addon_outreach.checks set looked_at = now() - interval '1 day' where workspace_id = ${ws}`,
    );
    const got = await next();
    expect(got.people[0]).toMatchObject({ name: 'Avery Lane', reason: 'asked' });
  });
});
