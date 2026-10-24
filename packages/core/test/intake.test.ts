/**
 * Lead intake (M14 slice A): a stranger who texts, calls and doesn't get through, or emails becomes a
 * customer and an open lead without anybody typing them in — and the gates that keep the pipeline clean.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  callRecord,
  callUpdateStatus,
  emailReceive,
  intakeList,
  intakeSourceUpdate,
  messageReceive,
  organizationCreate,
  personCreate,
  phoneNumberActivate,
  phoneNumberBuy,
  pipelineCreate,
} from '../src/server';

const db = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(db(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), meta());
const system = (): SystemActor => ({ type: 'system', workspaceId: wsId, organizationId: orgId });
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, system(), meta()).then((r) => r.output);

const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const sid = () => `CAfake${randomUUID().slice(0, 8)}`;
let smsCounter = 0;
const smsId = () => `SMfake-${randomUUID().slice(0, 8)}-${smsCounter++}`;

/** The customer and the lead a number now has, if any. */
const leadFor = async (phone: string) =>
  (
    await rows<{
      person: string;
      first_name: string;
      person_source: string | null;
      lead: string | null;
      title: string | null;
      lead_source: string | null;
      stage: string | null;
    }>(
      admin(),
      sql`select p.id as person, p.first_name, p.source as person_source, l.id as lead, l.title,
            l.source as lead_source, s.name as stage
          from app.people p
          left join app.leads l on l.person_id = p.id and l.archived_at is null
          left join app.pipeline_stages s on s.id = l.stage_id
          where p.workspace_id = ${wsId} and p.phone_e164 = ${phone}`,
    )
  )[0] ?? null;

const personByEmail = async (address: string) =>
  (
    await rows<{ person: string; first_name: string; last_name: string; lead: string | null }>(
      admin(),
      sql`select p.id as person, p.first_name, p.last_name, l.id as lead
          from app.people p left join app.leads l on l.person_id = p.id
          where p.workspace_id = ${wsId} and p.email = ${address}`,
    )
  )[0] ?? null;

const conversationOf = async (id: string) =>
  (
    await rows<{ person_id: string | null; unread_count: number }>(
      admin(),
      sql`select person_id, unread_count from app.conversations where id = ${id}`,
    )
  )[0]!;

let owner: TestUser;
let orgId: string;
let wsId: string;
let businessNumber: string;
let accountId: string;

beforeAll(async () => {
  owner = await createTestUser('intake-owner');
  const org = await run(organizationCreate, { businessName: 'Intake Test Co' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  businessNumber = randomE164();
  const { phoneNumberId } = await run(
    phoneNumberBuy,
    { workspaceId: wsId, e164: businessNumber, numberType: 'local' },
    owner,
  );
  const [account] = await asWorker(
    testDbs().worker.db,
    { workspaceId: wsId, organizationId: orgId },
    (tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
          values (${wsId}, 'fake', ${`ACfake${randomUUID().slice(0, 8)}`}, 'active') returning id`,
      ),
  );
  accountId = account!.id;
  await sys(phoneNumberActivate, {
    workspaceId: wsId,
    phoneNumberId,
    providerSid: `PNfake${randomUUID().slice(0, 8)}`,
    accountId,
    capabilities: { sms: true, voice: true, mms: true },
  });
});
afterAll(closeTestDbs);

const text = (from: string, body: string) =>
  sys(messageReceive, {
    workspaceId: wsId,
    provider: 'fake',
    providerMessageId: smsId(),
    from,
    to: businessNumber,
    body,
  });

describe('a text from a number nobody knows', () => {
  const stranger = '+17135550199';

  it('opens a customer and a lead, and the conversation is theirs', async () => {
    const got = await text(stranger, 'Hi, my AC is out. Can someone come today?');
    const found = await leadFor(stranger);
    expect(found).toMatchObject({
      first_name: '(713) 555-0199',
      person_source: 'Text message',
      title: '(713) 555-0199 (texted in)',
      lead_source: 'Text message',
    });
    expect(found!.lead).not.toBeNull();
    expect(await conversationOf(got.conversationId)).toMatchObject({
      person_id: found!.person,
      unread_count: 1,
    });
  });

  it('opens nothing the second time they write', async () => {
    await text(stranger, 'Anyone there?');
    const [counted] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.leads l join app.people p on p.id = l.person_id
          where p.workspace_id = ${wsId} and p.phone_e164 = ${stranger}`,
    );
    expect(counted!.count).toBe(1);
  });

  it('leaves a STOP alone: an instruction is not a lead', async () => {
    const quiet = '+17135550177';
    await text(quiet, 'STOP');
    expect(await leadFor(quiet)).toBeNull();
  });

  it('leaves the business’s own number alone', async () => {
    await text(businessNumber, 'testing our own line');
    expect(await leadFor(businessNumber)).toBeNull();
  });
});

describe('what the business can change', () => {
  it('opens the customer without a lead when that is turned off', async () => {
    await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', createLead: false }, owner);
    const from = '+17135550155';
    await text(from, 'Do you do water heaters?');
    const found = await leadFor(from);
    expect(found).toMatchObject({ first_name: '(713) 555-0155', lead: null });
    await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', createLead: true }, owner);
  });

  it('opens nothing at all when the channel is off', async () => {
    await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', active: false }, owner);
    const from = '+17135550144';
    const got = await text(from, 'Quote please');
    expect(await leadFor(from)).toBeNull();
    // The message still reaches the inbox; nobody is added.
    expect(await conversationOf(got.conversationId)).toMatchObject({ person_id: null });
    await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', active: true }, owner);
  });

  it('lands the lead in the pipeline and stage it is pointed at', async () => {
    const { pipelineId } = await run(
      pipelineCreate,
      { workspaceId: wsId, name: 'New enquiries' },
      owner,
    );
    const [stage] = await rows<{ id: string; name: string }>(
      admin(),
      sql`select id, name from app.pipeline_stages where pipeline_id = ${pipelineId}
          and kind = 'open' order by position offset 1 limit 1`,
    );
    await run(
      intakeSourceUpdate,
      { workspaceId: wsId, kind: 'text', pipelineId, stageId: stage!.id },
      owner,
    );
    const from = '+17135550133';
    await text(from, 'Need a quote for a new unit');
    expect(await leadFor(from)).toMatchObject({ stage: stage!.name });
    await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', pipelineId: null }, owner);
  });

  it('stops at the day’s limit', async () => {
    await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', dailyCap: 1 }, owner);
    await rows(
      admin(),
      sql`update app.intake_sources set day_count = 0, day_on = null where workspace_id = ${wsId} and kind = 'text'`,
    );
    const first = '+17135550122';
    const second = '+17135550111';
    await text(first, 'One');
    await text(second, 'Two');
    expect(await leadFor(first)).not.toBeNull();
    expect(await leadFor(second)).toBeNull();
    await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', dailyCap: 50 }, owner);
  });

  it('reads back on the settings screen', async () => {
    const view = await ask(intakeList, { workspaceId: wsId }, owner);
    expect(view.sources.map((s) => s.kind)).toEqual([
      'text',
      'call',
      'email',
      'messenger',
      'instagram',
      'facebook_lead_ad',
    ]);
    const texting = view.sources.find((s) => s.kind === 'text')!;
    expect(texting).toMatchObject({ active: true, createLead: true, dailyCap: 50 });
    expect(texting.todayCount).toBeGreaterThan(0);
  });
});

describe('someone already in the customers', () => {
  it('is linked, and no second lead opens', async () => {
    const phone = '+17135550166';
    const { personId } = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Maria', lastName: 'Lopez', phone },
      owner,
    );
    const got = await text(phone, 'It’s Maria — can you come Friday?');
    expect(await conversationOf(got.conversationId)).toMatchObject({ person_id: personId });
    const found = await leadFor(phone);
    expect(found).toMatchObject({ person: personId, lead: null, first_name: 'Maria' });
  });
});

