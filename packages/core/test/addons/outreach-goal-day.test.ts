/**
 * The day's first messages on a network (docs/outreach.md, decision 126), as HandsFreeOS works them out: Today's goal
 * with how many short and why, the checks going up to the network's most while it needs more good fits (answer 4a),
 * and the day's report naming a network that fell short (7a).
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goalNote } from '../../src/addons/outreach/goal';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { NETWORKS } from '../../src/addons/outreach/networks';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { outreachAddonServer } from '../../src/addons/outreach/server';
import { localDateOf } from '../../src/calendar/engine/zoned';
import { executeQuery } from '../../src/server';
import { checkedAs, outreachBusiness, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;

describe('the day’s first messages', () => {
  let owner: TestUser;
  let ws: string;
  let playbookId: string;
  const person = (username: string, name: string) => ({
    profile: { id: null, username, url: `https://www.facebook.com/${username}` },
    name,
    mutualFriends: null,
  });
  const friends = [
    person('avery.lane.5', 'Avery Lane'),
    person('blake.cho.2', 'Blake Cho'),
    person('casey.moreno.8', 'Casey Moreno'),
  ];
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const today = () => runAs(owner, ws, 'outreach.today', {});
  /** The worker's day's report for the person, of a day. */
  const dayReport = async (day: string) => {
    const [w] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${ws}`,
    );
    const def = outreachAddonServer.queries!.find((q) => q.name === 'outreach.day_report')!;
    return executeQuery(
      testDbs().worker.db,
      def,
      { workspaceId: ws, day },
      {
        type: 'system',
        workspaceId: ws,
        organizationId: w!.organization_id,
        addon: { id: outreachAddon.id, name: outreachAddon.name, version: outreachAddon.version },
        onBehalfOf: owner.id,
      },
      { correlationId: randomUUID(), channel: 'test' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as Promise<any>;
  };

  beforeAll(async () => {
    owner = await createTestUser('outgoal-owner', { fullName: 'Sam Owner' });
    ws = await outreachBusiness(owner, 'Goal Day Co');
    playbookId = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: 'CRM demos',
        template: 'crm_demos',
        details: PLAYBOOK_TEMPLATES.crm_demos.details,
      })
    ).id;
    await runAs(owner, ws, 'outreach.friends.save', { list: 'friends', people: friends });
  }, 60_000);
  afterAll(closeTestDbs);

  it('says on Today how many short and why, and checks up to the most while short', async () => {
    const first = await today();
    // Nothing sent or ready: all 15 short, and the friends it hasn't checked yet are why.
    expect(first.goal).toMatchObject({
      most: 15,
      done: 0,
      listed: 0,
      short: 15,
      ahead: 0,
      more: true,
      why: 'checking',
      tries: [],
      facts: { unchecked: 3, checked: 0 },
    });
    // Short of good fits: up to Facebook's most today (answer 4a), not its usual 40.
    expect(await runAs(owner, ws, 'outreach.checks.next', {})).toMatchObject({
      today: 0,
      perDay: NETWORKS.facebook.checksMost,
    });
  });

  it('names the real reason once they’re checked, with what to try', async () => {
    for (const f of friends)
      await checkedAs(owner, ws, await idOf(f.profile.username), {
        fit: 'not',
        why: ['Not a trade'],
        playbookId,
      });
    const { goal } = await today();
    // All checked, none fit, and nobody new found to ask: groups first, on Facebook.
    expect(goal).toMatchObject({
      short: 15,
      why: 'few_found',
      tries: ['groups', 'playbook', 'networks'],
      facts: { checked: 3, fit: 0, unchecked: 0 },
    });
    expect(goalNote(goal, 'facebook')).toBe(
      'Facebook is 15 short of today’s 15 first messages. It found too few new people who fit to send today’s friend requests. It’s checking more people and searching again today on its own.',
    );
  });

  it('says in the day’s report who fell short, for the day the worker names', async () => {
    const day = localDateOf(Date.now(), 'America/Chicago');
    expect((await dayReport(day)).short).toEqual([
      expect.objectContaining({ platform: 'facebook', short: 15, most: 15, why: 'few_found' }),
    ]);
  });
});
