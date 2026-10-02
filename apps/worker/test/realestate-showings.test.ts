/**
 * Real Estate Agent, round five, step 8, in the worker: who hears what about a showing of our listing, and when.
 *
 * - Asked for on the page: the listing agent gets a card, the seller an email to answer in their portal.
 * - Confirmed: the buyer's agent hears; the access instructions go to them alone just before, and a feedback link
 *   after, whose answer the AI groups into themes with only their own words.
 * - Turned down: the buyer's agent hears, with the page to pick another time.
 * - ShowingTime's emails become showings and feedback to check; nothing is emailed for those.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ScriptRule } from '@hfos/ai';
import {
  ADDON_SERVER_MODULES,
  emailReceive,
  executeCommand,
  executeQuery,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type PublicActor,
  type QueryDef,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { requestCardKey } from '../src/addons/realestate/showings';
import { readShowingTimeEmail } from '../src/addons/realestate/showingtime';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
const meta = (channel: 'test' | 'booking_page' | 'portal' | 'worker' = 'test') => ({
  correlationId: randomUUID(),
  channel,
});
const runAs = (
  actor: Any,
  db: Any,
  name: string,
  input: Record<string, unknown>,
  channel?: Any,
) => {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        db,
        found as CommandDef,
        { workspaceId: ws, ...input },
        actor,
        meta(channel),
      ).then((r) => r.output as Any)
    : (executeQuery(
        db,
        found as QueryDef,
        { workspaceId: ws, ...input },
        actor,
        meta(channel),
      ) as Promise<Any>);
};
const run = (name: string, input: Record<string, unknown>) =>
  runAs(human(agent), api(), name, input);
const visitor = (): PublicActor => ({
  type: 'public',
  workspaceId: ws,
  organizationId: org,
  site: SITE,
  visitor: 'hmac',
});
const asVisitor = (name: string, input: Record<string, unknown>) =>
  runAs(visitor(), worker(), name, { slug: '2207-juniper-trail', ...input }, 'booking_page');

/** What a buyer's agent's words were grouped into: one theme each way, and a quote nobody wrote. */
const RULES: ScriptRule[] = [
  {
    when: /Group what buyers said into themes\.$/,
    json: () => ({
      liked: [
        {
          theme: 'The patio and the oaks',
          count: 9,
          quotes: ['Loved the patio and the big oaks.', 'Best backyard in Austin!'],
        },
      ],
      disliked: [
        { theme: 'Kitchen size', count: 1, quotes: ['Kitchen felt small for the price.'] },
      ],
    }),
  },
];

const handlers = withAddons({});
const jobs = { ...addonJobs };
const SITE = `showings-${randomUUID().slice(0, 8)}`;

let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let deal: string;
let maria: string;
let mariaEmail: string;
let seller: CustomerActor;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-showings-${randomUUID().slice(0, 8)}`;
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
/** A job of the add-on's, due now. */
async function due(kind: string) {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where status = 'pending' and workspace_id = ${ws} and kind = ${kind}`,
  );
  await drain();
}
const sent = (to: string) =>
  rows<{ subject: string; body: string }>(
    admin(),
    sql`select m.subject, m.body_text as body from app.messages m
        join app.conversations c on c.id = m.conversation_id
        where m.workspace_id = ${ws} and m.direction = 'outbound' and m.channel = 'email'
          and lower(c.counterpart) = ${to.toLowerCase()}
        order by m.created_at`,
  );
const card = async (key: string) =>
  (
    await rows<{ title: string; detail: string; cleared: boolean }>(
      admin(),
      sql`select title, detail, cleared_at is not null as cleared from app.addon_alerts
          where workspace_id = ${ws} and key = ${key}`,
    )
  )[0];

async function signIn(personId: string): Promise<CustomerActor> {
  const scope = { type: 'system' as const, workspaceId: ws, organizationId: org };
  const { accessId } = (
    await executeCommand(
      api(),
      portalAccessGive,
      { workspaceId: ws, personId },
      human(owner),
      meta(),
    )
  ).output;
  const code = (
    await executeCommand(worker(), portalSendCode, { workspaceId: ws, accessId }, scope, meta())
  ).output;
  const hit = (
    await executeCommand(
      worker(),
      portalCheckCode,
      {
        workspaceId: ws,
        accessId,
        code: code.code,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      },
      scope,
      meta(),
    )
  ).output;
  return {
    type: 'customer',
    workspaceId: ws,
    organizationId: org,
    personId,
    sessionId: hit.sessionId!,
  };
}

const ANA = {
  agentName: 'Ana Ruiz',
  brokerage: 'Compass',
  license: '0712345',
  email: `ana-${randomUUID().slice(0, 6)}@compass.example`,
};

