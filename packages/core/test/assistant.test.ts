import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { TEAMMATE_TOOL_NAMES } from '../src/ai-team/tools';
import { assistantTools, toolInputSchema } from '../src/assistant/tools';
import { AssistantCard } from '../src/schemas/assistant';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import { ROLE_PERMISSIONS } from '../src/permissions';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  assistantThreadArchive,
  assistantThreadGet,
  assistantThreadList,
  assistantThreadRename,
  crmMetrics,
  leadArchive,
  leadCreate,
  leadMoveStage,
  organizationCreate,
  personArchive,
  personCreate,
  pipelineList,
} from '../src/server';

const db = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (correlationId = randomUUID()): RequestMeta => ({ correlationId, channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  m = meta(),
) => executeCommand(db(), cmd, input, human(u), m);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), meta());
/** Writes rows the way the worker does: as service_actor, inside this workspace. */
const worker = <T>(fn: (tx: Tx) => Promise<T>) =>
  asWorker(testDbs().worker.db, { workspaceId: wsId, organizationId: orgId }, fn);

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
let teammate: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;

beforeAll(async () => {
  [owner, member, teammate, outsider] = await Promise.all([
    createTestUser('ai-owner'),
    createTestUser('ai-member'),
    createTestUser('ai-teammate'),
    createTestUser('ai-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Assistant Test Co' }, owner);
  orgId = org.output.organizationId;
  wsId = org.output.workspaceId;
  await run(organizationCreate, { businessName: 'Somewhere Else Co' }, outsider);
  for (const u of [member, teammate]) {
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${u.id}, 'member')`,
    );
  }
});
afterAll(closeTestDbs);

describe('Assistant tools', () => {
  it('compile to JSON Schema objects, with unique names the database accepts', () => {
    const names = assistantTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of assistantTools) {
      expect(tool.name).toMatch(/^[a-z][a-z_]{0,63}$/);
      const schema = toolInputSchema(tool);
      expect(schema).toMatchObject({ type: 'object' });
      expect(schema).not.toHaveProperty('$schema');
    }
  });
});

describe('Assistant calendar tools', () => {
  const tool = (name: string) => assistantTools.find((t) => t.name === name)!;
  const id = randomUUID();

  it('look up times on their own, and book, move or cancel only on Confirm with appointments.write', () => {
    expect(tool('find_availability')).toMatchObject({
      autonomy: 'auto',
      permission: 'workspace.read',
    });
    for (const name of ['book_appointment', 'reschedule_appointment', 'cancel_appointment'])
      expect(tool(name)).toMatchObject({ autonomy: 'confirm', permission: 'appointments.write' });
    expect(tool('todays_schedule').description).not.toMatch(/later update|not available/);
  });

  it('keep whole local days for the calendar’s zone and turn offset times into UTC', () => {
    const find = tool('find_availability').input;
    expect(
      find.parse({ calendarId: id, from: '2026-09-17', to: '2026-09-18T17:00:00-05:00' }),
    ).toMatchObject({ from: '2026-09-17', to: '2026-09-18T22:00:00.000Z' });
    expect(find.safeParse({ calendarId: id, from: '2026-02-30' }).success).toBe(false);
    expect(find.safeParse({ calendarId: id, from: '2026-09-17T09:00:00' }).success).toBe(false);
    expect(
      tool('book_appointment').input.parse({
        calendarId: id,
        personId: id,
        startsAt: '2026-09-18T10:00:00-05:00',
      }),
    ).toMatchObject({ startsAt: '2026-09-18T15:00:00.000Z' });
    expect(tool('cancel_appointment').input.parse({ appointmentId: id })).toEqual({
      appointmentId: id,
      notify: true,
    });
  });

  it('draw open times and appointments that link only inside the app', () => {
    const ws = randomUUID();
    const slots = {
      type: 'slots',
      title: 'Priya Natarajan',
      zone: 'Central Time',
      timezone: 'America/Chicago',
      calendar: { id, name: 'Tune-ups' },
      service: { id, name: 'AC tune-up' },
      person: { userId: id, fullName: 'Priya Natarajan' },
      durationMinutes: 60,
      days: [
        {
          date: '2026-09-24',
          label: 'Thu, Sep 24',
          times: [{ startsAt: '2026-09-24T13:00:00.000Z', label: '8:00 AM' }],
        },
      ],
      href: `/app/w/${ws}/calendar?view=week&date=2026-09-24&people=${id}`,
    };
    expect(AssistantCard.safeParse(slots).success).toBe(true);
    expect(AssistantCard.safeParse({ ...slots, href: 'https://example.com' }).success).toBe(false);
    expect(
      AssistantCard.safeParse({
        type: 'appointment',
        appointmentId: id,
        what: 'AC tune-up',
        customer: 'Mike Johnson',
        when: 'Fri, Sep 18, 10:00–11:00 AM',
        with: 'Priya Natarajan',
        status: 'scheduled',
        href: `/app/w/${ws}/calendar?date=2026-09-18&appt=${id}`,
      }).success,
    ).toBe(true);
  });
});

describe('Assistant money tools', () => {
  const tool = (name: string) => assistantTools.find((t) => t.name === name)!;
  const id = randomUUID();
  const READS = ['money_owed', 'money_collected', 'customer_money', 'estimates_waiting'];
  const WRITES = ['send_estimate', 'record_payment'];

  it('read on their own for anyone who may see money, and move money only on Confirm', () => {
    for (const name of READS)
      expect([name, tool(name)]).toMatchObject([
        name,
        { autonomy: 'auto', permission: 'money.read' },
      ]);
    for (const name of WRITES)
      expect([name, tool(name)]).toMatchObject([
        name,
        { autonomy: 'confirm', permission: 'money.manage' },
      ]);
  });

  it('split on the same permission that hides the buttons: a member gets the reads and not the writes', () => {
    const can = (role: keyof typeof ROLE_PERMISSIONS) => (p: string) =>
      (ROLE_PERMISSIONS[role] as readonly string[]).includes(p);
    const offered = (role: 'owner' | 'admin' | 'member') =>
      assistantTools.filter((t) => can(role)(t.permission)).map((t) => t.name);
    for (const role of ['owner', 'admin'] as const)
      for (const name of [...READS, ...WRITES]) expect(offered(role)).toContain(name);
    for (const name of READS) expect(offered('member')).toContain(name);
    for (const name of WRITES) expect(offered('member')).not.toContain(name);
  });

  it('are never handed to the AI teammate: it may not quote a price, or issue an invoice', () => {
    for (const name of [...READS, ...WRITES]) expect(TEAMMATE_TOOL_NAMES).not.toContain(name);
    expect(TEAMMATE_TOOL_NAMES.some((n) => /money|invoice|estimate|payment/i.test(n))).toBe(false);
  });

  it('take the ids and amounts the commands take, and refuse what they do not', () => {
    expect(tool('money_owed').input.parse({})).toEqual({ overdueOnly: false, limit: 8 });
    expect(tool('money_collected').input.parse({})).toEqual({ days: 30 });
    expect(tool('money_collected').input.safeParse({ days: 0 }).success).toBe(false);
    expect(tool('customer_money').input.safeParse({ personId: 'nope' }).success).toBe(false);
    expect(tool('send_estimate').input.parse({ estimateId: id })).toEqual({
      estimateId: id,
      channels: ['email'],
    });
    expect(
      tool('send_estimate').input.safeParse({ estimateId: id, channels: ['pigeon'] }).success,
    ).toBe(false);
    expect(tool('record_payment').input.parse({ invoiceId: id })).toEqual({
      invoiceId: id,
      method: 'cash',
    });
    // It writes down money already taken; a card is never one of the ways.
    expect(tool('record_payment').input.safeParse({ invoiceId: id, method: 'card' }).success).toBe(
      false,
    );
    expect(tool('record_payment').input.safeParse({ invoiceId: id, amount: -5 }).success).toBe(
      false,
    );
    expect(toolInputSchema(tool('record_payment'))).toMatchObject({
      type: 'object',
      required: ['invoiceId'],
    });
  });

  it('draw the money card, with or without the parts an older chat never had, linking only inside the app', () => {
    const ws = randomUUID();
    // The headline on its own is a whole card: a chat saved without stats or rows still loads.
    const total = {
      type: 'money',
      title: 'What you are owed',
      value: '$12,480.75',
      href: `/app/w/${ws}/money`,
    };
    expect(AssistantCard.safeParse(total).success).toBe(true);
    const full = {
      ...total,
      detail: '6 invoices · 2 overdue',
      tone: 'danger',
      stats: [{ value: '$2,080.80', label: 'overdue · 2 invoices' }],
      items: [
        {
          title: 'INV-1044 · ABC Dental',
          detail: '$2,080.80 · due Fri, Sep 18',
          status: 'Overdue',
          tone: 'danger',
          href: `/app/w/${ws}/money/invoices/${id}`,
        },
      ],
    };
    expect(AssistantCard.safeParse(full).success).toBe(true);
    expect(
      AssistantCard.safeParse({
        ...full,
        items: [{ ...full.items[0]!, href: 'https://example.com/pay' }],
      }).success,
    ).toBe(false);
    expect(AssistantCard.safeParse({ ...full, tone: 'green' }).success).toBe(false);
  });
});

describe('Assistant Action Center tools', () => {
  const tool = (name: string) => assistantTools.find((t) => t.name === name)!;
  const id = randomUUID();

  it('read the list on their own, and handle, snooze, dismiss or assign only on Confirm', () => {
    const what = tool('what_needs_attention');
    expect(what).toMatchObject({ autonomy: 'auto', permission: 'records.read' });
    expect(what.description).toMatch(/same list Home shows and in the same order/);
    expect(what.description).not.toMatch(/nobody has contacted/);
    for (const name of ['handle_attention_item', 'update_attention_item'])
      expect(tool(name)).toMatchObject({ autonomy: 'confirm', permission: 'records.write' });
    expect(toolInputSchema(what)).toMatchObject({
      type: 'object',
      properties: { scope: { enum: ['mine', 'everyone'] }, kind: { type: 'string' } },
    });
    expect(toolInputSchema(tool('update_attention_item'))).toMatchObject({
      type: 'object',
      required: ['itemId', 'action'],
    });
    expect(toolInputSchema(tool('handle_attention_item'))).toMatchObject({
      type: 'object',
      required: ['itemId'],
    });

    expect(what.input.parse({})).toEqual({});
    expect(what.input.parse({ scope: 'everyone', kind: 'hot_lead' })).toEqual({
      scope: 'everyone',
      kind: 'hot_lead',
    });
    expect(what.input.safeParse({ kind: 'not_a_kind' }).success).toBe(false);
    expect(tool('handle_attention_item').input.parse({ itemId: id })).toEqual({ itemId: id });
    expect(
      tool('handle_attention_item').input.parse({
        itemId: id,
        nextAction: 'Call about the quote',
        dueAt: '2026-09-17T09:00:00-05:00',
      }),
    ).toMatchObject({ dueAt: '2026-09-17T14:00:00.000Z' });
    expect(
      tool('handle_attention_item').input.safeParse({ itemId: id, action: 'call' }).success,
    ).toBe(false);
    const update = tool('update_attention_item').input;
    expect(
      update.parse({ itemId: id, action: 'snooze', until: '2026-09-16T08:00:00-05:00' }),
    ).toEqual({ itemId: id, action: 'snooze', until: '2026-09-16T13:00:00.000Z' });
    expect(update.parse({ itemId: id, action: 'assign', assigneeUserId: null })).toEqual({
      itemId: id,
      action: 'assign',
      assigneeUserId: null,
    });
    expect(update.safeParse({ itemId: id, action: 'resolve' }).success).toBe(false);
  });

  it('draw the attention card with or without the Action Center’s fields, linking only inside the app', () => {
    const ws = randomUUID();
    const before = {
      type: 'attention',
      items: [
        {
          title: 'Mike Johnson texted',
          detail: 'Is Thursday still OK? · Nobody assigned',
          tone: 'accent',
          waitingSince: '2026-09-15T14:00:00.000Z',
          href: `/app/w/${ws}/inbox/${id}`,
        },
      ],
    };
    // A chat saved before M8 still loads.
    expect(AssistantCard.safeParse(before).success).toBe(true);
    const now = {
      type: 'attention',
      affected: { cents: 1_850_000, total: 3, urgent: 1, scope: 'everyone' },
      items: [
        {
          title: 'Maria Lopez · New AC install',
          detail: 'Hot lead · $18,500 · qualified',
          tone: 'danger',
          waitingSince: '2026-09-15T14:00:00.000Z',
          href: `/app/w/${ws}?item=${id}`,
          itemId: id,
          kind: 'hot_lead',
          chips: [
            { code: 'waiting', text: 'waiting 11 min' },
            { code: 'value', text: '$18,500' },
          ],
          valueCents: 1_850_000,
        },
      ],
    };
    expect(AssistantCard.safeParse(now).success).toBe(true);
    const item = now.items[0]!;
    expect(
      AssistantCard.safeParse({ ...now, items: [{ ...item, href: `/app/w/${ws}?item=<b>` }] })
        .success,
    ).toBe(false);
    expect(
      AssistantCard.safeParse({ ...now, items: [{ ...item, href: 'https://example.com/?item=1' }] })
        .success,
    ).toBe(false);
    expect(
      AssistantCard.safeParse({ ...now, affected: { ...now.affected, scope: 'team' } }).success,
    ).toBe(false);
  });
});

describe('crm.metrics', () => {
  it('counts leads, new customers, texts, emails and calls in the period, and nothing outside it', async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const stages = (await ask(pipelineList, { workspaceId: wsId }, owner)).pipelines[0]!.stages;
    const stage = (n: string) => stages.find((s) => s.name === n)!.id;
    const person = async (firstName: string) =>
      (await run(personCreate, { workspaceId: wsId, firstName, lastName: 'Metrics' }, member))
        .output.personId;
    const sam = await person('Sam');
    await person('Pat');
    const old = await person('Old');
    const gone = await person('Gone');
    await run(personArchive, { workspaceId: wsId, personId: gone }, owner);
    const lead = async (title: string, valueCents = 0) =>
      (await run(leadCreate, { workspaceId: wsId, title, personId: sam, valueCents }, member))
        .output.leadId;
    const won = await lead('Won job', 450000);
    const lost = await lead('Lost job', 120000);
    await lead('Open job');
    const oldLead = await lead('Old job');
    const archived = await lead('Archived job');
    await run(leadMoveStage, { workspaceId: wsId, leadId: won, stageId: stage('Won') }, member);
    await run(
      leadMoveStage,
      { workspaceId: wsId, leadId: lost, stageId: stage('Lost'), lostReason: 'Price' },
      member,
    );
    await run(leadArchive, { workspaceId: wsId, leadId: archived }, owner);
    // Ten days ago: outside the first period, inside the second.
    await rows(
      admin(),
      sql`update app.people set created_at = now() - interval '10 days' where id = ${old}`,
    );
    await rows(
      admin(),
      sql`update app.leads set created_at = now() - interval '10 days' where id = ${oldLead}`,
    );
    await worker(async (tx) => {
      const [sms] = await rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
            values (${wsId}, 'sms', '+17135550142', ${sam}) returning id`,
      );
      const [email] = await rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
            values (${wsId}, 'email', 'sam@example.com', ${sam}) returning id`,
      );
      await tx.execute(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, occurred_at) values
        (${wsId}, ${sms!.id}, 'sms', 'inbound', 'received', now()),
        (${wsId}, ${sms!.id}, 'sms', 'inbound', 'received', now()),
        (${wsId}, ${sms!.id}, 'sms', 'inbound', 'received', now() - interval '10 days'),
        (${wsId}, ${sms!.id}, 'sms', 'outbound', 'delivered', now()),
        (${wsId}, ${sms!.id}, 'sms', 'outbound', 'queued', now()),
        (${wsId}, ${sms!.id}, 'sms', 'outbound', 'failed', now()),
        (${wsId}, ${email!.id}, 'email', 'inbound', 'received', now()),
        (${wsId}, ${email!.id}, 'email', 'outbound', 'sent', now())`);
      // Answered, missed, voicemail (missed too), still ringing (not missed yet), outbound, and an old missed call.
      await tx.execute(sql`insert into app.calls (workspace_id, direction, status, started_at, answered_at, is_voicemail) values
        (${wsId}, 'inbound', 'completed', now(), now(), false),
        (${wsId}, 'inbound', 'no_answer', now(), null, false),
        (${wsId}, 'inbound', 'completed', now(), null, true),
        (${wsId}, 'inbound', 'ringing', now(), null, false),
        (${wsId}, 'outbound', 'completed', now(), now(), false),
        (${wsId}, 'inbound', 'no_answer', now() - interval '10 days', null, false)`);
    });

    expect(await ask(crmMetrics, { workspaceId: wsId, since }, member)).toEqual({
      leadsCreated: 3,
      leadsWon: 1,
      leadsLost: 1,
      wonValueCents: 450000,
      newPeople: 2,
      textsIn: 2,
      textsOut: 2,
      emailsIn: 1,
      emailsOut: 1,
      callsIn: 4,
      callsOut: 1,
      callsMissed: 2,
    });
    const day = 86_400_000;
    const earlier = await ask(
      crmMetrics,
      {
        workspaceId: wsId,
        since: new Date(Date.now() - 11 * day).toISOString(),
        until: new Date(Date.now() - day).toISOString(),
      },
      member,
    );
    expect(earlier).toEqual({
      leadsCreated: 1,
      leadsWon: 0,
      leadsLost: 0,
      wonValueCents: 0,
      newPeople: 1,
      textsIn: 1,
      textsOut: 0,
      emailsIn: 0,
      emailsOut: 0,
      callsIn: 1,
      callsOut: 0,
      callsMissed: 1,
    });
    await expectHfos(() => ask(crmMetrics, { workspaceId: wsId, since }, outsider), 'not_found');
    await expectHfos(() => ask(crmMetrics, { workspaceId: wsId }, member), 'validation');
  });
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/**
 * A chat for `user` as the worker writes it: the thread, a finished run, the question and an answer
 * with cards, and the answer's tool calls.
 */