describe('a call nobody answered', () => {
  const caller = '+18325550101';

  const ring = async (from: string) => {
    const providerSid = sid();
    const { callId } = await sys(callRecord, {
      workspaceId: wsId,
      providerSid,
      direction: 'inbound',
      from,
      to: businessNumber,
      status: 'ringing',
    });
    return callId;
  };

  it('opens a customer and a lead when it is missed', async () => {
    const callId = await ring(caller);
    await sys(callUpdateStatus, { workspaceId: wsId, callId, status: 'no_answer' });
    const found = await leadFor(caller);
    expect(found).toMatchObject({
      first_name: '(832) 555-0101',
      person_source: 'Phone call',
      title: '(832) 555-0101 (missed call)',
    });
    const [call] = await rows<{ person_id: string | null }>(
      admin(),
      sql`select person_id from app.calls where id = ${callId}`,
    );
    expect(call!.person_id).toBe(found!.person);
  });

  it('leaves an answered call to the team', async () => {
    const answered = '+18325550102';
    const callId = await ring(answered);
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      callId,
      status: 'in_progress',
      answeredVia: 'browser',
    });
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      callId,
      status: 'completed',
      durationSeconds: 90,
    });
    expect(await leadFor(answered)).toBeNull();
  });
});

describe('an email from someone nobody knows', () => {
  const address = 'dana.reyes@example.com';

  it('opens a customer and a lead, and files the mail in their conversation', async () => {
    const got = await sys(emailReceive, {
      workspaceId: wsId,
      provider: 'fake',
      providerMessageId: `pm-${randomUUID().slice(0, 8)}`,
      messageIdHeader: `<${randomUUID()}@example.com>`,
      from: { address, name: 'Dana Reyes' },
      to: [{ address: `hello@${wsId.slice(0, 8)}.example.com` }],
      subject: 'Quote for a new roof',
      bodyText: 'Could someone come and look this week?',
    });
    expect(got.outcome).toBe('filed');
    const found = await personByEmail(address);
    expect(found).toMatchObject({ first_name: 'Dana', last_name: 'Reyes' });
    expect(found!.lead).not.toBeNull();
    expect(await conversationOf(got.conversationId!)).toMatchObject({ person_id: found!.person });
  });

  it('leaves machines aside: a no-reply sender goes to Other mail, and nobody is made of it', async () => {
    const got = await sys(emailReceive, {
      workspaceId: wsId,
      provider: 'fake',
      providerMessageId: `pm-${randomUUID().slice(0, 8)}`,
      messageIdHeader: `<${randomUUID()}@news.example.com>`,
      from: { address: 'no-reply@news.example.com', name: 'The Trade Weekly' },
      to: [{ address: `hello@${wsId.slice(0, 8)}.example.com` }],
      subject: 'This week in roofing',
      bodyText: 'Your newsletter is here.',
    });
    expect(got).toMatchObject({ outcome: 'filed', folder: 'other' });
    expect(await personByEmail('no-reply@news.example.com')).toBeNull();
  });
});
