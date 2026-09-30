/**
 * Real Estate Agent's client updates (step 13): the fixed fair-housing list, a draft that can only go once its
 * words are checked and any flags are fixed or confirmed with a reason, edits that ask again, and a send through
 * core's message.send to the deal's client. The worker's half (drafting with the model) is stood in for here by its
 * own system commands.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWords, FAIR_HOUSING_WORDS_VERSION } from '../../src/addons/realestate/fair-housing';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { textHashOf } from '../../src/addons/realestate/ops/client-updates';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  ).then((r) => r.output);
/** The add-on's worker, as the system acting for it. */
const asAddon = (name: string, input: Record<string, unknown>): Promise<Any> => {
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: org,
    addon: { id: realestateAddon.id, name: realestateAddon.name, version: realestateAddon.version },
  };
  return executeCommand(
    testDbs().worker.db,
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    actor,
    meta(),
  ).then((r) => r.output);
};
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(who), meta());
async function refused(p: Promise<unknown>): Promise<{ rule: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string; message: string };
    return { rule: err.rule ?? err.code ?? '', message: err.message };
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;

beforeAll(async () => {
  [owner, agent] = await Promise.all([createTestUser('rcu-owner'), createTestUser('rcu-agent')]);
  ws = await realestateBusiness(owner, 'Meadow Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
}, 90_000);

afterAll(closeTestDbs);

describe('The fixed fair-housing list', () => {
  it('flags preferences and steering, each once, with why and a safer way', () => {
    const flags = checkWords(
      'Great news! It’s in a safe neighborhood with good schools, perfect for couples. Good schools nearby.',
    );
    expect(flags.map((f) => [f.phrase, f.category])).toEqual([
      ['safe neighborhood', 'steering'],
      ['good schools', 'steering'],
      ['perfect for couples', 'familial_status'],
    ]);
    expect(flags[0]!.safer).toMatch(/crime maps/);
  });

  it('leaves the home’s own words alone', () => {
    expect(
      checkWords(
        'Black granite counters, a family room, a white picket fence and step-free entry.',
      ),
    ).toEqual([]);
  });
});

describe('A client update', () => {
  let deal: string;

  beforeAll(async () => {
    deal = (await run(agent, 'realestate.deal.open', { side: 'buyer', name: 'Meadow purchase' }))
      .dealId;
  });

  it('needs a client with an email address', async () => {
    expect(
      (await refused(run(agent, 'realestate.status_email.request', { dealId: deal }))).rule,
    ).toBe('realestate_no_client_email');
  });

  it('goes only once its flags are fixed or confirmed, and edits ask again', async () => {
    const client = (
      await executeCommand(
        api(),
        personCreate,
        { workspaceId: ws, firstName: 'Priya', lastName: 'Shah', email: 'priya.shah@example.com' },
        human(agent),
        meta(),
      )
    ).output.personId;
    await run(agent, 'realestate.party.add', { dealId: deal, role: 'client', personId: client });
    const asked = await run(agent, 'realestate.status_email.request', { dealId: deal });
    expect(asked.status).toBe('drafting');
    // The worker writes it and checks it.
    const subject = 'An update on your home search';
    const body = 'Hi Priya, we found two homes near good schools. More soon. Sam';
    await asAddon('realestate.status_email.drafted', {
      draftId: asked.draftId,
      subject,
      body,
      model: 'scripted',
      facts: { clientFirstName: 'Priya' },
      checks: [
        {
          source: 'words',
          version: FAIR_HOUSING_WORDS_VERSION,
          status: 'flagged',
          flags: checkWords(`${subject}\n${body}`),
        },
        { source: 'model', version: 'scripted', status: 'passed', flags: [] },
      ],
    });
    let got = await ask(agent, 'realestate.status_email.get', { draftId: asked.draftId });
    expect(got).toMatchObject({ checking: false, canSend: false });
    expect(got.flags.map((f: Any) => f.phrase)).toEqual(['good schools']);
    const blocked = await refused(
      run(agent, 'realestate.status_email.send', { draftId: asked.draftId }),
    );
    expect(blocked.rule).toBe('realestate_fair_housing_flags');
    expect(blocked.message).toContain('“good schools”');
    // Fixing the words asks again: the list at once, the model a moment later.
    const saved = await run(agent, 'realestate.status_email.save', {
      draftId: asked.draftId,
      subject,
      body: 'Hi Priya, we found two homes in the district you asked about. More soon. Sam',
    });
    expect(saved.flags).toEqual([]);
    expect(
      (await refused(run(agent, 'realestate.status_email.send', { draftId: asked.draftId }))).rule,
    ).toBe('realestate_check_running');
    const [draft] = await rows<{ subject: string; body: string }>(
      admin(),
      sql`select subject, body from addon_realestate.drafts where id = ${asked.draftId}`,
    );
    await asAddon('realestate.status_email.checked', {
      draftId: asked.draftId,
      textHash: textHashOf(draft!.subject, draft!.body),
      version: 'scripted',
      status: 'flagged',
      flags: [
        {
          phrase: 'the district you asked about',
          category: 'steering',
          reason: 'Schools can stand in for who lives somewhere.',
          safer: 'Share the district’s own report.',
        },
      ],
    });
    got = await ask(agent, 'realestate.status_email.get', { draftId: asked.draftId });
    expect(got.flags.map((f: Any) => f.phrase)).toEqual(['the district you asked about']);
    await run(agent, 'realestate.status_email.acknowledge_flags', {
      draftId: asked.draftId,
      reason: 'Priya asked for homes in that district herself.',
    });
    const sent = await run(agent, 'realestate.status_email.send', { draftId: asked.draftId });
    expect(sent.status).toBe('sent');
    const [message] = await rows<{ channel: string; body: string; to: string }>(
      admin(),
      sql`select m.channel::text as channel, m.body_text as body, m.to_addresses::text as to from addon_realestate.drafts d
          join app.messages m on m.id = d.sent_message_id where d.id = ${asked.draftId}`,
    );
    expect(message).toMatchObject({ channel: 'email' });
    expect(message!.body).toContain('district you asked about');
    expect(message!.to).toContain('priya.shah@example.com');
    // Every check was kept.
    const checks = await ask(agent, 'realestate.status_email.get', { draftId: asked.draftId });
    expect(checks.checks.map((c: Any) => [c.source, c.status])).toEqual(
      expect.arrayContaining([
        ['words', 'flagged'],
        ['model', 'passed'],
        ['words', 'passed'],
        ['model', 'flagged'],
      ]),
    );
    expect(checks.acknowledged.reason).toBe('Priya asked for homes in that district herself.');
  });

  it('comes once per milestone, and can be thrown away', async () => {
    const first = await asAddon('realestate.status_email.request', {
      dealId: deal,
      milestone: 'under_contract',
    });
    const again = await asAddon('realestate.status_email.request', {
      dealId: deal,
      milestone: 'under_contract',
    });
    expect(again.draftId).toBe(first.draftId);
    await run(agent, 'realestate.status_email.discard', { draftId: first.draftId });
    const list = await ask(agent, 'realestate.status_email.list', { dealId: deal });
    expect(list.drafts.map((d: Any) => d.status)).toEqual(
      expect.arrayContaining(['sent', 'discarded']),
    );
  });
});
