/**
 * A person's own mailbox (M19, step 3), through the commands: mail to their address is theirs and wakes nothing,
 * never a customer's; they alone send from it and only in their own mail; they share a thread to hand it to the
 * team; and when they leave, their mail is nobody's until an owner decides.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, uniq, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  conversationLinkPerson,
  conversationShare,
  emailAddressCreate,
  emailAddressReassign,
  emailAddressUpdate,
  emailComposeOptions,
  emailReceive,
  inboxList,
  inboxSummary,
  messageSend,
  organizationCreate,
  personCreate,
} from '../src/server';

const db = () => testDbs().api.db;
const admin$ = () => testDbs().admin.db;
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
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

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

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let chris: TestUser;
let wsId: string;
let orgId: string;
let domainId: string;
let domain: string;
let chrisAddress: string;
let team: { id: string; address: string };
let bob: string;
let bobId: string;

/** Mail as Postmark's webhook files it, from `from` to one of the business's addresses. */
const receive = (from: string, emailAddressId: string, over: Record<string, unknown> = {}) =>
  executeCommand(
    testDbs().worker.db,
    emailReceive,
    {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: `pm-${token()}`,
      messageIdHeader: `<${randomUUID()}@mail.example.com>`,
      from: { address: from },
      to: [{ address: 'someone@example.com' }],
      subject: 'Dinner Friday?',
      bodyText: 'Are we still on for Friday?',
      emailAddressId,
      ...over,
    },
    system(),
    meta(),
  ).then((r) => r.output);

const thread = async (id: string) =>
  (
    await rows<{
      private_to: string | null;
      person_id: string | null;
      email_address_id: string | null;
    }>(
      admin$(),
      sql`select private_to, person_id, email_address_id from app.conversations where id = ${id}`,
    )
  )[0]!;
/** What was said about it: the event, and what the history owners read keeps of it. */
const eventsOf = async (entityId: string) =>
  rows<{ event_type: string; payload: Record<string, unknown>; after: unknown }>(
    admin$(),
    sql`select e.event_type, e.payload, a.after
        from app.events e left join app.audit_logs a on a.event_id = e.id
        where e.entity_id = ${entityId} order by e.created_at`,
  );
const headerOf = async (messageId: string) =>
  (
    await rows<{ h: string }>(
      admin$(),
      sql`select message_id_header as h from app.messages where id = ${messageId}`,
    )
  )[0]!.h;