function chat(user: TestUser, title: string, lastMessageAt = minutesAgo(0)) {
  const cards = [
    {
      type: 'numbers',
      label: 'Leads today',
      value: '3',
      delta: null,
      stats: [{ value: '1', label: 'Won' }],
      href: `/app/w/${wsId}/pipeline`,
    },
    // A link outside the app never reaches the panel.
    {
      type: 'numbers',
      label: 'Elsewhere',
      value: '1',
      delta: null,
      stats: [],
      href: 'https://example.com/',
    },
  ];
  return worker(async (tx) => {
    const [t] = await rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_threads (workspace_id, user_id, title, last_message_at)
          values (${wsId}, ${user.id}, ${title}, ${lastMessageAt}::timestamptz) returning id`,
    );
    const [r] = await rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id, status)
          values (${wsId}, ${user.id}, ${t!.id}, 'scripted', gen_random_uuid(), 'done') returning id`,
    );
    await tx.execute(sql`insert into app.assistant_messages (workspace_id, user_id, thread_id, role, text, cards, run_id, created_at) values
      (${wsId}, ${user.id}, ${t!.id}, 'user', ${title}, '[]', ${r!.id}, now() - interval '2 seconds'),
      (${wsId}, ${user.id}, ${t!.id}, 'assistant', 'Three came in today.', ${JSON.stringify(cards)}::jsonb, ${r!.id}, now() - interval '1 second')`);
    await tx.execute(sql`insert into app.assistant_tool_calls (workspace_id, user_id, thread_id, run_id, tool, autonomy, status, result, error, created_at) values
      (${wsId}, ${user.id}, ${t!.id}, ${r!.id}, 'business_numbers', 'auto', 'done',
        ${JSON.stringify({ outcome: 'Counted today’s leads', href: `/app/w/${wsId}/pipeline` })}::jsonb, null, now() - interval '3 seconds'),
      (${wsId}, ${user.id}, ${t!.id}, ${r!.id}, 'send_text', 'confirm', 'awaiting_confirmation', null, null, now() - interval '2 seconds'),
      (${wsId}, ${user.id}, ${t!.id}, ${r!.id}, 'move_lead', 'confirm', 'failed',
        ${JSON.stringify({ href: 'javascript:alert(1)' })}::jsonb, 'That stage is not in this pipeline.', now() - interval '1 second')`);
    return t!.id;
  });
}

