/**
 * Real Estate Agent's client updates in the worker (step 13): a milestone the business keeps on brings a draft
 * written from the deal's facts by the model (a stand-in here), checked by the fixed list and the model, counted as
 * the add-on's AI use, and offered on the main agent's Home; the agent's edits are read again by the model; a
 * milestone the business turned off brings nothing.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  commands,
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import type { ScriptRule } from '@hfos/ai';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { checkWords } from '@hfos/core/addons/realestate/fair-housing';
import { clientUpdatePrompt } from '@hfos/core/addons/realestate/prompts';
import { scriptedAi, scriptedClientUpdate, unquote } from '../src/ai/scripted';
import { attentionJobs, withAttention } from '../src/attention/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { pushJobs } from '../src/push/send';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!, ...commands].find((c) => c.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(api(), op(name) as CommandDef, { workspaceId: ws, ...input }, human(who), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output);
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(who), {
    correlationId: randomUUID(),
    channel: 'test',
  });

/** The stand-in model: a draft that says too much, and a reader that notices. */
const RULES: ScriptRule[] = [
  {
    when: /Write the client update\./,
    json: (q) => ({
      subject: 'Your home is under contract',
      body: `Hi ${/"clientFirstName": "([^"]+)"/.exec(unquote(q))?.[1] ?? 'there'}, great news: the seller accepted. It’s a safe neighborhood too. Sam`,
    }),
  },
  {
    when: /Check this email for fair housing risk\./,
    json: (q) => ({
      flags: /safe neighborhood/.test(q)
        ? [
            {
              phrase: 'safe neighborhood',
              category: 'steering',
              reason: 'Safety claims can steer buyers by who lives there.',
              safer: 'Point to the police department’s crime map.',
            },
          ]
        : [],
    }),
  },
];

const handlers = withAddons(withAttention({}));
const jobs = { ...attentionJobs, ...pushJobs, ...addonJobs };

let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let ws: string;
let deal: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-updates-${randomUUID().slice(0, 8)}`;
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
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()
            and kind <> 'realestate.sweep'`,
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

const draftsOf = () =>
  rows<{
    id: string;
    milestone: string;
    status: string;
    subject: string | null;
    body: string | null;
  }>(
    admin(),
    sql`select id, milestone, status, subject, body from addon_realestate.drafts
        where deal_record_id = ${deal} order by requested_at`,
  );

beforeAll(async () => {
  s = testServices({ ai: { provider: scriptedAi(RULES), dailyTokens: 5_000_000 } });
  [owner, agent] = await Promise.all([createTestUser('rup-owner'), createTestUser('rup-agent')]);
  ws = await realestateBusiness(owner, 'Orchard Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Priya', lastName: 'Shah', email: 'priya@example.com' },
      human(agent),
      { correlationId: randomUUID(), channel: 'test' },
    )
  ).output.personId;
  deal = (
    await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Orchard purchase',
      clientPersonId: client,
    })
  ).dealId;
  await drain();
}, 90_000);

afterAll(closeTestDbs);

describe('Client updates', () => {
  it('are drafted at a milestone, checked twice, and offered to the agent', async () => {
    await run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'under_contract' });
    await drain();
    const [draft] = await draftsOf();
    expect(draft).toMatchObject({
      milestone: 'under_contract',
      status: 'ready',
      subject: 'Your home is under contract',
    });
    expect(draft!.body).toContain('Hi Priya');
    const got = await ask(agent, 'realestate.status_email.get', { draftId: draft!.id });
    expect(got).toMatchObject({ checking: false, canSend: false });
    expect(got.flags.map((f: Any) => f.phrase)).toEqual(['safe neighborhood']);
    expect(got.checks.map((c: Any) => [c.source, c.status]).sort()).toEqual([
      ['model', 'flagged'],
      ['words', 'flagged'],
    ]);
    // The model's use is the add-on's.
    const [used] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage
          where workspace_id = ${ws} and source = 'addon' and addon_id = 'realestate'`,
    );
    expect(used!.n).toBeGreaterThanOrEqual(2);
    // On the main agent's Home until it's sent or thrown away.
    const [card] = await rows<{ cleared: boolean }>(
      admin(),
      sql`select cleared_at is not null as cleared from app.addon_alerts
          where workspace_id = ${ws} and key = ${`draft:${draft!.id}`}`,
    );
    expect(card).toEqual({ cleared: false });
  });

  it('reads the agent’s edits again, and goes when they’re clean', async () => {
    const [draft] = await draftsOf();
    await run(agent, 'realestate.status_email.save', {
      draftId: draft!.id,
      subject: 'Your home is under contract',
      body: 'Hi Priya, great news: the seller accepted. Next is the inspection. Sam',
    });
    await drain();
    const got = await ask(agent, 'realestate.status_email.get', { draftId: draft!.id });
    expect(got).toMatchObject({ checking: false, canSend: true, flags: [] });
    await run(agent, 'realestate.status_email.send', { draftId: draft!.id });
    await drain();
    const [card] = await rows<{ cleared: boolean }>(
      admin(),
      sql`select cleared_at is not null as cleared from app.addon_alerts
          where workspace_id = ${ws} and key = ${`draft:${draft!.id}`}`,
    );
    expect(card).toEqual({ cleared: true });
  });

  it('are written by the local stand-in from the deal’s facts, with nothing the word list flags', () => {
    const { subject, body } = scriptedClientUpdate(
      clientUpdatePrompt({
        business: 'Orchard Realty',
        agentName: 'Sam Rivera',
        clientFirstName: 'Priya',
        clientIs: 'buying',
        address: '12 Elm St',
        stage: 'Under contract',
        milestone: 'under_contract',
        confirmedDates: [{ what: 'Closing', when: 'Friday, October 30' }],
        done: ['Earnest money delivered'],
        next: [{ what: 'Home inspection', due: 'Monday, October 5' }],
      }),
    );
    expect(subject).toBe('An update on 12 Elm St');
    expect(body).toMatch(/^Hi Priya,/);
    expect(body).toContain('Home inspection by Monday, October 5');
    expect(body.trim().split('\n').at(-1)).toBe('Sam');
    expect(checkWords(`${subject}\n${body}`)).toEqual([]);
  });

  it('skip a milestone the business turned off', async () => {
    await run(owner, 'addon.save_settings', {
      addonId: 'realestate',
      settings: {
        milestoneDrafts: {
          under_contract: true,
          inspection_done: true,
          clear_to_close: false,
          closed: true,
        },
      },
    });
    await run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'closing' });
    await drain();
    expect((await draftsOf()).map((d) => d.milestone)).toEqual(['under_contract']);
  });
});
