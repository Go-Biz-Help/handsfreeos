import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { emailReceive, emailSuppressionRecord } from '../src/commands/email-inbound';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import { emailComposeOptions } from '../src/queries/email-compose';
import {
  intakeSourceUpdate,
  messageSend,
  messageUpdateStatus,
  organizationCreate,
  personCreate,
  timelineList,
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

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

const MIKE = 'mike.johnson@example.com';
const PAT = 'pat.rivera@example.com';
const DALE_MAILBOX = 'dale@lonestar.example.com';

let owner: TestUser;
let member: TestUser;
let wsId: string;
let orgId: string;
let mikeId: string;
let patId: string;
let noEmailId: string;
let shared: { id: string; address: string };
let mikeConversation: string;
let firstHeader: string;

const message = async (id: string) =>
  (
    await rows<{
      from_address: string;
      to_addresses: string[];
      subject: string | null;
      message_id_header: string | null;
      in_reply_to_header: string | null;
      references_headers: string[];
      dedupe_key: string | null;
      email_address_id: string | null;
      mailbox_connection_id: string | null;
      provider: string | null;
      status: string;
      sent_by: string | null;
    }>(
      admin(),
      sql`select from_address, to_addresses, subject, message_id_header, in_reply_to_header, references_headers,
            dedupe_key, email_address_id, mailbox_connection_id, provider, status::text as status, sent_by
          from app.messages where id = ${id}`,
    )
  )[0]!;
const conversation = async (id: string) =>
  (
    await rows<{
      channel: string;
      counterpart: string;
      person_id: string | null;
      email_reply_token: string | null;
      email_address_id: string | null;
      last_preview: string | null;
      unread_count: number;
      awaiting: boolean;
      folder: string;
    }>(
      admin(),
      sql`select channel::text as channel, counterpart, person_id, email_reply_token, email_address_id, last_preview,
            unread_count, awaiting_reply_since is not null as awaiting, folder::text as folder
          from app.conversations where id = ${id}`,
    )
  )[0]!;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('email-owner'),
    createTestUser('email-member'),
  ]);
  const created = await run(organizationCreate, { businessName: 'Email Test HVAC' }, owner);
  wsId = created.workspaceId;
  orgId = created.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
  const person = (first: string, last: string, email?: string) =>
    run(
      personCreate,
      { workspaceId: wsId, firstName: first, lastName: last, ...(email ? { email } : {}) },
      owner,
    ).then((r) => r.personId);
  mikeId = await person('Mike', 'Johnson', MIKE);
  patId = await person('Pat', 'Rivera', PAT);
  noEmailId = await person('No', 'Email');
  shared = (
    await rows<{ id: string; address: string }>(
      admin(),
      sql`select id, address from app.email_addresses where workspace_id = ${wsId} and is_default`,
    )
  )[0]!;
  // Lead intake (M14) would file a stranger's first email under a new customer. This suite covers where a
  // stranger's mail goes when intake is off, capped, or the sender is a machine — Other mail (M19) — so it
  // turns the channel off. What intake does instead is in intake.test.ts.
  await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'email', active: false }, owner);
});
afterAll(closeTestDbs);

