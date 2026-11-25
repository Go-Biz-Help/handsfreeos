/**
 * What a person asks the Assistant to do on its own (20261027036600, the owner, 25 Nov 2026), on the real database with
 * the stand-in push sender and Mailpit:
 * - **A task's reminder:** a task due at a time pings whoever has it then, with Done and In 1 hour; one ticked off
 *   first, or due on a day with no time, says nothing.
 * - **A question on a schedule** is asked as the person, in its own chat, with look-ups only: the start of the answer
 *   goes to their phone, all of it by email when they said so, and its next time is armed.
 * - **Alerts:** a watched customer writing tells the person once, then the alert pauses; a big invoice paid tells
 *   whoever watches for it, never the person who marked it paid; a low review tells whoever asked about one.
 */
import { randomUUID } from 'node:crypto';
import { ScriptedProvider, type AiProvider, type AiRequest } from '@hfos/ai';
import {
  assistantRoutineCreate,
  executeCommand,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  PushData,
  pushDeviceRegister,
  taskComplete,
  taskCreate,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToolExecutor } from '../src/assistant/tools-write';
import { processJobs } from '../src/jobs';
import type { FakePushSent, PushMessage } from '../src/push/index';
import { alertOnReview } from '../src/reminders/alerts';
import { routineQuestionKey } from '../src/reminders/questions';
import { taskDueKey } from '../src/reminders/task-due';
import { jobs } from '../src/scheduled';
import { textIn } from './ai-team-world';
import { consentToAssistant } from './assistant-consent';
import { attentionWorld, filedCustomer, type AttentionWorld } from './attention-world';
import { admin, api, drain, jobRow, run, runDue, waitForMail } from './booking-world';

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const as = <T = unknown>(u: TestUser, cmd: CommandDef, input: unknown): Promise<T> =>
  executeCommand(api(), cmd, input, actorOf(u), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output as T);

const dataOf = (m: PushMessage) => PushData.parse(m.data);

let w: AttentionWorld;
let daleToken: string;
let marcoToken: string;

async function phoneOf(u: TestUser, label: string): Promise<string> {
  const token = `ExponentPushToken[${label}-${randomUUID().slice(0, 12)}]`;
  await as(u, pushDeviceRegister, {
    platform: 'ios',
    token,
    appVersion: '1.0.0',
    deviceName: label,
  });
  return token;
}

const sent = (): readonly FakePushSent[] => w.s.push.fake.sent;
/** What reached one phone since `from`, of one kind. */
const pushesTo = (token: string, category: string, from = 0) =>
  sent()
    .slice(from)
    .map((s) => s.message)
    .filter((m) => m.to === token && dataOf(m).category === category);

