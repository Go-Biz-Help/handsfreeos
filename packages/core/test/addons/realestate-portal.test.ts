/**
 * Real Estate Agent, round two, step 12: the client's tasks and their portal. Two co-buyers, each signed in on their
 * own: each sees their deal in their own words and only their own tasks (and the ones for both); a sign-off needs
 * each of them, word for word; an upload finishes its task and becomes a deal document; homes saved or passed and
 * feedback are each one's own; and nothing of another client's deal is theirs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientStep, taskDone, waitingWords } from '../../src/addons/realestate/client-words';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

describe('the client’s words', () => {
  it('puts a deal on the client’s five steps', () => {
    expect([
      clientStep('buyer', 'touring'),
      clientStep('buyer', 'inspections'),
      clientStep('listing', 'withdrawn'),
    ]).toEqual([1, 3, -1]);
  });
  it('waits on each co-buyer for a sign-off, and on one of them for anything else', () => {
    const clients = [
      { id: 'l', firstName: 'Linh' },
      { id: 't', firstName: 'Tuan' },
    ];
    const signOff = { kind: 'sign_off' as const, forPersonId: null };
    expect(waitingWords(signOff, clients, [])).toBe('Waiting on Linh and Tuan');
    expect(waitingWords(signOff, clients, ['l'])).toBe('Waiting on Tuan');
    expect(taskDone(signOff, ['l', 't'], ['l'])).toBe(false);
    expect(taskDone({ kind: 'upload', forPersonId: null }, ['l', 't'], ['t'])).toBe(true);
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const portalMeta = () => ({ correlationId: randomUUID(), channel: 'portal' as const });
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
const run = (name: string, input: Record<string, unknown>, who: TestUser = agent): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());
const asClient = (who: CustomerActor) => ({
  ask: (name: string, input: Record<string, unknown> = {}): Promise<Any> =>
    executeQuery(worker(), op(name) as QueryDef, { workspaceId: ws, ...input }, who, portalMeta()),
  run: (name: string, input: Record<string, unknown>): Promise<Any> =>
    executeCommand(
      worker(),
      op(name) as CommandDef,
      { workspaceId: ws, ...input },
      who,
      portalMeta(),
    ).then((r) => r.output),
});
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string };
    return err.rule ?? err.code ?? String(e);
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let deal: string;
let otherDeal: string;
let linhId: string;
let tuanId: string;
let linh: ReturnType<typeof asClient>;
let tuan: ReturnType<typeof asClient>;

async function person(firstName: string): Promise<string> {
  return (
    await executeCommand(
      api(),
      personCreate,
      {
        workspaceId: ws,
        firstName,
        lastName: 'Nguyen',
        email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
      },
      human(agent),
      meta(),
    )
  ).output.personId;
}

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
  const sent = (
    await executeCommand(worker(), portalSendCode, { workspaceId: ws, accessId }, scope, meta())
  ).output;
  const hit = (
    await executeCommand(
      worker(),
      portalCheckCode,
      {
        workspaceId: ws,
        accessId,
        code: sent.code,
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

/** A file the client uploaded to the deal from their portal. */
async function uploaded(by: string, name: string): Promise<string> {
  const [f] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, name, mime_type, size_bytes, status,
          object_path, uploaded_by_person_id)
        values (${ws}, 'custom_record', ${deal}, ${name}, 'application/pdf', 2048, 'ready',
          ${`${ws}/${randomUUID()}`}, ${by})
        returning id`,
  );
  return f!.id;
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rpo-owner'),
    createTestUser('rpo-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Portal Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  linhId = await person('Linh');
  tuanId = await person('Tuan');
  const omar = await person('Omar');
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: linhId,
      stage: 'touring',
    })
  ).dealId;
  await run('realestate.party.add', { dealId: deal, role: 'client', personId: tuanId });
  otherDeal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Omar purchase',
      clientPersonId: omar,
    })
  ).dealId;
  linh = asClient(await signIn(linhId));
  tuan = asClient(await signIn(tuanId));
}, 120_000);

afterAll(closeTestDbs);

let preapproval: string;
let signOff: string;
let photo: string;

describe('the client’s tasks', () => {
  it('are each client’s own, and the ones for both', async () => {
    preapproval = (await run('realestate.client_task.add', { dealId: deal, preset: 'preapproval' }))
      .taskId;
    signOff = (await run('realestate.client_task.add', { dealId: deal, preset: 'repair_sign_off' }))
      .taskId;
    photo = (
      await run('realestate.client_task.add', {
        dealId: deal,
        preset: 'photo_id',
        forPersonId: tuanId,
      })
    ).taskId;
    const mine = await linh.ask('realestate.portal.deals');
    expect(mine.deals).toEqual([
      expect.objectContaining({
        name: 'Nguyen purchase',
        stage: 'Touring homes',
        step: 1,
        agentName: 'Dana Reyes',
        openTasks: 2,
      }),
    ]);
    const { tasks } = await tuan.ask('realestate.portal.deal', { dealId: deal });
    expect(tasks.map((t: { title: string }) => t.title)).toEqual([
      'Upload your preapproval letter',
      'Sign off on the repair request',
      'Upload your photo ID',
    ]);
    expect(tasks[1].signOffWords).toBe('We’ve read the repair request and want Dana to send it.');
  });

  it('need each co-buyer’s own sign-off, on the exact words', async () => {
    expect(
      await refused(
        linh.run('realestate.portal.task.complete', { taskId: signOff, signedWords: 'We agree.' }),
      ),
    ).toBe('realestate_sign_off_changed');
    const words = 'We’ve read the repair request and want Dana to send it.';
    expect(
      await linh.run('realestate.portal.task.complete', { taskId: signOff, signedWords: words }),
    ).toEqual({
      taskId: signOff,
      status: 'open',
    });
    const staff = await ask('realestate.client_tasks', { dealId: deal });
    expect(staff.tasks.find((t: { id: string }) => t.id === signOff)).toMatchObject({
      waiting: 'Waiting on Tuan',
      completions: [
        expect.objectContaining({ name: 'Linh Nguyen', signedWords: words, recordedBy: null }),
      ],
    });
    expect(
      await refused(
        run('realestate.client_task.mark_done', {
          taskId: signOff,
          personId: tuanId,
          note: 'He said yes',
        }),
      ),
    ).toBe('realestate_sign_off_own');
    expect(
      await tuan.run('realestate.portal.task.complete', { taskId: signOff, signedWords: words }),
    ).toMatchObject({
      status: 'done',
    });
    expect(staff.clients.map((c: { name: string; portal: string }) => [c.name, c.portal])).toEqual([
      ['Linh Nguyen', 'signed_in'],
      ['Tuan Nguyen', 'signed_in'],
    ]);
  });

  it('finish an upload with the client’s own file, which becomes one of the deal’s documents', async () => {
    const theirs = await uploaded(tuanId, 'tuan.pdf');
    expect(
      await refused(
        linh.run('realestate.portal.task.attach', { taskId: preapproval, fileId: theirs }),
      ),
    ).toBe('not_found');
    const file = await uploaded(linhId, 'preapproval.pdf');
    expect(
      await linh.run('realestate.portal.task.attach', { taskId: preapproval, fileId: file }),
    ).toMatchObject({
      status: 'done',
    });
    const [doc] = await rows<{ kind: string; title: string }>(
      admin(),
      sql`select kind, title from addon_realestate.documents where deal_record_id = ${deal} and file_id = ${file}`,
    );
    expect(doc).toEqual({ kind: 'preapproval', title: 'preapproval.pdf' });
    // Linh can't see, or finish, Tuan's own task.
    expect(
      await refused(linh.run('realestate.portal.task.attach', { taskId: photo, fileId: file })),
    ).toBe('not_found');
    expect(
      await run('realestate.client_task.mark_done', {
        taskId: photo,
        personId: tuanId,
        note: 'Brought it to the office',
      }),
    ).toMatchObject({ status: 'done' });
  });
});

describe('homes and tours in the portal', () => {
  it('each co-buyer saves or passes on their own', async () => {
    const { homeId } = await linh.run('realestate.portal.home.add', {
      dealId: deal,
      address: '418 Maple Ave, Austin, TX',
      link: 'https://listings.example.com/418',
    });
    expect(
      await refused(
        tuan.run('realestate.portal.home.add', {
          dealId: deal,
          address: '418 maple ave austin tx',
        }),
      ),
    ).toBe('realestate_home_already');
    await tuan.run('realestate.portal.home.react', {
      homeId,
      reaction: 'passed',
      note: 'Too far from work',
    });
    const seen = await linh.ask('realestate.portal.deal', { dealId: deal });
    expect(seen.homes).toEqual([
      expect.objectContaining({
        address: '418 Maple Ave, Austin, TX',
        addedByMe: true,
        mine: 'saved',
        others: [{ name: 'Tuan', reaction: 'passed' }],
      }),
    ]);
    const staff = (await ask('realestate.homes', { dealId: deal })).homes[0];
    expect(staff).toMatchObject({ source: 'client', addedByClient: { id: linhId } });
  });

  it('take feedback only on a home seen, each client’s own', async () => {
    const [home] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_realestate.homes where deal_record_id = ${deal}`,
    );
    const [t] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_realestate.tours (workspace_id, deal_record_id, starts_at, ends_at, status)
          values (${ws}, ${deal}, now() - interval '2 hours', now() - interval '1 hour', 'done') returning id`,
    );
    const [s] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_realestate.tour_stops (workspace_id, deal_record_id, tour_id, home_id, position, status)
          values (${ws}, ${deal}, ${t!.id}, ${home!.id}, 1, 'planned') returning id`,
    );
    expect(
      await refused(
        linh.run('realestate.portal.tour.feedback', { stopId: s!.id, interest: 'love' }),
      ),
    ).toBe('realestate_tour_not_seen');
    await admin().execute(
      sql`update addon_realestate.tour_stops set status = 'visited', visited_at = now() where id = ${s!.id}`,
    );
    await linh.run('realestate.portal.tour.feedback', {
      stopId: s!.id,
      interest: 'love',
      rating: 5,
      words: 'The kitchen!',
    });
    await tuan.run('realestate.portal.tour.feedback', { stopId: s!.id, interest: 'no' });
    const mine = await linh.ask('realestate.portal.deal', { dealId: deal });
    expect(mine.tours[0].stops[0].myFeedback).toEqual({
      interest: 'love',
      rating: 5,
      words: 'The kitchen!',
    });
    const staff = (await ask('realestate.tours', { dealId: deal })).tours[0].stops[0].feedback;
    expect(
      staff.map((f: { interest: string; recordedBy: unknown }) => [f.interest, f.recordedBy]),
    ).toEqual(
      expect.arrayContaining([
        ['love', null],
        ['no', null],
      ]),
    );
  });
});

describe('another client’s deal', () => {
  it('isn’t in the portal at all', async () => {
    expect(await refused(linh.ask('realestate.portal.deal', { dealId: otherDeal }))).toBe(
      'not_found',
    );
    expect(
      await refused(
        linh.run('realestate.portal.home.add', {
          dealId: otherDeal,
          address: '1 Elm St, Austin, TX',
        }),
      ),
    ).toBe('not_found');
    expect(
      (await linh.ask('realestate.portal.deals')).deals.map((d: { name: string }) => d.name),
    ).toEqual(['Nguyen purchase']);
  });
});