describe('Assistant chats', () => {
  let mine: string;
  let older: string;
  let owners: string;
  beforeAll(async () => {
    older = await chat(member, 'Leads this week', minutesAgo(60));
    mine = await chat(member, 'How many leads today?');
    owners = await chat(owner, 'What needs attention?');
  });

  it('list shows only your own chats, most recent first; a teammate and an owner see none of them', async () => {
    const list = await ask(assistantThreadList, { workspaceId: wsId }, member);
    expect(list.items.map((t) => t.id)).toEqual([mine, older]);
    expect(list.items[0]).toMatchObject({ title: 'How many leads today?' });
    const limited = await ask(assistantThreadList, { workspaceId: wsId, limit: 1 }, member);
    expect(limited.items.map((t) => t.id)).toEqual([mine]);
    const ownerList = await ask(assistantThreadList, { workspaceId: wsId }, owner);
    expect(ownerList.items.map((t) => t.id)).toEqual([owners]);
    expect((await ask(assistantThreadList, { workspaceId: wsId }, teammate)).items).toEqual([]);
    await expectHfos(() => ask(assistantThreadList, { workspaceId: wsId }, outsider), 'not_found');
  });

  it('get returns the messages oldest first with their cards, and where each tool call stands', async () => {
    const got = await ask(assistantThreadGet, { workspaceId: wsId, threadId: mine }, member);
    expect(got.thread).toMatchObject({ id: mine, title: 'How many leads today?' });
    expect(got.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'How many leads today?'],
      ['assistant', 'Three came in today.'],
    ]);
    // The card linking outside the app is dropped; the good one comes back whole.
    expect(got.messages[1]!.cards).toEqual([
      {
        type: 'numbers',
        label: 'Leads today',
        value: '3',
        delta: null,
        stats: [{ value: '1', label: 'Won' }],
        href: `/app/w/${wsId}/pipeline`,
      },
    ]);
    expect(got.toolCalls).toMatchObject([
      {
        tool: 'business_numbers',
        status: 'done',
        outcome: 'Counted today’s leads',
        href: `/app/w/${wsId}/pipeline`,
        error: null,
      },
      {
        tool: 'send_text',
        status: 'awaiting_confirmation',
        outcome: null,
        href: null,
        error: null,
      },
      {
        tool: 'move_lead',
        status: 'failed',
        outcome: null,
        href: null,
        error: 'That stage is not in this pipeline.',
      },
    ]);
  });

  it('someone else’s chat is not found, even for an owner', async () => {
    for (const u of [owner, teammate]) {
      await expectHfos(
        () => ask(assistantThreadGet, { workspaceId: wsId, threadId: mine }, u),
        'not_found',
      );
    }
    await expectHfos(
      () => ask(assistantThreadGet, { workspaceId: wsId, threadId: randomUUID() }, member),
      'not_found',
    );
    await expectHfos(
      () =>
        run(assistantThreadRename, { workspaceId: wsId, threadId: mine, title: 'Mine now' }, owner),
      'not_found',
    );
    await expectHfos(
      () => run(assistantThreadArchive, { workspaceId: wsId, threadId: mine }, teammate),
      'not_found',
    );
    const [t] = await rows<{ title: string; archived: boolean }>(
      admin(),
      sql`select title, archived_at is not null as archived from app.assistant_threads where id = ${mine}`,
    );
    expect(t).toEqual({ title: 'How many leads today?', archived: false });
  });

  it('renames and archives your own chat without an event; an archived chat leaves the list', async () => {
    const corr = randomUUID();
    const renamed = await run(
      assistantThreadRename,
      { workspaceId: wsId, threadId: mine, title: '  Leads today  ' },
      member,
      meta(corr),
    );
    expect(renamed.output).toEqual({ threadId: mine });
    expect(renamed.eventIds).toEqual([]);
    const [trail] = await rows<{ n: number }>(
      admin(),
      sql`select ((select count(*) from app.events where correlation_id = ${corr})
            + (select count(*) from app.audit_logs where correlation_id = ${corr}))::int as n`,
    );
    expect(trail!.n).toBe(0);
    let list = await ask(assistantThreadList, { workspaceId: wsId }, member);
    expect(list.items.find((t) => t.id === mine)?.title).toBe('Leads today');
    await expectHfos(
      () => run(assistantThreadRename, { workspaceId: wsId, threadId: mine, title: '   ' }, member),
      'validation',
    );

    const archived = await run(
      assistantThreadArchive,
      { workspaceId: wsId, threadId: mine },
      member,
    );
    expect(archived.eventIds).toEqual([]);
    list = await ask(assistantThreadList, { workspaceId: wsId }, member);
    expect(list.items.map((t) => t.id)).toEqual([older]);
    // Archiving again keeps the first time, and the chat still opens from a link.
    const archivedAt = () =>
      rows<{ at: Date }>(
        admin(),
        sql`select archived_at as at from app.assistant_threads where id = ${mine}`,
      ).then((r) => r[0]!.at);
    const first = await archivedAt();
    await run(assistantThreadArchive, { workspaceId: wsId, threadId: mine }, member);
    expect(await archivedAt()).toEqual(first);
    const got = await ask(assistantThreadGet, { workspaceId: wsId, threadId: mine }, member);
    expect(got.thread.title).toBe('Leads today');
  });
});