beforeAll(async () => {
  w = await attentionWorld('routines');
  daleToken = await phoneOf(w.owner, 'dale-iphone');
  marcoToken = await phoneOf(w.member, 'marco-iphone');
  await consentToAssistant(w.owner);
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('a task’s reminder', () => {
  it('pings whoever has it at its time, with Done and In 1 hour', async () => {
    const due = new Date(Date.now() + 5 * 60_000);
    due.setSeconds(0, 0);
    const { taskId } = await run(w, taskCreate, {
      workspaceId: w.workspaceId,
      title: 'Call Bob back about the quote',
      dueAt: due.toISOString(),
      allDay: false,
    });
    await drain(w);
    const armed = await jobRow(taskDueKey(taskId));
    expect(armed?.status).toBe('pending');
    expect(new Date(armed!.run_at).getTime()).toBe(due.getTime());

    const before = sent().length;
    await runDue(w, [taskDueKey(taskId)]);
    const [ping] = pushesTo(daleToken, 'task_due', before);
    expect(ping).toMatchObject({ title: 'Reminder', body: 'Call Bob back about the quote' });
    const data = dataOf(ping!);
    expect(data.refs).toMatchObject({ taskId });
    expect(Object.keys(data.commandIds).sort()).toEqual(['task_done', 'task_later']);
    expect(data.path).toBe(`/app/w/${w.workspaceId}/tasks`);
  });

  it('says nothing for one ticked off first, or one due on a day with no time', async () => {
    const due = new Date(Date.now() + 10 * 60_000);
    const { taskId } = await run(w, taskCreate, {
      workspaceId: w.workspaceId,
      title: 'Order filters',
      dueAt: due.toISOString(),
      allDay: false,
    });
    await drain(w);
    await run(w, taskComplete, { workspaceId: w.workspaceId, taskId });
    const before = sent().length;
    await runDue(w, [taskDueKey(taskId)]);
    expect(pushesTo(daleToken, 'task_due', before)).toEqual([]);

    const day = await run(w, taskCreate, {
      workspaceId: w.workspaceId,
      title: 'Send the invoice',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await drain(w);
    expect(await jobRow(taskDueKey(day.taskId))).toBeUndefined();
  });
});

describe('a question on a schedule', () => {
  it('is asked as the person with look-ups only, its answer to their phone and email, and its next time armed', async () => {
    const asked: AiRequest[] = [];
    const inner = new ScriptedProvider([
      {
        when: /owes me money/i,
        reply: () => '**2 customers** owe you **$300**:\n- Elena: $180\n- Mike: $120',
      },
    ]);
    const provider: AiProvider = {
      id: 'scripted',
      model: 'scripted',
      stream: (request, options) => {
        asked.push(request);
        return inner.stream(request, options);
      },
    };
    const assistant = { provider, tools: createToolExecutor(testDbs().worker.db) };
    const { routineId } = await run(w, assistantRoutineCreate, {
      workspaceId: w.workspaceId,
      kind: 'question',
      question: 'Who owes me money?',
      cadence: { every: 'weekly', days: [1], at: '08:00' },
      email: true,
    });
    await drain(w);
    expect((await jobRow(routineQuestionKey(routineId)))?.status).toBe('pending');

    // Its time has come.
    await rows(
      admin(),
      sql`update app.assistant_routines set next_run_at = now() where id = ${routineId}`,
    );
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${w.workerId}
          where dedupe_key = ${routineQuestionKey(routineId)} and status = 'pending'`,
    );
    const before = sent().length;
    const stats = await processJobs({
      ...w.s,
      assistant,
      jobs,
      workerId: w.workerId,
      batchSize: 10,
      reservedOnly: true,
    });
    expect(stats.failed + stats.retried).toBe(0);
    await drain(w);

    // Look-ups only: nothing that changes, sends or books was offered.
    const offered = asked.flatMap((r) => r.tools?.map((t) => t.name) ?? []);
    expect(offered.length).toBeGreaterThan(0);
    for (const name of ['send_text', 'create_task', 'book_appointment', 'schedule_question'])
      expect(offered).not.toContain(name);

    const [answer] = pushesTo(daleToken, 'assistant_answer', before);
    expect(answer).toMatchObject({
      title: 'Who owes me money?',
      body: '2 customers owe you $300: Elena: $180 Mike: $120',
    });
    const [r] = await rows<{
      thread_id: string | null;
      last_run_at: Date | null;
      next_run_at: Date;
    }>(
      admin(),
      sql`select thread_id, last_run_at, next_run_at from app.assistant_routines where id = ${routineId}`,
    );
    expect(r?.thread_id).not.toBeNull();
    expect(r?.last_run_at).not.toBeNull();
    expect(new Date(r!.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(dataOf(answer!).path).toBe(`/app/w/${w.workspaceId}/assistant?chat=${r!.thread_id}`);
    const next = await jobRow(routineQuestionKey(routineId));
    expect(next?.status).toBe('pending');
    expect(new Date(next!.run_at).getTime()).toBe(new Date(r!.next_run_at).getTime());

    const mail = await waitForMail(w.owner.email, 'Who owes me money?');
    expect(mail.text).toContain('2 customers owe you $300');
    expect(mail.text).toContain('Settings, then Notifications');
  });
});

describe('alerts', () => {
  it('tells the person once when a watched customer writes, then pauses', async () => {
    const c = await filedCustomer(w, 'Elena');
    const { routineId } = await run(w, assistantRoutineCreate, {
      workspaceId: w.workspaceId,
      kind: 'alert',
      watch: { on: 'reply', personId: c.id },
    });
    await drain(w);
    const before = sent().length;
    await textIn(w, c.phone, 'Is Tuesday still OK for the install?');
    await drain(w);
    const told = pushesTo(daleToken, 'assistant_alert', before);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      title: 'Elena Test wrote',
      body: 'Is Tuesday still OK for the install?',
    });
    expect(dataOf(told[0]!).refs).toMatchObject({ personId: c.id });
    const [r] = await rows<{ paused_at: Date | null; fired_count: number }>(
      admin(),
      sql`select paused_at, fired_count from app.assistant_routines where id = ${routineId}`,
    );
    expect(r?.paused_at).not.toBeNull();
    expect(Number(r?.fired_count)).toBe(1);

    const again = sent().length;
    await textIn(w, c.phone, 'Also, can you bring the filter?');
    await drain(w);
    expect(pushesTo(daleToken, 'assistant_alert', again)).toEqual([]);
  });

  it('tells whoever watches for a big payment, never the person who marked it paid', async () => {
    await as(w.member, assistantRoutineCreate, {
      workspaceId: w.workspaceId,
      kind: 'alert',
      watch: { on: 'payment', atLeastCents: 10_000 },
    });
    await run(w, assistantRoutineCreate, {
      workspaceId: w.workspaceId,
      kind: 'alert',
      watch: { on: 'payment', atLeastCents: 10_000 },
    });
    const c = await filedCustomer(w, 'Mike');
    // Marco sees a customer's money when the customer is his.
    await admin().execute(
      sql`update app.people set owner_user_id = ${w.member.id} where id = ${c.id}`,
    );
    const { invoiceId } = await run(w, invoiceCreate, {
      workspaceId: w.workspaceId,
      personId: c.id,
      title: 'AC tune-up',
      lines: [{ name: 'AC tune-up', quantity: 1, unitPriceCents: 18_000, unitLabel: 'each' }],
    });
    const out = await run(w, invoiceSend, {
      workspaceId: w.workspaceId,
      invoiceId,
      channels: ['sms'],
    });
    await drain(w);
    const before = sent().length;
    await run(w, invoiceRecordCashPayment, {
      workspaceId: w.workspaceId,
      invoiceId,
      amountCents: out.totalCents,
      method: 'check',
    });
    await drain(w);
    const told = pushesTo(marcoToken, 'assistant_alert', before);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe('Paid · Mike Test');
    expect(dataOf(told[0]!).refs).toMatchObject({ invoiceId });
    // Dale marked it paid himself.
    expect(pushesTo(daleToken, 'assistant_alert', before)).toEqual([]);
  });

  it('tells whoever asked about a low review, and not about a good one', async () => {
    await run(w, assistantRoutineCreate, {
      workspaceId: w.workspaceId,
      kind: 'alert',
      watch: { on: 'review', atMost: 2 },
    });
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    const [place] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.review_connections (workspace_id, provider, status, display_name)
          values (${w.workspaceId}, 'google', 'connected', 'Lone Star on Google') returning id`,
    );
    const review = async (rating: number, body: string) => {
      const [row] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.reviews (workspace_id, connection_id, provider, external_id, author_name, rating,
              sentiment, body, posted_at)
            values (${w.workspaceId}, ${place!.id}, 'google', ${randomUUID()}, 'Pat Lee', ${rating},
              null, ${body}, now())
            returning id`,
      );
      await asWorker(testDbs().worker.db, scope, (tx) =>
        alertOnReview(testDbs().worker.db, tx, scope, {
          id: row!.id,
          rating,
          authorName: 'Pat Lee',
          body,
        }),
      );
      await drain(w);
    };
    const before = sent().length;
    await review(5, 'Great work, fast and clean.');
    expect(pushesTo(daleToken, 'assistant_alert', before)).toEqual([]);
    await review(1, 'Nobody showed up.');
    const told = pushesTo(daleToken, 'assistant_alert', before);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      title: '1-star review from Pat Lee',
      body: 'Nobody showed up.',
    });
  });
});
