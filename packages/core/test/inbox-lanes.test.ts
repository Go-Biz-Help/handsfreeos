/**
 * 0089: a thread belongs to the line it came in on, and the inbox shows the customer once.
 *
 * **Needs the stack up.** Every property here is about what the database key allows, so none of it can be
 * checked without one.
 *
 * The four that matter, and what breaks without each:
 *
 *   a second lane       a customer who texts the dispatch line after the front desk starts a second thread
 *                       rather than landing in the first, which is what made replies go out from a line they
 *                       had not written to
 *   no forking          a thread that has no line takes the first one offered. Get this wrong and every
 *                       business finds its inbox doubled on the morning this ships
 *   one row             `inbox.list` groups those lanes back into one customer, with both under it — the
 *                       splitting above is only bearable because the list puts them back together
 *   the reply's line    each lane answers from its own number, which is the whole point of the split
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
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
  conversationCloseAll,
  conversationGet,
  conversationLinkPerson,
  inboxList,
  intakeSourceUpdate,
  messageReceive,
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
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(
    testDbs().worker.db,
    cmd,
    input,
    { type: 'system', workspaceId: wsId, organizationId: orgId } as SystemActor,
    meta(),
  ).then((r) => r.output);

const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

/** The customer. Two of the business's numbers; one of them is its default. */
const KIM = '+17135550142';
let owner: TestUser;
let orgId: string;
let wsId: string;
let kimId: string;
let frontDesk: string;
let dispatch: string;

/** A text from the customer to one of the business's numbers. */
const textTo = (to: string, body: string) =>
  sys(messageReceive, {
    workspaceId: wsId,
    provider: 'fake',
    providerMessageId: `SM${randomUUID().replace(/-/g, '')}`,
    from: KIM,
    to,
    body,
  });

/** The line a thread is on, as the database holds it. */
async function lineOf(conversationId: string): Promise<string | null> {
  const [c] = await rows<{ e164: string | null }>(
    admin(),
    sql`select n.e164 from app.conversations c left join app.phone_numbers n on n.id = c.phone_number_id
        where c.id = ${conversationId}`,
  );
  return c?.e164 ?? null;
}

const buyNumber = async (e164: string, isDefault: boolean) =>
  (
    await rows<{ id: string }>(
      admin(),
      sql`insert into app.phone_numbers (workspace_id, e164, number_type, status, label, is_default)
          values (${wsId}, ${e164}, 'local', 'active', ${isDefault ? 'Front desk' : 'Dispatch'}, ${isDefault})
          returning id`,
    )
  )[0]!.id;

beforeAll(async () => {
  owner = await createTestUser('lanes-owner');
  const org = await run(
    organizationCreate,
    { businessName: 'Lanes Test Co', organizationName: 'Lanes Agency' },
    owner,
  );
  orgId = org.organizationId;
  wsId = org.workspaceId;
  // This suite is about which thread a text lands in, not about lead intake making a customer out of a
  // stranger; intake has its own tests.
  await run(intakeSourceUpdate, { workspaceId: wsId, kind: 'text', active: false }, owner);
  kimId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Kim', lastName: 'Alvarez', phone: '(713) 555-0142' },
      owner,
    )
  ).personId;
  frontDesk = randomE164();
  dispatch = randomE164();
  await buyNumber(frontDesk, true);
  await buyNumber(dispatch, false);
}, 60_000);

afterAll(closeTestDbs);