beforeAll(async () => {
  [owner, admin, member, chris] = await Promise.all([
    createTestUser('own-core-owner'),
    createTestUser('own-core-admin'),
    createTestUser('own-core-member'),
    createTestUser('own-core-chris'),
  ]);
  const created = await run(organizationCreate, { businessName: 'Own Mailbox HVAC' }, owner);
  wsId = created.workspaceId;
  orgId = created.organizationId;
  await rows(
    admin$(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${admin.id}, 'admin'), (${wsId}, ${member.id}, 'member'), (${wsId}, ${chris.id}, 'member')`,
  );
  domain = `${token()}.example.com`;
  const [d] = await rows<{ id: string }>(
    admin$(),
    sql`insert into app.email_domains (workspace_id, domain, status, receiving)
        values (${wsId}, ${domain}, 'verified', 'on') returning id`,
  );
  domainId = d!.id;
  chrisAddress = (
    await run(
      emailAddressCreate,
      {
        workspaceId: wsId,
        emailDomainId: domainId,
        localPart: 'chris',
        displayName: 'Own Mailbox HVAC',
        ownerUserId: chris.id,
      },
      admin,
    )
  ).emailAddressId;
  team = (
    await rows<{ id: string; address: string }>(
      admin$(),
      sql`select id, address from app.email_addresses where workspace_id = ${wsId} and is_default`,
    )
  )[0]!;
  bob = `bob-${token()}@example.com`;
  bobId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Bob', lastName: 'Diaz', email: bob },
      owner,
    )
  ).personId;
});
afterAll(closeTestDbs);

describe('mail to someone’s own address', () => {
  it('is theirs, never a customer’s, and nothing hears what it says', async () => {
    const got = await receive(bob, chrisAddress);
    expect(got).toMatchObject({ outcome: 'filed', folder: 'inbox' });
    expect(await thread(got.conversationId!)).toEqual({
      private_to: chris.id,
      person_id: null,
      email_address_id: chrisAddress,
    });
    const events = await eventsOf(got.messageId!);
    expect(events.map((e) => e.event_type)).toEqual(['email.filed']);
    expect(events[0]!.payload).toMatchObject({ private: true });
    // The history owners read says it came, not who from or what about.
    expect(JSON.stringify(events[0]!.after)).not.toContain('Dinner');
    expect(JSON.stringify(events[0]!.after)).not.toContain(bob);
    const timeline = await rows(
      admin$(),
      sql`select 1 from app.activities where person_id = ${bobId} and kind = 'email'`,
    );
    expect(timeline).toHaveLength(0);
  });

  it('never crosses into a team thread by its headers, nor the team’s into theirs', async () => {
    const teamMail = await receive(bob, team.id, { subject: 'Quote for a tune-up' });
    expect((await thread(teamMail.conversationId!)).private_to).toBeNull();
    const privateMail = await receive(bob, chrisAddress, { subject: 'See you Friday' });

    const toChris = await receive(bob, chrisAddress, {
      inReplyTo: await headerOf(teamMail.messageId!),
    });
    expect(toChris.conversationId).toBe(privateMail.conversationId);
    const toTeam = await receive(bob, team.id, {
      inReplyTo: await headerOf(privateMail.messageId!),
    });
    expect(toTeam.conversationId).toBe(teamMail.conversationId);
  });

  it('shows in its person’s own mailbox, and in nobody’s team inbox', async () => {
    const got = await receive(`pal-${token()}@example.com`, chrisAddress);
    const ids = async (u: TestUser, mailbox: 'team' | 'mine') =>
      (await ask(inboxList, { workspaceId: wsId, mailbox, limit: 100 }, u)).items.map((i) => i.id);
    expect(await ids(chris, 'mine')).toContain(got.conversationId);
    expect(await ids(chris, 'team')).not.toContain(got.conversationId);
    for (const u of [owner, admin, member])
      expect(await ids(u, 'team')).not.toContain(got.conversationId);
  });
});

describe('sending from someone’s own address', () => {
  it('is its person’s alone, and stays in their own mail', async () => {
    const sent = await run(
      messageSend,
      {
        workspaceId: wsId,
        channel: 'email',
        toEmail: bob,
        emailAddressId: chrisAddress,
        subject: 'Friday',
        body: 'See you at 7.',
      },
      chris,
    );
    expect((await thread(sent.conversationId)).private_to).toBe(chris.id);
    expect((await eventsOf(sent.messageId)).map((e) => e.event_type)).toEqual([
      'email.private_queued',
    ]);
    const [m] = await rows<{ activity_id: string | null }>(
      admin$(),
      sql`select activity_id from app.messages where id = ${sent.messageId}`,
    );
    expect(m!.activity_id).toBeNull();

    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            channel: 'email',
            toEmail: bob,
            emailAddressId: chrisAddress,
            subject: 'Hi',
            body: 'Hi',
          },
          member,
        ),
      'rule_violation',
      'email_address_private',
    );
    const teamThread = (await receive(bob, team.id)).conversationId!;
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            channel: 'email',
            conversationId: teamThread,
            emailAddressId: chrisAddress,
            body: 'From me',
          },
          chris,
        ),
      'rule_violation',
      'email_address_private_thread',
    );
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            channel: 'email',
            conversationId: sent.conversationId,
            emailAddressId: team.id,
            body: 'From the team',
          },
          chris,
        ),
      'rule_violation',
      'email_address_private_thread',
    );
  });

  it('is never where HandsFreeOS writes to a customer: that goes to the team’s thread', async () => {
    const reminder = await executeCommand(
      testDbs().worker.db,
      messageSend,
      {
        workspaceId: wsId,
        channel: 'email',
        personId: bobId,
        subject: 'Your tune-up is tomorrow',
        body: 'See you at 9.',
      },
      system(),
      meta(),
    );
    expect((await thread(reminder.output.conversationId)).private_to).toBeNull();
  });

  it('is offered only to its person, and only where it can send', async () => {
    const offered = async (u: TestUser, input: Record<string, unknown>) =>
      (await ask(emailComposeOptions, { workspaceId: wsId, ...input }, u)).addresses.map(
        (a) => a.id,
      );
    expect(await offered(member, { personId: bobId })).not.toContain(chrisAddress);
    expect(await offered(chris, { personId: bobId })).toContain(chrisAddress);
    const mine = await receive(`pen-${token()}@example.com`, chrisAddress);
    expect(await offered(chris, { conversationId: mine.conversationId })).toEqual([chrisAddress]);
    const teamThread = (await receive(bob, team.id)).conversationId!;
    expect(await offered(chris, { conversationId: teamThread })).not.toContain(chrisAddress);
  });
});

describe('sharing with the team', () => {
  it('is how a person’s own thread reaches the team and a customer’s record', async () => {
    const got = await receive(bob, chrisAddress, { subject: 'About the invoice' });
    await expectHfos(
      () =>
        run(
          conversationLinkPerson,
          { workspaceId: wsId, conversationId: got.conversationId, personId: bobId },
          chris,
        ),
      'rule_violation',
      'conversation_private',
    );
    // Nobody else can even find it to share it.
    await expectHfos(
      () =>
        run(conversationShare, { workspaceId: wsId, conversationId: got.conversationId }, owner),
      'not_found',
    );
    expect(
      await run(
        conversationShare,
        { workspaceId: wsId, conversationId: got.conversationId },
        chris,
      ),
    ).toEqual({ conversationId: got.conversationId, personId: bobId });
    expect(await thread(got.conversationId!)).toMatchObject({
      private_to: null,
      person_id: bobId,
    });
    const events = (await eventsOf(got.conversationId!)).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['conversation.shared', 'conversation.linked']));
  });
});

describe('linking the team’s thread to a customer', () => {
  it('leaves the linker’s own thread with the same sender theirs, and off the customer', async () => {
    const pal = `pal-${token()}@example.com`;
    const own = await receive(pal, chrisAddress, { subject: 'Lunch?' });
    const teamMail = await receive(pal, team.id, { subject: 'A quote, please' });
    // Lead intake made a customer of the team's mail; Chris puts it on the right one.
    const p = await run(
      personCreate,
      {
        workspaceId: wsId,
        firstName: 'Pal',
        lastName: 'Jones',
        email: `pj-${token()}@example.com`,
      },
      owner,
    );
    // Chris can see both threads; linking the team's must not reach into his own.
    await run(
      conversationLinkPerson,
      { workspaceId: wsId, conversationId: teamMail.conversationId, personId: p.personId },
      chris,
    );
    expect(await thread(teamMail.conversationId!)).toMatchObject({
      private_to: null,
      person_id: p.personId,
    });
    expect(await thread(own.conversationId!)).toMatchObject({
      private_to: chris.id,
      person_id: null,
    });
  });
});

describe('the inbox badge', () => {
  it('counts someone’s own unread mail for them alone, and shows My mail only to who has any', async () => {
    const before = await ask(inboxSummary, { workspaceId: wsId }, chris);
    expect(before.mail.own).toBe(true);
    await receive(`buddy-${token()}@example.com`, chrisAddress);
    const after = await ask(inboxSummary, { workspaceId: wsId }, chris);
    expect(after.mail.mine).toBe(before.mail.mine + 1);
    // Their own mail isn't the team's, so the team's badge doesn't move.
    expect(after.unread.all).toBe(before.unread.all);
    expect((await ask(inboxSummary, { workspaceId: wsId }, member)).mail).toMatchObject({
      mine: 0,
      own: false,
    });
  });
});

describe('someone’s own address', () => {
  it('is given by an admin on the business’s own domain, and taken from no one', async () => {
    const given = await run(
      emailAddressCreate,
      {
        workspaceId: wsId,
        emailDomainId: domainId,
        localPart: `m${token()}`,
        displayName: 'Own Mailbox HVAC',
        ownerUserId: member.id,
      },
      admin,
    );
    await expectHfos(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: given.emailAddressId, ownerUserId: admin.id },
          admin,
        ),
      'rule_violation',
      'email_address_owner_is_theirs',
    );
    await expectHfos(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: given.emailAddressId, isDefault: true },
          admin,
        ),
      'rule_violation',
      'email_address_owner_default',
    );
    await expectHfos(
      () =>
        run(
          emailAddressCreate,
          {
            workspaceId: wsId,
            localPart: `s${token()}`,
            displayName: 'Own Mailbox HVAC',
            ownerUserId: member.id,
          },
          admin,
        ),
      'rule_violation',
      'email_address_owner_domain',
    );
  });
});

describe('when someone leaves', () => {
  it('their new mail goes to the team, their old mail to nobody, until an owner decides', async () => {
    const before = await receive(`old-${token()}@example.com`, chrisAddress);
    await rows(
      admin$(),
      sql`delete from app.workspace_memberships where workspace_id = ${wsId} and user_id = ${chris.id}`,
    );
    const after = await receive(`new-${token()}@example.com`, chrisAddress);
    expect(await thread(after.conversationId!)).toMatchObject({
      private_to: null,
      email_address_id: team.id,
    });
    const reassign = (u: TestUser, to: 'team' | 'person' | 'remove', userId?: string) =>
      run(
        emailAddressReassign,
        { workspaceId: wsId, emailAddressId: chrisAddress, to, ...(userId ? { userId } : {}) },
        u,
      );
    await expectHfos(
      () => reassign(admin, 'team'),
      'rule_violation',
      'email_address_reassign_owner',
    );
    const shared = await reassign(owner, 'team');
    expect(shared.to).toBe('team');
    expect(shared.threads).toBeGreaterThan(0);
    expect((await thread(before.conversationId!)).private_to).toBeNull();
    await expectHfos(() => reassign(owner, 'remove'), 'rule_violation', 'email_address_not_owned');
  });
});
