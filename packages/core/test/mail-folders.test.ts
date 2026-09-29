/**
 * Other mail and Spam (M19, step 2): where a new email thread goes, what a thread in Other mail or Spam wakes (nothing),
 * moving a thread and remembering where a sender's mail goes, and the inbox's boxes keeping them apart.
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
  conversationArchive,
  conversationLinkPerson,
  conversationMove,
  emailAddressCreate,
  emailReceive,
  emailSenderRuleRemove,
  inboxList,
  inboxSummary,
  intakeSourceUpdate,
  organizationCreate,
  personCreate,
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
const receive = (input: Record<string, unknown>) =>
  executeCommand(
    testDbs().worker.db,
    emailReceive,
    {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: `pm-${uniq()}`,
      messageIdHeader: `<${randomUUID()}@mail.example.com>`,
      to: [{ address: shared.address }],
      emailAddressId: shared.id,
      subject: 'Hello',
      bodyText: 'Hello there',
      ...input,
    },
    system(),
    meta(),
  ).then((r) => r.output);
const stranger = () => `s-${uniq().toLowerCase()}@strangers.example.com`;

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
let member: TestUser;
let wsId: string;
let orgId: string;
let shared: { id: string; address: string };
/** A second address, so a sender can start a second thread. */
let sales: { id: string; address: string };
let mike: string;

const thread = async (id: string) =>
  (
    await rows<{
      folder: string;
      unread_count: number;
      awaiting: boolean;
      person_id: string | null;
    }>(
      admin(),
      sql`select folder::text as folder, unread_count, awaiting_reply_since is not null as awaiting, person_id
          from app.conversations where id = ${id}`,
    )
  )[0]!;
const eventsOf = async (entityId: string) =>
  (
    await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${entityId} order by created_at`,
    )
  ).map((e) => e.event_type);

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('folders-owner'),
    createTestUser('folders-member'),
  ]);
  const created = await run(organizationCreate, { businessName: 'Folders HVAC' }, owner);
  wsId = created.workspaceId;
  orgId = created.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
  // Lead intake is off here, so a stranger's mail shows where it goes without intake making them a customer.
  await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'email', active: false }, owner);
  shared = (
    await rows<{ id: string; address: string }>(
      admin(),
      sql`select id, address from app.email_addresses where workspace_id = ${wsId} and is_default`,
    )
  )[0]!;
  const s = await run(
    emailAddressCreate,
    {
      workspaceId: wsId,
      localPart: `sales-${uniq().toLowerCase()}`,
      displayName: 'Folders HVAC',
      isDefault: false,
    },
    owner,
  );
  sales = { id: s.emailAddressId, address: s.address };
  mike = `mike-${uniq().toLowerCase()}@example.com`;
  await run(
    personCreate,
    { workspaceId: wsId, firstName: 'Mike', lastName: 'Johnson', email: mike },
    owner,
  );
});
afterAll(closeTestDbs);

describe('where a new email thread goes', () => {
  it('a customer’s is in the Inbox, even when the spam filter doubts it', async () => {
    const got = await receive({ from: { address: mike }, spamScore: 9.5 });
    expect(got).toMatchObject({ outcome: 'filed', folder: 'inbox' });
    expect(await eventsOf(got.messageId!)).toContain('message.received');
  });

  it('a stranger’s spam is in Spam, and a stranger’s other mail in Other mail', async () => {
    const spam = await receive({ from: { address: stranger() }, spamScore: 7.1 });
    expect(spam).toMatchObject({ outcome: 'filed', folder: 'spam' });
    const other = await receive({ from: { address: stranger() }, spamScore: 1.2 });
    expect(other).toMatchObject({ outcome: 'filed', folder: 'other' });
    for (const got of [spam, other]) {
      expect(await eventsOf(got.messageId!)).toEqual(['email.filed']);
      // Counted as unread in its folder, but nobody waits on a reply to it.
      expect(await thread(got.conversationId!)).toMatchObject({ unread_count: 1, awaiting: false });
    }
    const reminders = await rows(
      admin(),
      sql`select 1 from app.scheduled_jobs where kind = 'conversation.unanswered_check'
          and payload ->> 'conversationId' in (${spam.conversationId}, ${other.conversationId})`,
    );
    expect(reminders).toHaveLength(0);
  });

  it('automatic mail: a stranger’s is kept in Other mail, a customer’s still isn’t filed', async () => {
    const newsletter = stranger();
    const first = await receive({ from: { address: newsletter }, automatic: true });
    expect(first).toMatchObject({ outcome: 'filed', folder: 'other' });
    // The next issue joins its thread in Other mail.
    const second = await receive({ from: { address: newsletter }, automatic: true });
    expect(second).toMatchObject({ folder: 'other', conversationId: first.conversationId });
    expect((await receive({ from: { address: mike }, automatic: true })).outcome).toBe('skipped');
  });
});

describe('moving a thread', () => {
  it('moves it and remembers the sender, so their next new thread goes there too', async () => {
    const who = stranger();
    const first = await receive({ from: { address: who } });
    expect(first.folder).toBe('other');
    const moved = await run(
      conversationMove,
      { workspaceId: wsId, conversationId: first.conversationId, folder: 'inbox', remember: true },
      member,
    );
    expect(moved).toEqual({ conversationId: first.conversationId, folder: 'inbox', changed: true });
    expect(
      (
        await run(
          conversationMove,
          { workspaceId: wsId, conversationId: first.conversationId, folder: 'inbox' },
          member,
        )
      ).changed,
    ).toBe(false);
    // From now on the thread wakes things up like any Inbox thread.
    const again = await receive({ from: { address: who } });
    expect(again).toMatchObject({ conversationId: first.conversationId, folder: 'inbox' });
    expect(await eventsOf(again.messageId!)).toContain('message.received');
    // Their first mail to another address starts a thread in the Inbox too, even an automatic one.
    const elsewhere = await receive({
      from: { address: who },
      to: [{ address: sales.address }],
      emailAddressId: sales.id,
      automatic: true,
    });
    expect(elsewhere.conversationId).not.toBe(first.conversationId);
    expect(elsewhere.folder).toBe('inbox');

    // Forgetting the rule sorts their next new thread like anyone else's.
    expect(await run(emailSenderRuleRemove, { workspaceId: wsId, address: who }, member)).toEqual({
      address: who,
      removed: true,
    });
    const [rule] = await rows(
      admin(),
      sql`select 1 from app.email_sender_rules where workspace_id = ${wsId} and address = ${who}`,
    );
    expect(rule).toBeUndefined();
  });

  it('into Spam sends the sender’s next new thread to Spam', async () => {
    const who = stranger();
    const first = await receive({ from: { address: who } });
    await run(
      conversationMove,
      { workspaceId: wsId, conversationId: first.conversationId, folder: 'spam', remember: true },
      owner,
    );
    expect((await thread(first.conversationId!)).folder).toBe('spam');
    const next = await receive({
      from: { address: who },
      to: [{ address: sales.address }],
      emailAddressId: sales.id,
    });
    expect(next.folder).toBe('spam');
    expect(await eventsOf(first.conversationId!)).toContain('conversation.moved');
  });

  it('is for email only', async () => {
    const [text] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart) values (${wsId}, 'sms', '+15125550199')
          returning id`,
    );
    await expectHfos(
      () =>
        run(
          conversationMove,
          { workspaceId: wsId, conversationId: text!.id, folder: 'other' },
          owner,
        ),
      'rule_violation',
      'conversation_not_email',
    );
  });
});

