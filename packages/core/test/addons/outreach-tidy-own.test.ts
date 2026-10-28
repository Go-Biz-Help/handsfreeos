/**
 * Social Outreach: tidying on its own (docs/outreach.md, decision 98). `outreach.friends.tidy` says who the extension
 * tidies today as the person picks for the network: the oldest old requests (to start), and on Facebook, when they pick
 * it, friends to unfriend only where the AI found they aren't a fit and they never chatted; each inside today's limits,
 * and nobody on a day the network warned them.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
const person = (username: string, name: string) => ({
  profile: fb(username),
  name,
  mutualFriends: null,
});

describe('tidying on its own', () => {
  let owner: TestUser;
  let ws: string;
  const tidy = () => runAs(owner, ws, 'outreach.friends.tidy', {});
  const names = (list: { name: string }[]) => list.map((c) => c.name);
  const since = (username: string, days: number) =>
    rows(
      admin(),
      sql`update addon_outreach.friends f set since = ${daysAgo(days)}::timestamptz
          from addon_outreach.profiles p
          where p.id = f.profile_id and p.workspace_id = ${ws} and p.username = ${username}`,
    );
  const profileId = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
    );
    return p!.id;
  };
  const notAFit = async (username: string) =>
    rows(
      admin(),
      sql`insert into addon_outreach.checks (workspace_id, user_id, profile_id, verdict, looked_at, checked_at)
          values (${ws}, ${owner.id}, ${await profileId(username)}, 'not', now(), now())`,
    );
  const pick = (tidy: 'off' | 'cancel' | 'unfriend') =>
    runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...AUTOMATION_DEFAULTS.networks,
          facebook: { ...AUTOMATION_DEFAULTS.networks.facebook, tidy },
        },
      },
    });

  beforeAll(async () => {
    owner = await createTestUser('outtidyown-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Outreach Tidy On Its Own Co');
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'sent',
      people: [
        person('avery.lane.3', 'Avery Lane'),
        person('quinn.harper.8', 'Quinn Harper'),
        person('rowan.blake.5', 'Rowan Blake'),
      ],
    });
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [
        person('quiet.unfit', 'Jordan Unfit'),
        person('quiet.talked', 'Riley Talked'),
        person('quiet.unchecked', 'Morgan Unchecked'),
      ],
    });
    await since('avery.lane.3', 40);
    await since('quinn.harper.8', 30);
    await since('rowan.blake.5', 10);
    for (const u of ['quiet.unfit', 'quiet.talked', 'quiet.unchecked']) await since(u, 2000);
    // The download file is in, with an old chat with one of them, so unfriending is suggested.
    const [made] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.imports (workspace_id, user_id, platform, made_at, finished_at, counts)
          values (${ws}, ${owner.id}, 'facebook', now(), now(), '{}'::jsonb) returning id`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.file_chats (workspace_id, user_id, platform, name, name_key, first_at,
            last_at, messages, last_from_me, profile_id, import_id, read_state, prospect)
          values (${ws}, ${owner.id}, 'facebook', 'Riley Talked', 'riley talked', ${daysAgo(3000)}::timestamptz,
            ${daysAgo(900)}::timestamptz, 4, true, ${await profileId('quiet.talked')}, ${made!.id}, 'read', false)`,
    );
    await notAFit('quiet.unfit');
    await notAFit('quiet.talked');
  }, 60_000);
  afterAll(closeTestDbs);

  it('cancels the old requests on its own to start, the oldest first, and unfriends nobody', async () => {
    const out = await tidy();
    expect(names(out.cancel)).toEqual(['Avery Lane', 'Quinn Harper']);
    // All three quiet friends are suggested for ticking, the longest quiet first.
    expect(names(out.unfriend)).toEqual(['Jordan Unfit', 'Morgan Unchecked', 'Riley Talked']);
    expect(out.own.mode).toBe('cancel');
    expect(names(out.own.cancel)).toEqual(['Avery Lane', 'Quinn Harper']);
    expect(out.own.unfriend).toEqual([]);
  });

  it('unfriends on its own only friends found not a fit and never chatted with, when picked', async () => {
    await pick('unfriend');
    const out = await tidy();
    expect(out.own.mode).toBe('unfriend');
    expect(names(out.own.unfriend)).toEqual(['Jordan Unfit']);
    expect(names(out.own.cancel)).toEqual(['Avery Lane', 'Quinn Harper']);
  });

  it('counts the ones done today, by hand or on its own, against what’s left', async () => {
    await runAs(owner, ws, 'outreach.friend.end', {
      kind: 'cancel_request',
      profile: fb('avery.lane.3'),
      name: 'Avery Lane',
    });
    const out = await tidy();
    expect(out.limits.cancel_request.done).toBe(1);
    expect(names(out.own.cancel)).toEqual(['Quinn Harper']);
  });

  it('picks nobody while the person only ticks', async () => {
    await pick('off');
    const out = await tidy();
    expect(out.own).toEqual({ mode: 'off', cancel: [], unfriend: [] });
    expect(names(out.cancel)).toEqual(['Quinn Harper']);
  });

  it('picks nobody on a day the network warned them', async () => {
    await pick('unfriend');
    await runAs(owner, ws, 'outreach.warning.note', {
      words: ['You’re temporarily blocked from sending friend requests'],
    });
    const out = await tidy();
    expect(out.own.mode).toBe('unfriend');
    expect(out.own.cancel).toEqual([]);
    expect(out.own.unfriend).toEqual([]);
  });

  it('reads unfriending as the old requests on a network that can’t unfriend', async () => {
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...AUTOMATION_DEFAULTS.networks,
          linkedin: { ...AUTOMATION_DEFAULTS.networks.linkedin, on: true, tidy: 'unfriend' },
        },
      },
    });
    const out = await runAs(owner, ws, 'outreach.friends.tidy', { platform: 'linkedin' });
    expect(out.own.mode).toBe('cancel');
  });
});
