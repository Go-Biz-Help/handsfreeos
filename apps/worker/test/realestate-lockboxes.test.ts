/**
 * Real Estate Agent, round seven, step 4, in the worker: lockboxes (Chris, 2026-10-05: read their emails, guard
 * codes).
 *
 * - A lockbox's code is kept sealed: the command takes it only sealed, no person's role reads it back, and the deal's
 *   history says it was set, never what it is.
 * - The access email just before a showing names each lockbox, and the stored email keeps the code's marker: the
 *   code goes in only as it's sent.
 * - SentriLock's and Supra's "opened" emails are read into the listing (by serial, then address). One that fits a
 *   booked showing joins it; one that doesn't tells the listing's agents.
 * - A code shown again is kept in the deal's history.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  addonSealedViewed,
  emailReceive,
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { asUser, asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { readLockboxEmail } from '../src/addons/realestate/lockbox-emails';
import { sealFor, withSealedParts } from '../src/addons/sealed';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { systemActor } from '../src/services';
import { testServices, type TestServices } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
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
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = (name: string, input: Record<string, unknown>): Promise<Any> => {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        api(),
        found as CommandDef,
        { workspaceId: ws, ...input },
        human(agent),
        meta(),
      ).then((r) => r.output as Any)
    : (executeQuery(
        api(),
        found as QueryDef,
        { workspaceId: ws, ...input },
        human(agent),
        meta(),
      ) as Promise<Any>);
};

const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let deal: string;
const BOX = randomUUID();
const ANA = `ana-${randomUUID().slice(0, 6)}@compass.example`;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-lockbox-${randomUUID().slice(0, 8)}`;
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
const sealed = (code: string) =>
  sealFor(s.sealer, { workspaceId: ws, addonId: 'realestate', key: 'lockbox_code' }, code);
const alert = async (openingId: string) =>
  (
    await rows<{ title: string; detail: string }>(
      admin(),
      sql`select title, detail from app.addon_alerts where workspace_id = ${ws} and key = ${`lockbox:${openingId}`}`,
    )
  )[0];
const receive = (from: string, subject: string, bodyText: string) =>
  executeCommand(
    testDbs().worker.db,
    emailReceive,
    {
      workspaceId: ws,
      provider: 'fake',
      providerMessageId: randomUUID(),
      messageIdHeader: `<${randomUUID()}@lockbox.example>`,
      from: { address: from },
      to: [{ address: 'dana@lockbox-worker.example' }],
      subject,
      bodyText,
      reminderAfterMs: 86_400_000,
    },
    { type: 'system', workspaceId: ws, organizationId: org },
    { correlationId: randomUUID(), channel: 'worker' },
  );
const sentrilock = (serial: string, when: string, who = 'Sam Ortiz') =>
  [
    'Lockbox Access Notification',
    'Your lockbox has been accessed.',
    'Property Address: 2207 Juniper Trail, Austin, TX 78704',
    `Lockbox Serial Number: ${serial}`,
    `Accessed By: ${who}`,
    'Company: Keller Williams',
    'Phone: (512) 555-0144',
    `Date/Time: ${when}`,
  ].join('\n');

beforeAll(async () => {
  s = testServices();
  [owner, agent] = await Promise.all([
    createTestUser('wlb-owner'),
    createTestUser('wlb-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Lockbox Worker Realty');
  [{ organization_id: org }] = (await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  )) as [{ organization_id: string }];
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${agent.id}, 'member')`,
  );
  const maria = (
    await executeCommand(
      api(),
      personCreate,
      {
        workspaceId: ws,
        firstName: 'Maria',
        lastName: 'Alvarez',
        email: `m-${randomUUID().slice(0, 6)}@example.com`,
      },
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
  await drain();
}, 120_000);
afterAll(closeTestDbs);

describe('reading a lockbox maker’s emails', () => {
  it('reads SentriLock’s labels and Supra’s sentence, and leaves anything else', () => {
    expect(
      readLockboxEmail(
        'notifications@sentrilock.com',
        'Lockbox Access Notification',
        sentrilock('12345678', '10/05/2026 02:14 PM'),
      ),
    ).toEqual({
      vendor: 'sentrilock',
      address: '2207 Juniper Trail, Austin, TX 78704',
      serial: '12345678',
      date: '2026-10-05',
      clock: '14:14',
      openedBy: 'Sam Ortiz',
      company: 'Keller Williams',
      phone: '(512) 555-0144',
    });
    expect(
      readLockboxEmail(
        'noreply@supraekey.com',
        'Supra showing notification',
        'Your KeyBox (S/N 87654321) at 2207 Juniper Trail was opened by Ana Ruiz of Compass on 10/5/2026 at 2:14 PM.',
      ),
    ).toMatchObject({
      vendor: 'supra',
      serial: '87654321',
      address: '2207 Juniper Trail',
      openedBy: 'Ana Ruiz',
      company: 'Compass',
      date: '2026-10-05',
      clock: '14:14',
    });
    expect(
      readLockboxEmail(
        'notifications@sentrilock.com',
        'Low battery',
        'Lockbox Serial Number: 1234\nThe battery is low.',
      ),
    ).toBeNull();
    expect(readLockboxEmail('dana@example.com', 'Lunch?', 'Accessed By: me')).toBeNull();
  });
});

describe('a lockbox’s code', () => {
  it('is taken only sealed, and never read back by a person or written in the history', async () => {
    await expect(
      run('realestate.lockbox.save', { dealId: deal, id: BOX, kind: 'sentrilock', code: '7392' }),
    ).rejects.toThrow();
    const saved = await run('realestate.lockbox.save', {
      dealId: deal,
      id: BOX,
      kind: 'sentrilock',
      place: 'On the side gate',
      serial: '12345678',
      code: sealed('7392'),
    });
    expect(saved.lockbox).toMatchObject({
      kind: 'sentrilock',
      hasCode: true,
      place: 'On the side gate',
    });
    expect(JSON.stringify(await run('realestate.lockbox.list', { dealId: deal }))).not.toMatch(
      /7392|sealed:/,
    );
    await expect(
      asUser(api(), agent.claims, (tx) =>
        rows(tx, sql`select code_enc from addon_realestate.lockboxes`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const history = await rows<{ what: string; after: unknown }>(
      admin(),
      sql`select what, after from addon_realestate.deal_history where deal_record_id = ${deal} and what like 'lockbox%'`,
    );
    expect(history.map((h) => h.what)).toEqual(['lockbox_added']);
    expect(JSON.stringify(history)).not.toMatch(/7392|sealed:/);
    expect((history[0]!.after as Record<string, unknown>)['code']).toBe('set');
  });

  it('goes to the confirmed agent just before, kept locked in the stored email until it’s sent', async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const added = await run('realestate.showing.add', {
      dealId: deal,
      startsAt,
      minutes: 30,
      agentName: 'Ana Ruiz',
      brokerage: 'Compass',
      agentEmail: ANA,
    });
    if (added.state === 'requested')
      await run('realestate.showing.decide', { showingId: added.showingId, decision: 'confirm' });
    await drain();
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where status = 'pending' and workspace_id = ${ws} and kind = 'realestate.showing_access'`,
    );
    await drain();
    const [m] = await rows<{ id: string; body: string }>(
      admin(),
      sql`select m.id, m.body_text as body from app.messages m join app.conversations c on c.id = m.conversation_id
          where m.workspace_id = ${ws} and m.direction = 'outbound' and lower(c.counterpart) = ${ANA}
            and m.subject like 'How to get into%'`,
    );
    expect(m!.body).toContain('SentriLock (On the side gate): [Lockbox code, kept locked]');
    expect(m!.body).not.toContain('7392');
    // What the provider gets: the code in place, put in by the worker as it sends.
    const out = await asWorker(
      testDbs().worker.db,
      { workspaceId: ws, organizationId: org },
      (tx) => withSealedParts(tx, s.sealer, ws, m!.id, m!.body),
    );
    expect(out.body).toContain('SentriLock (On the side gate): 7392');
  });

  it('shown again is kept in the deal’s history', async () => {
    await executeCommand(
      testDbs().worker.db,
      addonSealedViewed,
      {
        workspaceId: ws,
        addonId: 'realestate',
        key: 'lockbox_code',
        recordId: deal,
        itemId: BOX,
        viewedBy: agent.id,
      },
      systemActor({ workspaceId: ws, organizationId: org }, agent.id),
      meta(),
    );
    await drain();
    const [line] = await rows<{ after: Record<string, unknown> }>(
      admin(),
      sql`select after from addon_realestate.deal_history where deal_record_id = ${deal} and what = 'lockbox_code_viewed'`,
    );
    expect(line!.after).toMatchObject({ kind: 'sentrilock', viewedBy: agent.id });
  });
});

describe('a lockbox opened', () => {
  it('during a booked showing joins it, and tells nobody', async () => {
    const [showing] = await rows<{ id: string; starts_at: Date }>(
      admin(),
      sql`select id, starts_at from addon_realestate.showings where deal_record_id = ${deal}`,
    );
    const at = new Date(showing!.starts_at);
    const local = at.toLocaleString('en-US', {
      timeZone: (
        await rows<{ tz: string }>(
          admin(),
          sql`select timezone as tz from app.workspaces where id = ${ws}`,
        )
      )[0]!.tz,
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    await receive(
      'notifications@sentrilock.com',
      'Lockbox Access Notification',
      sentrilock('12345678', local.replace(',', ''), 'Ana Ruiz'),
    );
    await drain();
    const { openings } = await run('realestate.lockbox.list', { dealId: deal });
    expect(openings[0]).toMatchObject({
      booked: true,
      showingId: showing!.id,
      lockboxId: BOX,
      openedBy: 'Ana Ruiz',
    });
    expect(await alert(openings[0].id)).toBeUndefined();
  });

  it('with no showing booked tells the listing’s agents, once', async () => {
    const email = sentrilock('12345678', '01/03/2026 03:05 AM');
    await receive('notifications@sentrilock.com', 'Lockbox Access Notification', email);
    await drain();
    const { openings } = await run('realestate.lockbox.list', { dealId: deal });
    const night = openings.find((o: Any) => !o.booked);
    expect(night).toMatchObject({
      booked: false,
      openedBy: 'Sam Ortiz',
      company: 'Keller Williams',
    });
    expect(await alert(night.id)).toMatchObject({
      title: 'The lockbox at Alvarez listing was opened with no showing booked',
      detail: expect.stringMatching(
        /^Sam Ortiz of Keller Williams opened it .+, as SentriLock’s email says\. /,
      ),
    });
  });

  it('is left alone when the business turned reading them off', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set settings = settings || '{"lockboxEmails": false}'::jsonb
          where workspace_id = ${ws} and addon_id = 'realestate'`,
    );
    const before = (await run('realestate.lockbox.list', { dealId: deal })).openings.length;
    await receive(
      'notifications@sentrilock.com',
      'Lockbox Access Notification',
      sentrilock('12345678', '01/04/2026 03:05 AM'),
    );
    await drain();
    expect((await run('realestate.lockbox.list', { dealId: deal })).openings).toHaveLength(before);
  });
});
