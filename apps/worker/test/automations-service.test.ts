/**
 * Settings → Automations' service, hand-offs and revenue (stage 4a), on the real database:
 * - a hand-off nobody picked up gets another push at 1 hour and the owners told at 4, unless someone takes it;
 * - a regular who stopped coming gets a card;
 * - a promise the team made ("I'll send the quote tomorrow") is read from their own message, opens a card once
 *   its time has passed with nothing sent, and closes once something is;
 * - a workflow approval with a day to run gets another push two hours before it expires;
 * - a Monday with last week far below the usual week gets the money card;
 * - "Add tasks from what you say": what someone on the team writes they'll do, and what they said on a phone call,
 *   is a task on their list, made without asking.
 */
import {
  addDays,
  appointmentCreate,
  callAttachTranscript,
  callRecord,
  callSuggestionList,
  callUpdateStatus,
  localDateOf,
  localInstant,
  mondayOf,
  conversationHandOff,
  conversationTakeOver,
  messageSend,
  pushDeviceRegister,
  workflowEnrol,
  type WorkflowDefinitionInput,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONVERSATION_TASKS_JOB,
  conversationTasksKey,
  EXPIRING_JOB,
  expiringJobKey,
  HANDOFF_NUDGE_JOB,
  handoffNudgeKey,
} from '../src/automations/index';
import { scriptedAi } from '../src/ai/scripted';
import { textIn } from './ai-team-world';
import {
  attentionWorld,
  filedCustomer,
  itemOf,
  runSweep,
  sys,
  type AttentionWorld,
} from './attention-world';
import {
  admin,
  at,
  CHI,
  drain,
  HOUR,
  iso,
  jobRow,
  makeCalendar,
  query,
  run,
} from './booking-world';
import type { TestServices } from './helpers';
import { addWorkflow, sid } from './workflow-world';

const DAY = 86_400_000;
let w: AttentionWorld;
let calendar: { id: string; slug: string };