describe('the inbox’s boxes', () => {
  it('keep Other mail and Spam out of the Inbox and its counts, each in a box of its own', async () => {
    const other = await receive({ from: { address: stranger() }, subject: 'Other one' });
    const spam = await receive({
      from: { address: stranger() },
      spamScore: 12,
      subject: 'Spam one',
    });
    const ids = async (box: string) =>
      (await ask(inboxList, { workspaceId: wsId, box, limit: 100 }, owner)).items.map((i) => i.id);
    const all = await ids('all');
    expect(all).not.toContain(other.conversationId);
    expect(all).not.toContain(spam.conversationId);
    expect(await ids('other')).toContain(other.conversationId);
    expect(await ids('other')).not.toContain(spam.conversationId);
    expect(await ids('spam')).toContain(spam.conversationId);

    const before = await ask(inboxSummary, { workspaceId: wsId }, owner);
    await receive({ from: { address: stranger() } });
    const after = await ask(inboxSummary, { workspaceId: wsId }, owner);
    expect(after.unread.all).toBe(before.unread.all);
    // Counted beside the Inbox instead: unread in Other mail, and everything in Spam.
    expect(after.mail.other).toBe(before.mail.other + 1);
    expect(after.mail.spam).toBeGreaterThanOrEqual(1);
    // Nobody here has an address of their own, so there's no My mail to show.
    expect(after.mail).toMatchObject({ mine: 0, own: false });
  });
});

describe('archiving', () => {
  it('finds a thread put away from Other mail in Archived', async () => {
    const got = await receive({ from: { address: stranger() }, subject: 'Put me away' });
    await run(
      conversationArchive,
      { workspaceId: wsId, conversationId: got.conversationId },
      owner,
    );
    const ids = async (box: string) =>
      (await ask(inboxList, { workspaceId: wsId, box, limit: 100 }, owner)).items.map((i) => i.id);
    expect(await ids('archived')).toContain(got.conversationId);
    expect(await ids('other')).not.toContain(got.conversationId);
  });
});

describe('adding the customer', () => {
  it('claims a stranger’s thread from Other mail or Spam into the Inbox', async () => {
    const address = stranger();
    const got = await receive({ from: { address }, subject: 'Heat pump quote?' });
    expect((await thread(got.conversationId!)).folder).toBe('other');
    const karen = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Karen', lastName: 'Liu', email: address },
      member,
    );
    await run(
      conversationLinkPerson,
      { workspaceId: wsId, conversationId: got.conversationId, personId: karen.personId },
      member,
    );
    expect(await thread(got.conversationId!)).toMatchObject({
      folder: 'inbox',
      person_id: karen.personId,
    });
    const listed = await ask(inboxList, { workspaceId: wsId, box: 'all', limit: 100 }, owner);
    expect(listed.items.map((i) => i.id)).toContain(got.conversationId);
  });
});