describe('sending email', () => {
  it('goes from the shared-subdomain address with our own Message-ID, and the reply threads back', async () => {
    const sent = await run(
      messageSend,
      {
        workspaceId: wsId,
        personId: mikeId,
        channel: 'email',
        subject: 'Your roof estimate',
        body: 'Hi Mike,\nThe estimate is attached.',
      },
      member,
    );
    expect(sent).toMatchObject({ status: 'queued', duplicate: false });
    mikeConversation = sent.conversationId;
    const m = await message(sent.messageId);
    expect(m).toMatchObject({
      from_address: shared.address,
      to_addresses: [MIKE],
      subject: 'Your roof estimate',
      email_address_id: shared.id,
      provider: 'postmark',
      in_reply_to_header: null,
      sent_by: member.id,
    });
    expect(m.message_id_header).toMatch(/^<[0-9a-f-]{36}@mail\.handsfreeos\.com>$/);
    expect(m.dedupe_key).toBe(`email:${m.message_id_header!.toLowerCase()}`);
    firstHeader = m.message_id_header!;
    const c = await conversation(mikeConversation);
    expect(c).toMatchObject({
      channel: 'email',
      counterpart: MIKE,
      person_id: mikeId,
      email_address_id: shared.id,
      last_preview: 'Your roof estimate · Hi Mike,',
    });
    expect(c.email_reply_token).toMatch(/^[a-z2-7]{10}$/);

    const reply = {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: 'pm-in-1',
      messageIdHeader: '<reply-1@mail.example.com>',
      inReplyTo: firstHeader,
      references: [firstHeader],
      from: { address: MIKE, name: 'Mike Johnson' },
      to: [{ address: shared.address }],
      subject: 'Re: Your roof estimate',
      bodyText: 'Looks good. When can you start?',
      replyToken: c.email_reply_token,
      emailAddressId: shared.id,
    };
    expect(await sys(emailReceive, reply)).toMatchObject({
      outcome: 'filed',
      conversationId: mikeConversation,
    });
    expect((await sys(emailReceive, reply)).outcome).toBe('duplicate');
    expect(await conversation(mikeConversation)).toMatchObject({
      unread_count: 1,
      awaiting: true,
      last_preview: 'Re: Your roof estimate · Looks good. When can you start?',
    });

    // The next email needs no subject: it answers the reply, under the whole thread.
    const next = await run(
      messageSend,
      {
        workspaceId: wsId,
        conversationId: mikeConversation,
        channel: 'email',
        body: 'Monday works.',
      },
      member,
    );
    expect(await message(next.messageId)).toMatchObject({
      subject: 'Re: Your roof estimate',
      in_reply_to_header: '<reply-1@mail.example.com>',
      references_headers: [firstHeader, '<reply-1@mail.example.com>'],
    });
    expect(await conversation(mikeConversation)).toMatchObject({
      unread_count: 0,
      awaiting: false,
    });

    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: mikeId, limit: 10 },
      member,
    );
    const emails = timeline.items.filter((e) => e.kind === 'email');
    expect(emails.map((e) => e.subtype)).toEqual(['outbound', 'inbound', 'outbound']);
    expect(emails[1]).toMatchObject({
      meta: expect.objectContaining({ direction: 'inbound', subject: 'Re: Your roof estimate' }),
    });
  });

  it('refuses a customer without an address, a text thread, and an address meant for texts', async () => {
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            personId: noEmailId,
            channel: 'email',
            subject: 'Hi',
            body: 'Hello',
          },
          member,
        ),
      'rule_violation',
      'no_email',
    );
    const [sms] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart)
          values (${wsId}, 'sms', ${`+1713${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}) returning id`,
    );
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            conversationId: sms!.id,
            channel: 'email',
            subject: 'Hi',
            body: 'x',
          },
          member,
        ),
      'rule_violation',
      'channel_mismatch',
    );
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            toPhone: '(713) 555-0142',
            channel: 'email',
            subject: 'Hi',
            body: 'x',
          },
          member,
        ),
      'validation',
    );
  });
});

describe('receiving email', () => {
  it('finds the thread by its headers or the sender, and sets strangers aside once', async () => {
    // Mike answers from his work address: the headers put it in his thread.
    const fromWork = await sys(emailReceive, {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: 'pm-in-2',
      messageIdHeader: '<work-1@work.example.com>',
      inReplyTo: firstHeader,
      from: { address: 'mike@work.example.com' },
      to: [{ address: shared.address }],
      subject: 'Re: Your roof estimate',
      bodyText: 'Can you check the gutters too?',
    });
    expect(fromWork).toMatchObject({ outcome: 'filed', conversationId: mikeConversation });

    // Pat writes first: a new conversation, linked to Pat.
    const fromPat = await sys(emailReceive, {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: 'pm-in-3',
      messageIdHeader: '<pat-1@example.com>',
      from: { address: PAT },
      to: [{ address: shared.address }],
      subject: 'Tune-up price',
      bodyText: 'Is the tune-up still $89?',
    });
    expect(fromPat.outcome).toBe('filed');
    expect(await conversation(fromPat.conversationId!)).toMatchObject({
      person_id: patId,
      unread_count: 1,
    });

    // Someone we don't know (lead intake is off here) goes to Other mail, once (M19): kept whole, and nothing
    // wakes up for it — no AI teammate, workflow, push, timeline or reminder.
    const stranger = {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: 'pm-in-4',
      messageIdHeader: '<s-1@unknown.example.com>',
      from: { address: 'someone@unknown.example.com', name: 'Someone' },
      to: [{ address: shared.address }],
      subject: 'Partnership',
      bodyText: 'Let’s talk.',
    };
    const aside = await sys(emailReceive, stranger);
    expect(aside).toMatchObject({ outcome: 'filed', folder: 'other' });
    expect((await sys(emailReceive, stranger)).outcome).toBe('duplicate');
    expect(await conversation(aside.conversationId!)).toMatchObject({
      counterpart: 'someone@unknown.example.com',
      person_id: null,
      folder: 'other',
      last_preview: 'Partnership · Let’s talk.',
      unread_count: 1,
      awaiting: false,
    });
    const woke = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${aside.messageId}`,
    );
    expect(woke.map((e) => e.event_type)).toEqual(['email.filed']);
    const [message] = await rows<{ activity_id: string | null }>(
      admin(),
      sql`select activity_id from app.messages where id = ${aside.messageId}`,
    );
    expect(message!.activity_id).toBeNull();

    // Our own address coming back around is not a customer.
    expect(
      (
        await sys(emailReceive, {
          ...stranger,
          providerMessageId: 'pm-in-5',
          messageIdHeader: '<loop@mail.handsfreeos.com>',
          from: { address: shared.address },
        })
      ).outcome,
    ).toBe('skipped');
  });
});

describe('a connected mailbox', () => {
  it('sends for the person who connected it; its sent copies land once; other mail stays in Outlook', async () => {
    const [mb] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.mailbox_connections (workspace_id, provider, account_email, display_name, user_id, status, created_by, connected_at)
          values (${wsId}, 'microsoft', ${DALE_MAILBOX}, 'Dale Ramsey', ${owner.id}, 'active', ${owner.id}, now())
          returning id`,
    );
    const viaMailbox = {
      workspaceId: wsId,
      personId: patId,
      channel: 'email',
      subject: 'Tune-up',
      body: 'Yes, still $89.',
      mailboxConnectionId: mb!.id,
    };
    await expectHfos(
      () => run(messageSend, viaMailbox, member),
      'rule_violation',
      'mailbox_not_shared',
    );
    const sent = await run(messageSend, viaMailbox, owner);
    const m = await message(sent.messageId);
    expect(m).toMatchObject({
      provider: 'microsoft',
      from_address: DALE_MAILBOX,
      mailbox_connection_id: mb!.id,
      email_address_id: null,
    });
    const synced = {
      workspaceId: wsId,
      provider: 'microsoft',
      providerMessageId: 'graph-1',
      direction: 'outbound',
      messageIdHeader: m.message_id_header,
      from: { address: DALE_MAILBOX },
      to: [{ address: PAT }],
      subject: 'Tune-up',
      bodyText: 'Yes, still $89.',
      mailboxConnectionId: mb!.id,
      knownOnly: true,
    };
    expect((await sys(emailReceive, synced)).outcome).toBe('duplicate');

    // Something Dale sent Pat from Outlook itself: filed as sent and credited to Dale, nothing unread.
    const imported = await sys(emailReceive, {
      ...synced,
      providerMessageId: 'graph-2',
      messageIdHeader: '<outlook-1@lonestar.example.com>',
      subject: 'Invoice',
      bodyText: 'Attached.',
    });
    expect(imported.outcome).toBe('filed');
    expect(await message(imported.messageId!)).toMatchObject({ status: 'sent', sent_by: owner.id });
    expect(await conversation(imported.conversationId!)).toMatchObject({ unread_count: 0 });

    // Mail between Dale and someone who isn't a customer stays in Outlook.
    expect(
      (
        await sys(emailReceive, {
          ...synced,
          providerMessageId: 'graph-3',
          direction: 'inbound',
          messageIdHeader: '<sale@shop.example.com>',
          from: { address: 'news@shop.example.com' },
          to: [{ address: DALE_MAILBOX }],
          subject: 'Sale',
        })
      ).outcome,
    ).toBe('skipped');
  });
});

