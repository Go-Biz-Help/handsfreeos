/**
 * Social Outreach in the worker: people who could partner, read off their profiles, are checked by the AI (the
 * stand-in model here) for whether their audience is the business's customers (decision 81), a batch at a time; a good
 * or maybe goes on the Partners list and is never pitched as a customer, and what their profile said is let go. At the
 * day's AI limit the rest wait, unread.
 */
import { randomUUID } from 'node:crypto';
import { blankPlaybook } from '@hfos/core/addons/outreach/playbooks';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { CHECK_PARTNERS_JOB, partnerFacts } from '../src/addons/outreach/partners';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

let owner: TestUser;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-partners-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

/** A business with a partner playbook, and a group's admin, a creator and a founder read off their profiles. */
async function looked(name: string) {
  const ws = await outreachBusiness(owner, name);
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: 'Partners',
    template: null,
    details: {
      ...blankPlaybook(),
      goal: 'partner',
      offer: 'A share of what each customer you send pays',
      audience: 'Owners of small businesses in Austin',
    },
  });
  await runAs(owner, ws, 'outreach.group.save', {
    group: {
      id: '616161616',
      slug: null,
      url: 'https://www.facebook.com/groups/616161616/',
      name: 'Austin Small Business Owners',
    },
    members: 4_200,
    people: [{ profile: fb('gail.admin.1'), name: 'Gail Admin', runsGroup: true }],
  });
  await runAs(owner, ws, 'outreach.friends.save', {
    list: 'friends',
    people: [
      { profile: fb('cara.creator.2'), name: 'Cara Creator', mutualFriends: null },
      { profile: fb('bo.business.3'), name: 'Bo Business', mutualFriends: null },
    ],
  });
  await rows(
    admin(),
    sql`update addon_outreach.profiles set
          followers = case username when 'cara.creator.2' then 28000 end,
          intro = case username when 'bo.business.3' then array['Founder at Bo Consulting'] else intro end
        where workspace_id = ${ws}`,
  );
  const next = await runAs(owner, ws, 'outreach.partners.next', {});
  for (const p of next.people as { profileId: string; kind: string }[])
    await runAs(owner, ws, 'outreach.partner.look', {
      profileId: p.profileId,
      kind: p.kind,
      lines: ['Their profile'],
    });
  return ws;
}

const states = (ws: string) =>
  rows<{
    name: string;
    fit: string;
    kind: string;
    stage: string | null;
    lines: string[];
    audience: string | null;
    audience_size: number | null;
    playbook: string | null;
    found: boolean;
  }>(
    admin(),
    sql`select p.name, pa.fit, pa.kind, pa.stage, pa.lines, pa.audience, pa.audience_size, pb.name as playbook,
          p.partner_found_at is not null as found
        from addon_outreach.partners pa join addon_outreach.profiles p on p.id = pa.profile_id
        left join addon_outreach.playbooks pb on pb.id = pa.playbook_id
        where pa.workspace_id = ${ws} order by p.name`,
  );

beforeAll(async () => {
  owner = await createTestUser('outreach-partners-owner', { fullName: 'Pat Owner' });
}, 60_000);

afterAll(closeTestDbs);

describe('the AI’s partner check', () => {
  it('tells the AI the groups they run, their following and their lines', () => {
    expect(
      partnerFacts({
        platform: 'facebook',
        intro: ['Realtor in Austin'],
        followers: 1200,
        mutual_friends: 3,
        groups: [
          { name: 'Austin Homeowners', members: 14200, who: 'Homeowners asking for contractors' },
          { name: null, members: null, who: null },
        ],
      }),
    ).toEqual([
      'Runs the group Austin Homeowners (14,200 members): Homeowners asking for contractors',
      'Runs the group with no name shown',
      '1,200 followers',
      'Realtor in Austin',
      '3 mutual friends',
    ]);
  });

  it('puts a good partner and a maybe on the list, and lets their profiles go', async () => {
    const s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
    const ws = await looked('Outreach Partners Worker Co');
    await drain(s, ws);
    expect(await states(ws)).toEqual([
      {
        name: 'Bo Business',
        fit: 'not',
        kind: 'business',
        stage: null,
        lines: [],
        audience: null,
        audience_size: null,
        playbook: null,
        found: false,
      },
      {
        name: 'Cara Creator',
        fit: 'maybe',
        kind: 'creator',
        stage: 'found',
        lines: [],
        audience: null,
        audience_size: 28000,
        playbook: 'Partners',
        found: true,
      },
      {
        name: 'Gail Admin',
        fit: 'good',
        kind: 'group_admin',
        stage: 'found',
        lines: [],
        audience: 'Members of Austin Small Business Owners',
        audience_size: 4200,
        playbook: 'Partners',
        found: true,
      },
    ]);
  });

  it('leaves the rest waiting at the day’s AI limit', async () => {
    const none = testServices({ ai: { provider: scriptedAi(), dailyTokens: 1 } });
    const ws = await looked('Outreach Capped Partners Co');
    await drain(none, ws);
    const waiting = (await states(ws)).filter((r) => r.fit === 'waiting');
    expect(waiting.length).toBeGreaterThan(0);
    // What their profile said waits with them for the AI, and the read comes back hours later.
    expect(waiting[0]!.lines).toEqual(['Their profile']);
    const [job] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '1 hour' as later from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${CHECK_PARTNERS_JOB} and status = 'pending'`,
    );
    expect(job?.later).toBe(true);
  });
});
