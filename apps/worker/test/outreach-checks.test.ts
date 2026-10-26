/**
 * Social Outreach in the worker: the people a person knows on Facebook, read off their pages, are checked by the AI
 * (the stand-in model here) for whether they fit a playbook (decision 46), a batch at a time; what their pages said is
 * let go once it has. At the day's AI limit the rest wait, unread.
 */
import { randomUUID } from 'node:crypto';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { CHECK_PEOPLE_JOB } from '../src/addons/outreach/checks';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { costlyAi, setAiLimit, testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

let owner: TestUser;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-checks-${randomUUID().slice(0, 8)}`;
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

const friend = (n: number) => ({
  profile: { id: null, username: `made.up.${n}`, url: `https://www.facebook.com/made.up.${n}` },
  name: `Made Up Person ${n}`,
  mutualFriends: null,
});

/** A business with the CRM playbook, and these friends read off their pages. */
async function looked(name: string, pages: readonly string[][]) {
  const ws = await outreachBusiness(owner, name);
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: crm.details,
  });
  await runAs(owner, ws, 'outreach.friends.save', {
    list: 'friends',
    people: pages.map((_, i) => friend(i + 1)),
  });
  const next = await runAs(owner, ws, 'outreach.checks.next', {});
  for (const [i, lines] of pages.entries()) {
    const who = next.people.find((p: { name: string }) => p.name === `Made Up Person ${i + 1}`);
    await runAs(owner, ws, 'outreach.check.look', { profileId: who.profileId, lines });
  }
  return ws;
}

const states = (ws: string) =>
  rows<{
    name: string;
    verdict: string;
    lines: string[];
    why: string[];
    about: string | null;
    next_step: string | null;
    playbook: string | null;
  }>(
    admin(),
    sql`select p.name, ch.verdict, ch.lines, ch.why, ch.about, ch.next_step, pb.name as playbook
        from addon_outreach.checks ch join addon_outreach.profiles p on p.id = ch.profile_id
        left join addon_outreach.playbooks pb on pb.id = ch.playbook_id
        where ch.workspace_id = ${ws} order by p.name`,
  );

beforeAll(async () => {
  owner = await createTestUser('outreach-checks-owner', { fullName: 'Pat Owner' });
}, 60_000);

afterAll(closeTestDbs);

describe('checking the people the person knows', () => {
  it('says whether each fits, and lets their pages go', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await looked('Outreach Checks Worker Co', [
      ['Owner at Lane Plumbing'],
      ['Office manager at a dental practice'],
      ['Loves hiking'],
    ]);
    await drain(s, ws);
    expect(await states(ws)).toEqual([
      {
        name: 'Made Up Person 1',
        verdict: 'good',
        lines: [],
        why: ['Owns a business'],
        about: 'Owner at Lane Plumbing',
        next_step: 'Ask how business is going',
        playbook: 'CRM demos',
      },
      {
        name: 'Made Up Person 2',
        verdict: 'maybe',
        lines: [],
        why: ['Runs a team'],
        about: 'Office manager at a dental practice',
        next_step: null,
        playbook: 'CRM demos',
      },
      {
        name: 'Made Up Person 3',
        verdict: 'not',
        lines: [],
        why: [],
        about: null,
        next_step: null,
        playbook: null,
      },
    ]);
  });

  it('weighs where they live from their profile and mutual friends while the business reaches only some countries', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await outreachBusiness(owner, 'Outreach Country Looks Co');
    await rows(
      admin(),
      sql`update app.addon_installations
          set settings = coalesce(settings, '{}'::jsonb) || '{"countries":{"mode":"only","codes":["US"]}}'::jsonb
          where workspace_id = ${ws} and addon_id = 'outreach'`,
    );
    // Two of the owner's friends live in the United States; a third is only From Nigeria.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [friend(1), friend(2), friend(3)],
    });
    const ids = await rows<{ id: string; username: string }>(
      admin(),
      sql`select id, username from addon_outreach.profiles where workspace_id = ${ws} order by username`,
    );
    const id = (n: number) => ids.find((p) => p.username === `made.up.${n}`)!.id;
    await rows(
      admin(),
      sql`update addon_outreach.profiles set country = 'US', country_how = 'seen', country_at = now()
          where id = any (${`{${id(1)},${id(2)}}`}::uuid[])`,
    );
    await runAs(owner, ws, 'outreach.check.look', {
      profileId: id(3),
      lines: ['From Lagos, Nigeria'],
      friendsCount: 300,
      mutual: [friend(1).profile, friend(2).profile],
    });
    await drain(s, ws);
    const [them] = await rows<{
      country: string;
      country_how: string;
      country_from: string;
      country_unsure: boolean;
      country_mutual: unknown;
    }>(
      admin(),
      sql`select country, country_how, country_from, country_unsure, country_mutual
          from addon_outreach.profiles where id = ${id(3)}`,
    );
    expect(them).toEqual({
      country: 'US',
      country_how: 'friends',
      country_from: 'NG',
      country_unsure: false,
      country_mutual: { read: 2, by: [{ code: 'US', seen: 2, other: 0 }] },
    });
  });

  it('leaves the rest waiting at the day’s AI limit', async () => {
    const none = testServices({ ai: { provider: costlyAi() } });
    const ws = await looked('Outreach Capped Checks Co', [
      ['Owner at Lane Plumbing'],
      ['Owner at Cho Electric'],
      ['Owner at Ford Roofing'],
    ]);
    await setAiLimit(ws, 1);
    await drain(none, ws);
    const waiting = (await states(ws)).filter((c) => c.verdict === 'waiting');
    expect(waiting.length).toBeGreaterThan(0);
    // What their pages said waits with them for the AI.
    expect(waiting[0]!.lines.length).toBe(1);
    const [job] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '1 hour' as later from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${CHECK_PEOPLE_JOB} and status = 'pending'`,
    );
    expect(job?.later).toBe(true);
  });
});