describe('bounces, complaints and the composer', () => {
  it('a hard bounce moves the message and stops the address; the composer says so', async () => {
    const sent = await run(
      messageSend,
      {
        workspaceId: wsId,
        personId: patId,
        channel: 'email',
        subject: 'Reminder',
        body: 'See you tomorrow.',
      },
      member,
    );
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      providerMessageId: 'pm-out-9',
      status: 'sent',
    });
    expect(
      await sys(messageUpdateStatus, {
        workspaceId: wsId,
        providerMessageId: 'pm-out-9',
        status: 'bounced',
        errorCode: 'HardBounce',
        errorMessage: 'The address doesn’t exist',
      }),
    ).toMatchObject({ status: 'bounced', changed: true });
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${sent.messageId} order by created_at`,
    );
    expect(events.map((e) => e.event_type)).toContain('message.bounced');

    const stop = {
      workspaceId: wsId,
      address: PAT,
      reason: 'hard_bounce',
      messageId: sent.messageId,
    };
    expect((await sys(emailSuppressionRecord, stop)).created).toBe(true);
    expect((await sys(emailSuppressionRecord, stop)).created).toBe(false);
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            personId: patId,
            channel: 'email',
            subject: 'Again',
            body: 'Hello?',
          },
          member,
        ),
      'rule_violation',
      'recipient_suppressed',
    );
    expect(
      await ask(emailComposeOptions, { workspaceId: wsId, personId: patId }, member),
    ).toMatchObject({
      to: PAT,
      canEmail: { ok: false, reason: 'suppressed' },
      suppressed: { reason: 'hard_bounce' },
    });
  });

  it('offers the addresses, the reply subject, and says when a customer has no address', async () => {
    const mike = await ask(emailComposeOptions, { workspaceId: wsId, personId: mikeId }, member);
    expect(mike).toMatchObject({
      to: MIKE,
      conversationId: mikeConversation,
      canEmail: { ok: true, reason: null },
      fromAddressId: shared.id,
      replySubject: 'Re: Your roof estimate',
      mailboxes: [],
    });
    expect(mike.addresses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: shared.id, isDefault: true, usable: true }),
      ]),
    );
    // Dale's own mailbox shows for Dale, not for a teammate.
    const forDale = await ask(emailComposeOptions, { workspaceId: wsId, personId: mikeId }, owner);
    expect(forDale.mailboxes).toEqual([
      expect.objectContaining({ provider: 'microsoft', accountEmail: DALE_MAILBOX }),
    ]);
    expect(
      await ask(emailComposeOptions, { workspaceId: wsId, personId: noEmailId }, member),
    ).toMatchObject({ to: null, canEmail: { ok: false, reason: 'no_email' } });
  });
});
