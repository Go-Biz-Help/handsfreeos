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
import { testServices, type TestServices } from './helpers';

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
    const s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
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

  it('leaves the rest waiting at the day’s AI limit', async () => {
    const none = testServices({ ai: { provider: scriptedAi(), dailyTokens: 1 } });
    const ws = await looked('Outreach Capped Checks Co', [
      ['Owner at Lane Plumbing'],
      ['Owner at Cho Electric'],
      ['Owner at Ford Roofing'],
    ]);
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