beforeAll(async () => {
  w = await attentionWorld('svc');
  // The scripted model reads the promises.
  Object.assign(w, {
    s: { ...w.s, ai: { provider: scriptedAi() } } as TestServices,
  });
  calendar = await makeCalendar(w, 'AC tune-up');
  await run(w, pushDeviceRegister, {
    platform: 'ios',
    token: `ExponentPushToken[svc-${w.workerId.slice(-8)}]`,
    appVersion: '1.0.0',
    deviceName: 'Dale’s phone',
  });
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

/** Runs a pending job now. */
async function runNow(kind: string, dedupeKey: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now() - interval '1 second'
        where kind = ${kind} and dedupe_key = ${dedupeKey} and status = 'pending'`,
  );
  await drain(w);
}

/** Settings → Automations' "Add tasks from what you say", on or off. */
const setAiTasks = (on: boolean) =>
  rows(
    admin(),
    sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('automations',
          coalesce(settings->'automations', '{}'::jsonb) || jsonb_build_object('switches',
            coalesce(settings->'automations'->'switches', '{}'::jsonb) || jsonb_build_object('aiTasks', ${on}::boolean)))
        where id = ${w.workspaceId}`,
  );

const pushes = (keyPrefix: string) =>
  rows<{ title: string; user_ids: string[] }>(
    admin(),
    sql`select payload ->> 'title' as title,
          array(select jsonb_array_elements_text(payload -> 'userIds')) as user_ids
        from app.scheduled_jobs
        where kind = 'push.send' and dedupe_key like ${`push:${keyPrefix}%`}
        order by created_at`,
  );

describe('a hand-off nobody picked up', () => {
  async function handedOff(first: string) {
    const c = await filedCustomer(w, first);
    const { conversationId } = await textIn(w, c.phone, 'Can someone call me about the noise?');
    await sys(w, conversationHandOff, {
      workspaceId: w.workspaceId,
      conversationId,
      reason: 'other',
      note: 'Wants a call',
    });
    await drain(w);
    return conversationId;
  }

  it('pushes again at 1 hour, and tells the owners at 4 with an email and a line on the card', async () => {
    const conv = await handedOff('Hal');
    expect((await jobRow(handoffNudgeKey(conv, 1)))?.status).toBe('pending');
    expect((await jobRow(handoffNudgeKey(conv, 2)))?.status).toBe('pending');

    await runNow(HANDOFF_NUDGE_JOB, handoffNudgeKey(conv, 1));
    const [first] = await pushes(handoffNudgeKey(conv, 1));
    expect(first).toMatchObject({ title: 'Still waiting for a person · Hal Test' });
    expect(first!.user_ids).toContain(w.owner.id);

    await runNow(HANDOFF_NUDGE_JOB, handoffNudgeKey(conv, 2));
    expect(await pushes(handoffNudgeKey(conv, 2))).toHaveLength(1);
    const [told] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where event_type = 'conversation.handoff_escalated' and entity_id = ${conv}`,
    );
    expect(told!.n).toBe(1);
    // Its card opens 15 minutes after the hand-off.
    await runSweep(w, Date.now() + 5 * HOUR);
    const card = await itemOf(w, conv, 'customer_waiting');
    expect(card.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'handed_off', label: 'handed to a person · owner told' }),
      ]),
    );
  });

  it('sends nothing more once someone takes it over', async () => {
    const conv = await handedOff('Ivy');
    await run(w, conversationTakeOver, { workspaceId: w.workspaceId, conversationId: conv });
    await drain(w);
    await runNow(HANDOFF_NUDGE_JOB, handoffNudgeKey(conv, 1));
    await runNow(HANDOFF_NUDGE_JOB, handoffNudgeKey(conv, 2));
    expect(await pushes(handoffNudgeKey(conv, 1))).toHaveLength(0);
    expect(await pushes(handoffNudgeKey(conv, 2))).toHaveLength(0);
  });
});

describe('a regular gone quiet', () => {
  /** A visit done `daysAgo` days ago, straight into the table's history. */
  async function pastVisit(personId: string, daysAgo: number): Promise<void> {
    const { appointmentId } = await run(w, appointmentCreate, {
      workspaceId: w.workspaceId,
      calendarId: calendar.id,
      startsAt: iso(at(3, '09:00')),
      personId,
      notify: false,
    });
    await drain(w);
    const start = Date.now() - daysAgo * DAY;
    await rows(
      admin(),
      sql`update app.appointments set status = 'completed', starts_at = ${iso(start)}::timestamptz,
            ends_at = ${iso(start + HOUR)}::timestamptz where id = ${appointmentId}`,
    );
    await rows(
      admin(),
      sql`update app.appointment_attendees set status = 'attended' where appointment_id = ${appointmentId}`,
    );
  }

  it('opens a card for someone who came every 4 months and hasn’t in 10', async () => {
    const jo = await filedCustomer(w, 'Jo');
    for (const days of [540, 420, 300]) await pastVisit(jo.id, days);
    // Their messages are old too: the last contact was around their last visit.
    await runSweep(w);
    const card = await itemOf(w, jo.id, 'client_quiet');
    expect(card.state).toBe('open');
    expect(card.title).toBe('Jo Test · 3 visits');
  });

  it('leaves alone someone with only two visits', async () => {
    const kit = await filedCustomer(w, 'Kit');
    for (const days of [420, 300]) await pastVisit(kit.id, days);
    await runSweep(w);
    const [none] = await rows(
      admin(),
      sql`select 1 from app.attention_items where subject_id = ${kit.id} and kind = 'client_quiet'`,
    );
    expect(none).toBeUndefined();
  });
});

describe('promises not kept', () => {
  it('reads a promise from the team’s message, flags it once late, and clears it when something is sent', async () => {
    const lu = await filedCustomer(w, 'Lu');
    const asked = await textIn(w, lu.phone, 'Can I get a price for the new unit?');
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: asked.conversationId,
      channel: 'sms',
      body: 'Sure thing, I’ll send the quote tomorrow.',
    });
    await drain(w);
    const [promise] = await rows<{ id: string; what: string; kind: string; due_at: Date }>(
      admin(),
      sql`select id, what, kind, due_at from app.promises where person_id = ${lu.id}`,
    );
    expect(promise).toMatchObject({ what: 'send the quote', kind: 'send' });
    const due = new Date(promise!.due_at).getTime();
    expect(due).toBe(localInstant(addDays(localDateOf(Date.now(), CHI), 1), '17:00', CHI));
    // Made a while ago, so what goes next isn't "the same breath".
    await rows(
      admin(),
      sql`update app.promises set created_at = created_at - interval '1 hour' where id = ${promise!.id}`,
    );
    await rows(
      admin(),
      sql`update app.messages set created_at = created_at - interval '1 hour'
          where conversation_id = ${asked.conversationId}`,
    );

    const late = due + 2 * HOUR;
    await runSweep(w, late);
    const card = await itemOf(w, promise!.id, 'promise_due');
    expect(card.state).toBe('open');
    expect(card.reasons[0]).toMatchObject({ code: 'promise' });

    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: asked.conversationId,
      channel: 'sms',
      body: 'Here it is: $4,800 installed.',
    });
    await drain(w);
    await runSweep(w, late);
    const kept = await itemOf(w, promise!.id, 'promise_due');
    expect(kept.state).toBe('resolved');
    expect(kept.resolution).toBe('done');
  });
});

describe('tasks from what you say', () => {
  const tasksOf = (personId: string) =>
    rows<{
      title: string;
      assignee_user_id: string | null;
      due_at: Date | null;
      all_day: boolean;
      notes: string | null;
    }>(
      admin(),
      sql`select title, assignee_user_id, due_at, all_day, notes from app.tasks
          where person_id = ${personId} order by created_at`,
    );

  it('adds a task for what someone wrote they’d do: theirs, due when they said, and read once', async () => {
    const ned = await filedCustomer(w, 'Ned');
    const asked = await textIn(w, ned.phone, 'Can I get a price for the new unit?');
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: asked.conversationId,
      channel: 'sms',
      body: 'Sure thing, I’ll send the quote tomorrow.',
    });
    await drain(w);
    // Read a couple of minutes later, so a burst of messages is one read.
    const key = conversationTasksKey(asked.conversationId);
    expect((await jobRow(key))?.status).toBe('pending');
    await runNow(CONVERSATION_TASKS_JOB, key);
    const tomorrow = addDays(localDateOf(Date.now(), CHI), 1);
    expect(await tasksOf(ned.id)).toEqual([
      {
        title: 'Send Ned the quote',
        assignee_user_id: w.owner.id,
        due_at: new Date(localInstant(tomorrow, '00:00', CHI)),
        all_day: true,
        notes: 'Added by the AI from your text to Ned Test.',
      },
    ]);

    // Something that promises nothing makes nothing, and what was read isn't read again.
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: asked.conversationId,
      channel: 'sms',
      body: 'Thanks for your patience!',
    });
    await drain(w);
    await runNow(CONVERSATION_TASKS_JOB, key);
    expect(await tasksOf(ned.id)).toHaveLength(1);
    const [mark] = await rows<{ tasks: number }>(
      admin(),
      sql`select tasks from app.conversation_task_reads where conversation_id = ${asked.conversationId}`,
    );
    expect(mark!.tasks).toBe(1);
  });

  it('reads nothing the AI teammate or an automatic message sent, nor anything while it’s off', async () => {
    const ola = await filedCustomer(w, 'Ola');
    const asked = await textIn(w, ola.phone, 'Can you come by Friday?');
    // An automatic message: nobody on the team wrote it.
    await sys(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: asked.conversationId,
      channel: 'sms',
      body: 'We’ll swing by Friday at 10.',
    });
    await drain(w);
    expect(await jobRow(conversationTasksKey(asked.conversationId))).toBeUndefined();

    await setAiTasks(false);
    try {
      await run(w, messageSend, {
        workspaceId: w.workspaceId,
        conversationId: asked.conversationId,
        channel: 'sms',
        body: 'Sure, I’ll swing by Friday at 10.',
      });
      await drain(w);
      expect(await jobRow(conversationTasksKey(asked.conversationId))).toBeUndefined();
    } finally {
      await setAiTasks(true);
    }
    expect(await tasksOf(ola.id)).toEqual([]);
  });

  it('sums up a phone call on the business number and adds its task; the email waits for a person', async () => {
    const pia = await filedCustomer(w, 'Pia');
    const providerSid = `CAtasks${Date.now()}`;
    const call = { workspaceId: w.workspaceId, providerSid };
    const { callId } = await sys(w, callRecord, {
      ...call,
      direction: 'inbound',
      from: pia.phone,
      to: w.number!,
    });
    await sys(w, callUpdateStatus, {
      ...call,
      status: 'in_progress',
      answeredVia: 'browser',
      answeredByUserId: w.owner.id,
    });
    await sys(w, callUpdateStatus, { ...call, status: 'completed', durationSeconds: 140 });
    await sys(w, callAttachTranscript, {
      ...call,
      transcript: 'Dale: I’ll send you the quote by Friday.\nPia: Great, thanks.',
      status: 'completed',
    });
    await drain(w);

    const review = await query(w, callSuggestionList, { workspaceId: w.workspaceId, callId });
    expect(review.summary).toContain('I’ll send you the quote by Friday.');
    expect(review.transcript).toContain('Pia: Great, thanks.');
    expect(review.items.map((i) => [i.kind, i.status])).toEqual([
      ['task', 'approved'],
      ['follow_up', 'pending'],
    ]);
    // The summary is the call's line on her timeline; the words stay on the call.
    const [line] = await rows<{ body: string }>(
      admin(),
      sql`select a.body from app.activities a join app.calls k on k.activity_id = a.id where k.id = ${callId}`,
    );
    expect(line!.body).toBe(review.summary);
    expect(await tasksOf(pia.id)).toEqual([
      expect.objectContaining({
        title: 'Send the quote',
        assignee_user_id: w.owner.id,
        notes: 'Added by the AI from your call with Pia Test.',
      }),
    ]);
    // Reviewed once: its words coming in again change nothing.
    await sys(w, callAttachTranscript, {
      ...call,
      transcript: 'Dale: I’ll send you the quote by Friday.\nPia: Great, thanks.',
      status: 'completed',
    });
    await drain(w);
    expect(await tasksOf(pia.id)).toHaveLength(1);
    const [still] = await rows<{ body: string }>(
      admin(),
      sql`select a.body from app.activities a join app.calls k on k.activity_id = a.id where k.id = ${callId}`,
    );
    expect(still!.body).toBe(review.summary);
  });

  it('leaves a voicemail alone: nobody on the team was on it', async () => {
    const quin = await filedCustomer(w, 'Quin');
    const providerSid = `CAvm${Date.now()}`;
    const call = { workspaceId: w.workspaceId, providerSid };
    const { callId } = await sys(w, callRecord, {
      ...call,
      direction: 'inbound',
      from: quin.phone,
      to: w.number!,
    });
    await sys(w, callUpdateStatus, { ...call, status: 'no_answer' });
    await sys(w, callAttachTranscript, {
      ...call,
      transcript: 'Hi, can you send me the quote?',
      status: 'completed',
    });
    await drain(w);
    expect(await jobRow(`appointment.call_review:call:${callId}`)).toBeUndefined();
    expect(await tasksOf(quin.id)).toEqual([]);
  });
});

describe('approvals about to expire', () => {
  it('pushes whoever can decide two hours before a day-long approval runs out', async () => {
    const def: WorkflowDefinitionInput = {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: sid('xappr'),
          type: 'approval',
          message: 'OK to send the offer?',
          expiresAfter: { amount: 1, unit: 'days' },
          onExpire: 'end',
          rejected: { steps: [] },
        },
      ],
    };
    const { id: workflowId } = await addWorkflow(w, 'Offer check', def);
    const mo = await filedCustomer(w, 'Mo');
    await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId, personId: mo.id });
    await drain(w);
    const [a] = await rows<{ id: string; expires_at: Date }>(
      admin(),
      sql`select id, expires_at from app.workflow_approvals where workflow_id = ${workflowId}`,
    );
    const job = await jobRow(expiringJobKey('workflow', a!.id));
    expect(new Date(job!.run_at).getTime()).toBe(new Date(a!.expires_at).getTime() - 2 * HOUR);
    await runNow(EXPIRING_JOB, expiringJobKey('workflow', a!.id));
    const [push] = await pushes(expiringJobKey('workflow', a!.id));
    expect(push!.title).toMatch(/^Expires in 2 h · /);
  });
});

describe('money in changed', () => {
  it('opens on Monday when last week was far below the usual week', async () => {
    // A business of its own, so no other test's money counts.
    const m = await attentionWorld('rev');
    const monday = mondayOf(Date.now(), CHI);
    const lu = await filedCustomer(m, 'Nan');
    const [inv] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.invoices (workspace_id, person_id, status, total_cents, subtotal_cents)
          values (${m.workspaceId}, ${lu.id}, 'draft', 0, 0) returning id`,
    );
    const pay = async (daysBeforeMonday: number, cents: number) => {
      const when = localInstant(addDays(monday, -daysBeforeMonday), '12:00', CHI);
      await rows(
        admin(),
        sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
            values (${m.workspaceId}, ${inv!.id}, ${cents}, 'cash', 'succeeded', ${iso(when)}::timestamptz)`,
      );
    };
    // Eight usual weeks of $9,000, and last week $3,000.
    for (let k = 1; k <= 8; k++) await pay(7 * k + 3, 900_000);
    await pay(3, 300_000);
    await runSweep(m, localInstant(monday, '09:00', CHI));
    const card = await itemOf(m, m.workspaceId, 'revenue_moved');
    expect(card.state).toBe('open');
    expect(card.reasons[0]).toMatchObject({
      code: 'revenue',
      label: '$3,000 last week · usually $9,000 (−67%)',
    });
    await m.app.close();
  });
});