describe('a thread belongs to the line it came in on', () => {
  let front: string;
  let disp: string;

  it('keeps the first text on the number it was sent to', async () => {
    front = (await textTo(frontDesk, 'Is Marco still coming?')).conversationId;
    expect(await lineOf(front)).toBe(frontDesk);
  });

  it('starts a second thread when the same customer writes to a second number', async () => {
    disp = (await textTo(dispatch, 'Trying the other number')).conversationId;
    expect(disp).not.toBe(front);
    expect(await lineOf(disp)).toBe(dispatch);
    // And the first one did not move: a thread is glued to its line, which is what the reply follows.
    expect(await lineOf(front)).toBe(frontDesk);
  });

  it('puts another text on the same number back in the same thread', async () => {
    const again = await textTo(frontDesk, 'Still here');
    expect(again.conversationId).toBe(front);
  });

  /**
   * The compatibility property. A thread with no line is what every thread made before 0089 looked like, and
   * what a business that had no number when it started still makes. It takes the first line offered rather
   * than sitting beside a new one — without this, shipping 0089 doubles everybody's inbox.
   */
  it('gives a thread that has no line the first one offered, instead of forking it', async () => {
    const stranger = randomE164();
    const [made] = await rows<{ id: string }>(
      testDbs().worker.db,
      sql`insert into app.conversations (workspace_id, channel, counterpart, phone_number_id)
          values (${wsId}, 'sms', ${stranger}, null) returning id`,
    );
    const landed = await sys(messageReceive, {
      workspaceId: wsId,
      provider: 'fake',
      providerMessageId: `SM${randomUUID().replace(/-/g, '')}`,
      from: stranger,
      to: frontDesk,
      body: 'Hello',
    });
    expect(landed.conversationId).toBe(made!.id);
    expect(await lineOf(made!.id)).toBe(frontDesk);
  });

  it('shows the customer once, with both lanes under them', async () => {
    const { items } = await ask(inboxList, { workspaceId: wsId, box: 'all' }, owner);
    const kim = items.filter((c) => c.person?.id === kimId);
    expect(kim).toHaveLength(1);
    const lanes = kim[0]!.lanes.map((l) => l.lineDisplay).sort();
    expect(lanes).toHaveLength(2);
    expect(lanes.some((l) => l.startsWith('Front desk · '))).toBe(true);
    expect(lanes.some((l) => l.startsWith('Dispatch · '))).toBe(true);
    // The badge counts the customer, not whichever lane happens to represent them.
    expect(kim[0]!.unreadTotal).toBe(kim[0]!.lanes.reduce((n, l) => n + l.unreadCount, 0));
    expect(kim[0]!.unreadTotal).toBeGreaterThan(kim[0]!.unreadCount);
  });

  it('tells each lane which of the business’s numbers a reply leaves from', async () => {
    const onFront = await ask(conversationGet, { workspaceId: wsId, conversationId: front }, owner);
    const onDisp = await ask(conversationGet, { workspaceId: wsId, conversationId: disp }, owner);
    expect(onFront.fromNumber).not.toEqual(onDisp.fromNumber);
    // Both lanes are offered from either of them, so the switcher can reach the other one.
    expect(onFront.conversation.lanes.map((l) => l.id).sort()).toEqual([front, disp].sort());
    expect(onDisp.conversation.lanes.map((l) => l.id).sort()).toEqual([front, disp].sort());
  });

  it('closes every lane at once when asked, and says how many', async () => {
    const out = await run(
      conversationCloseAll,
      { workspaceId: wsId, conversationId: front },
      owner,
    );
    expect(out.closed).toBe(2);
    const open = await rows<{ id: string }>(
      admin(),
      sql`select id from app.conversations where person_id = ${kimId} and status <> 'closed'`,
    );
    expect(open).toEqual([]);
    // Running it again closes nothing rather than failing.
    expect(
      (await run(conversationCloseAll, { workspaceId: wsId, conversationId: front }, owner)).closed,
    ).toBe(0);
  });
});

describe('a customer nobody has linked', () => {
  const walkIn = '+18325550190';
  let a: string;
  let b: string;

  it('keeps their lanes together under the address, with nobody’s name on them', async () => {
    a = (
      await sys(messageReceive, {
        workspaceId: wsId,
        provider: 'fake',
        providerMessageId: `SM${randomUUID().replace(/-/g, '')}`,
        from: walkIn,
        to: frontDesk,
        body: 'Do you do weekends?',
      })
    ).conversationId;
    b = (
      await sys(messageReceive, {
        workspaceId: wsId,
        provider: 'fake',
        providerMessageId: `SM${randomUUID().replace(/-/g, '')}`,
        from: walkIn,
        to: dispatch,
        body: 'Anyone there?',
      })
    ).conversationId;
    expect(a).not.toBe(b);
    const { items } = await ask(inboxList, { workspaceId: wsId, box: 'all' }, owner);
    const row = items.filter((c) => c.counterpart === walkIn);
    expect(row).toHaveLength(1);
    expect(row[0]!.person).toBeNull();
    expect(row[0]!.lanes).toHaveLength(2);
  });

  /**
   * Suggested, never taken (the answer to "merge linked, suggest the rest"). A number that matches a
   * customer's details is offered as a question, and stays a question until somebody answers it.
   */
  it('offers the customer it looks like rather than merging on the guess', async () => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164, created_by)
          values (${wsId}, 'Sam', 'Ortiz', ${walkIn}, ${owner.id}) returning id`,
    );
    const { items } = await ask(inboxList, { workspaceId: wsId, box: 'all' }, owner);
    const row = items.find((c) => c.counterpart === walkIn)!;
    expect(row.person).toBeNull();
    expect(row.sameAs).toMatchObject({ id: p!.id, fullName: 'Sam Ortiz' });

    // Answering it links every lane on that address, not only the one that was clicked — otherwise the
    // customer splits in two, half under their name and half still under their number.
    await run(
      conversationLinkPerson,
      { workspaceId: wsId, conversationId: a, personId: p!.id },
      owner,
    );
    const after = await ask(inboxList, { workspaceId: wsId, box: 'all' }, owner);
    const linked = after.items.filter((c) => c.person?.id === p!.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.lanes).toHaveLength(2);
    expect(linked[0]!.sameAs).toBeNull();
  });
});