beforeAll(async () => {
  s = testServices({ ai: { provider: scriptedAi(RULES), dailyTokens: 5_000_000 } });
  [owner, agent] = await Promise.all([
    createTestUser('wsh-owner'),
    createTestUser('wsh-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Showing Worker Realty');
  [{ organization_id: org }] = (await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  )) as [{ organization_id: string }];
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${agent.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into app.booking_sites (workspace_id, slug, name) values (${ws}, ${SITE}, 'Showing Worker Realty')`,
  );
  mariaEmail = `maria-${randomUUID().slice(0, 6)}@example.com`;
  maria = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Maria', lastName: 'Alvarez', email: mariaEmail },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run('realestate.deal.open', {
      side: 'listing',
      name: 'Alvarez listing',
      stage: 'active',
      clientPersonId: maria,
      newPropertyAddress: '2207 Juniper Trail, Austin, TX 78704',
    })
  ).dealId;
  await run('realestate.showing.settings', {
    dealId: deal,
    from: '00:00',
    to: '23:30',
    access: 'Lockbox on the back door, code 4417.',
  });
  await rows(
    admin(),
    sql`update addon_realestate.listings set mls_number = '4821937', mls_live_on = current_date,
          slug = '2207-juniper-trail', page_state = 'published'
        where deal_record_id = ${deal}`,
  );
  seller = await signIn(maria);
  await drain();
}, 120_000);
afterAll(closeTestDbs);

describe('a showing asked for on the page', () => {
  let showing: string;

  it('puts a card on the listing agent’s Home and asks the seller by email to answer in their portal', async () => {
    const page = await asVisitor('realestate.public.showing_times', {});
    await asVisitor('realestate.public.request_showing', { ...ANA, startsAt: page.times[2] });
    await drain();
    showing = (await run('realestate.showing.list', { dealId: deal })).showings[0].id;
    expect(await card(requestCardKey(showing))).toMatchObject({
      title: expect.stringMatching(
        /^Showing request on 2207 Juniper Trail: Ana Ruiz \(Compass\), /,
      ),
      detail: 'Waiting on Maria in their portal. You can answer for them on Showings.',
      cleared: false,
    });
    const [ask] = await sent(mariaEmail);
    expect(ask!.subject).toMatch(/^A showing request for 2207 Juniper Trail: /);
    expect(ask!.body).toMatch(/Ana Ruiz \(Compass\) would like to show 2207 Juniper Trail/);
    expect(ask!.body).toMatch(/Say yes, no or another time in your portal: http\S+\/c\//);
  });

  it('once the seller says yes: the buyer’s agent hears, then gets how to get in and the feedback link', async () => {
    await runAs(
      seller,
      worker(),
      'realestate.portal.showing_answer',
      { showingId: showing, answer: 'yes' },
      'portal',
    );
    await drain();
    expect((await card(requestCardKey(showing)))!.cleared).toBe(true);
    const [confirmed] = await sent(ANA.email);
    expect(confirmed!.subject).toMatch(/^Confirmed: your showing of 2207 Juniper Trail, /);
    expect(confirmed!.body).toMatch(/How to get in comes by email 1 hour before/);
    // Nothing about getting in until just before.
    expect(JSON.stringify(await sent(ANA.email))).not.toContain('4417');
    const waiting = await rows<{ kind: string; run_at: Date }>(
      admin(),
      sql`select kind, run_at from app.scheduled_jobs
          where workspace_id = ${ws} and status = 'pending' and kind like 'realestate.showing_%'
          order by kind`,
    );
    expect(waiting.map((j) => j.kind)).toEqual([
      'realestate.showing_access',
      'realestate.showing_feedback',
    ]);

    await due('realestate.showing_access');
    const access = (await sent(ANA.email)).at(-1)!;
    expect(access.subject).toMatch(/^How to get into 2207 Juniper Trail for your showing, /);
    expect(access.body).toContain('Lockbox on the back door, code 4417.');
    // Only to that agent: the seller never got it.
    expect(JSON.stringify(await sent(mariaEmail))).not.toContain('4417');

    await due('realestate.showing_feedback');
    const ask = (await sent(ANA.email)).at(-1)!;
    expect(ask.subject).toBe('How did 2207 Juniper Trail show?');
    const link = /(\S+\/showing-feedback\/([A-Za-z0-9_-]{43}))/.exec(ask.body)!;
    expect(link[1]).toContain(`/a/${SITE}/realestate/2207-juniper-trail/showing-feedback/`);
    const list = await run('realestate.showing.list', { dealId: deal });
    expect(list.showings[0]).toMatchObject({ state: 'done', accessSentAt: expect.any(String) });

    // Their answer, from the link: a card for the agent, and buyers' words grouped, every quote theirs.
    await asVisitor('realestate.public.showing_feedback', {
      token: link[2],
      interest: 4,
      liked: 'Loved the patio and the big oaks.',
      pause: 'Kitchen felt small for the price.',
      price: 'high',
    });
    await drain();
    expect((await card(`showing_feedback:${showing}`))!.title).toBe(
      'Feedback on 2207 Juniper Trail from Ana Ruiz: 4 of 5',
    );
    await due('realestate.showing_themes');
    const themes = (await run('realestate.showing.list', { dealId: deal })).themes;
    expect(themes).toMatchObject({
      liked: [
        {
          theme: 'The patio and the oaks',
          count: 1,
          quotes: ['Loved the patio and the big oaks.'],
        },
      ],
      disliked: [{ theme: 'Kitchen size', quotes: ['Kitchen felt small for the price.'] }],
      likedWords: 'The patio and the oaks (1)',
    });
  });

  it('turned down, tells the buyer’s agent with the page to pick another time', async () => {
    const lee = `lee-${randomUUID().slice(0, 6)}@exp.example`;
    const page = await asVisitor('realestate.public.showing_times', {});
    await asVisitor('realestate.public.request_showing', {
      ...ANA,
      agentName: 'Lee Park',
      brokerage: 'eXp',
      email: lee,
      startsAt: page.times[6],
    });
    await drain();
    const id = (await run('realestate.showing.list', { dealId: deal })).showings.find(
      (x: Any) => x.agentName === 'Lee Park',
    ).id;
    await run('realestate.showing.decide', {
      showingId: id,
      decision: 'decline',
      note: 'The seller is away that day.',
    });
    await drain();
    const [no] = await sent(lee);
    expect(no!.subject).toMatch(/^Not that time: your showing of 2207 Juniper Trail, /);
    expect(no!.body).toContain('The seller is away that day.');
    expect(no!.body).toMatch(
      new RegExp(`Pick another time here: \\S+/a/${SITE}/realestate/2207-juniper-trail/showing`),
    );
  });
});

describe('ShowingTime’s emails', () => {
  const body = (more: string[]) =>
    [
      'Address: 2207 Juniper Trail, Austin, TX 78704',
      'Date: Friday, October 16, 2026',
      'Time: 1:30 PM - 2:00 PM',
      'Showing Agent: Sam Ortiz',
      'Agent Company: Keller Williams',
      'Agent Phone: (512) 555-0190',
      'Showing ID: 88812',
      ...more,
    ].join('\n');

  it('are read by their labels', () => {
    expect(readShowingTimeEmail('Showing Confirmed', body([]))).toMatchObject({
      kind: 'confirmed',
      address: '2207 Juniper Trail, Austin, TX 78704',
      date: '2026-10-16',
      from: '13:30',
      to: '14:00',
      agentName: 'Sam Ortiz',
      brokerage: 'Keller Williams',
      reference: '88812',
    });
    expect(
      readShowingTimeEmail(
        'Feedback Received',
        body([
          'Interest Level: 2 out of 5',
          'Price: Too high',
          'Comments: Price high for the area.',
        ]),
      )?.feedback,
    ).toEqual({ interest: 2, liked: null, pause: 'Price high for the area.', price: 'high' });
    expect(readShowingTimeEmail('Your weekly market report', body([]))).toBeNull();
  });

  it('become a showing to check, then its feedback, and nobody is emailed for them', async () => {
    const receive = (subject: string, text: string) =>
      executeCommand(
        worker(),
        emailReceive,
        {
          workspaceId: ws,
          provider: 'fake',
          providerMessageId: randomUUID(),
          messageIdHeader: `<${randomUUID()}@showingtime.com>`,
          from: { address: 'callcenter@showingtime.com' },
          to: [{ address: 'dana@showing-worker.example' }],
          subject,
          bodyText: text,
          reminderAfterMs: 86_400_000,
        },
        { type: 'system', workspaceId: ws, organizationId: org },
        meta('worker'),
      );
    await receive('Showing Confirmed', body([]));
    await drain();
    let sam = (await run('realestate.showing.list', { dealId: deal })).showings.find(
      (x: Any) => x.agentName === 'Sam Ortiz',
    );
    expect(sam).toMatchObject({
      source: 'showingtime',
      state: 'confirmed',
      checked: false,
      brokerage: 'Keller Williams',
      when: 'Fri, Oct 16 · 1:30 PM',
    });
    await receive(
      'Feedback Received',
      body(['Interest Level: 2 out of 5', 'Price: Too high', 'Comments: Price high for the area.']),
    );
    await drain();
    sam = (await run('realestate.showing.list', { dealId: deal })).showings.find(
      (x: Any) => x.id === sam.id,
    );
    expect(sam).toMatchObject({
      state: 'done',
      feedbackSource: 'showingtime',
      feedback: { interest: 2, price: 'high' },
    });
    // ShowingTime does its own asking: no jobs and no emails for it.
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs
          where workspace_id = ${ws} and status = 'pending' and payload->>'showingId' = ${sam.id}`,
    );
    expect(n!.n).toBe(0);
  });
});
