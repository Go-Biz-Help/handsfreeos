/**
 * Social Outreach in the worker: the AI (the stand-in model here) picks Instagram accounts like the business's from
 * those the person's computer found (decision 110): the best kept with why, the rest passed over for good, never more
 * than 5 kept in all, and at the day's AI limit they wait.
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider } from '@hfos/ai';
import { AUTOMATION_DEFAULTS } from '@hfos/core/addons/outreach/automation';
import { blankPlaybook } from '@hfos/core/addons/outreach/playbooks';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { PICK_LIKE_YOURS_JOB } from '../src/addons/outreach/like-yours';
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
    const runner = `vitest-like-yours-${randomUUID().slice(0, 8)}`;
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

/** The stand-in model, counting the picks it was asked for. */
function counting(inner: AiProvider = scriptedAi()) {
  let asks = 0;
  const provider: AiProvider = {
    ...inner,
    stream: async (request, options) => {
      if (JSON.stringify(request).includes('of these accounts whose followers')) asks += 1;
      return inner.stream(request, options);
    },
  };
  return { provider, asks: () => asks };
}

/** A business on Instagram, with a customers' playbook for roofers in Austin. */
async function onInstagram(name: string): Promise<string> {
  const ws = await outreachBusiness(owner, name);
  await runAs(owner, ws, 'outreach.automation.save', {
    settings: { ...AUTOMATION_DEFAULTS, networks: { instagram: { on: true } } },
  });
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: 'Austin roofers',
    details: {
      ...blankPlaybook(),
      offer: 'A free week of answered calls',
      niche: 'Roofers in Austin',
      audience: 'Roofing companies with 2 to 3 crews',
      area: 'Austin, TX',
    },
  });
  return ws;
}

const found = (ws: string, usernames: string[]) =>
  runAs(owner, ws, 'outreach.like_yours.found', {
    accounts: usernames.map((username) => ({
      username,
      name: null,
      words: 'Austin chamber of commerce',
    })),
  });

const statesOf = async (ws: string) =>
  Object.fromEntries(
    (
      await rows<{ username: string; state: string; why: string | null }>(
        admin(),
        sql`select username, state, why from addon_outreach.like_yours where workspace_id = ${ws}`,
      )
    ).map((r) => [r.username, { state: r.state, why: r.why }]),
  );

beforeAll(async () => {
  owner = await createTestUser('outreach-like-yours-owner', { fullName: 'Marlo Quint' });
}, 60_000);

afterAll(closeTestDbs);

describe('the AI’s pick of accounts like yours', () => {
  it('keeps the best with why and passes over the rest for good', async () => {
    const ai = counting();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await onInstagram('Outreach Like Yours Co');
    await found(ws, ['austinchamber', 'austinevents']);
    await drain(s, ws);
    expect(ai.asks()).toBe(1);
    expect(await statesOf(ws)).toEqual({
      austinchamber: { state: 'kept', why: 'Shares the business’s customers' },
      austinevents: { state: 'passed', why: 'Austin chamber of commerce' },
    });

    // Found again, a passed-over account isn't looked at again.
    await found(ws, ['austinevents']);
    await drain(s, ws);
    expect(ai.asks()).toBe(1);
    expect((await statesOf(ws))['austinevents']!.state).toBe('passed');
  });

  it('asks nothing once 5 are kept, and passes over what was found', async () => {
    const ai = counting();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await onInstagram('Outreach Like Yours Full Co');
    for (const username of [
      'roundrockchamber',
      'austinvenue',
      'austinplumbing',
      'texasbuild',
      'atxhome',
    ])
      await runAs(owner, ws, 'outreach.like_yours.add', { account: username });
    await found(ws, ['austinchamber']);
    await drain(s, ws);
    expect(ai.asks()).toBe(0);
    expect((await statesOf(ws))['austinchamber']!.state).toBe('passed');
  });

  it('waits at the day’s AI limit', async () => {
    const ai = counting(costlyAi());
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await onInstagram('Outreach Like Yours Capped Co');
    await setAiLimit(ws, 0);
    await found(ws, ['austinchamber']);
    await drain(s, ws);
    expect((await statesOf(ws))['austinchamber']!.state).toBe('candidate');
    const [waiting] = await rows<{ n: number | string }>(
      admin(),
      sql`select count(*) as n from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${PICK_LIKE_YOURS_JOB} and status = 'pending'
            and run_at > now() + interval '5 hours'`,
    );
    expect(Number(waiting!.n)).toBe(1);
  });
});
