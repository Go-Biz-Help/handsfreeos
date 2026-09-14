/**
 * Waits and wakes, on the real database with the fake carrier: a wait for a reply that the reply ends versus
 * one that times out (and the branch after it reading wait.timed_out); a run that stops when the customer
 * replies; and the lost-wakeup race: a wake that arrives while a run's job is running is kept, generically for
 * any job and for a workflow run whose job was about to sleep until its timeout.
 */
import { randomUUID } from 'node:crypto';
import { executeCommand, messageReceive, scheduleJob, workflowEnrol } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processJobs, type JobHandler } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { systemActor } from '../src/services';
import { runJobKey } from '../src/workflows/index';
import {
  addWorkflow,
  admin,
  customerNamed,
  drain,
  flowWorld,
  jobRow,
  readyTexting,
  run,
  runJob,
  runJobAt,
  runOf,
  runsOf,
  sid,
  stepOf,
  type World,
} from './workflow-world';

let w: World;
let number: string;
beforeAll(async () => {
  w = await flowWorld('wfwait');
  number = await readyTexting(w);
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const note = (id: string, body: string) => ({
  id,
  type: 'action' as const,
  action: 'add_note' as const,
  config: { body },
});

async function notesOf(personId: string): Promise<string[]> {
  const list = await rows<{ body: string }>(
    admin(),
    sql`select body from app.activities where person_id = ${personId} and kind = 'note' order by created_at`,
  );
  return list.map((n) => n.body);
}

/** The customer texts the business. */
async function textIn(from: string, body: string): Promise<void> {
  await executeCommand(
    w.s.db,
    messageReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'fake',
      providerMessageId: `SM${randomUUID().replace(/-/g, '')}`,
      from,
      to: number,
      body,
    },
    systemActor({ workspaceId: w.workspaceId, organizationId: w.organizationId }),
    { correlationId: randomUUID(), channel: 'test' },
  );
}

async function enrolled(workflowId: string, personId: string): Promise<string> {
  await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId, personId });
  await drain(w);
  const list = await runsOf(workflowId);
  return list.find((r) => r.person_id === personId)!.id;
}

describe('waiting for an event', () => {
  const waitId = sid('ewait');
  const branchId = sid('ebrch');
  const def = {
    version: 1 as const,
    trigger: { kind: 'manual' as const },
    steps: [
      {
        id: waitId,
        type: 'wait' as const,
        until: {
          kind: 'event' as const,
          events: ['message.received' as const],
          timeout: { amount: 30, unit: 'minutes' as const },
        },
      },
      {
        id: branchId,
        type: 'branch' as const,
        mode: 'if_else' as const,
        branches: [
          {
            id: 'b_timedout',
            name: 'No reply',
            condition: {
              match: 'all' as const,
              conditions: [{ field: 'wait.timed_out', op: 'is_true' as const }],
            },
            steps: [note(sid('enone'), 'No reply in time')],
          },
          {
            id: 'b_answered',
            name: 'Replied',
            condition: null,
            steps: [note(sid('ereply'), 'They replied: {{conversation.last_message}}')],
          },
        ],
      },
    ],
  };
  let wfId: string;
  beforeAll(async () => {
    wfId = (await addWorkflow(w, 'Wait for a reply', def)).id;
  });

  it('wakes when the reply comes', async () => {
    const p = await customerNamed(w, 'Remy');
    const runId = await enrolled(wfId, p.id);
    expect(await runOf(runId)).toMatchObject({
      status: 'waiting',
      waiting_for: ['message.received'],
    });
    const timeoutAt = (await runJobAt(runId))!;
    expect(timeoutAt).toBeGreaterThan(Date.now() + 25 * 60_000);

    await textIn(p.phone!, 'Tuesday works');
    await drain(w);
    const r = await runOf(runId);
    expect(r).toMatchObject({ status: 'completed' });
    expect((r.context['wait'] as Record<string, unknown>)['timed_out']).toBe(false);
    expect((await stepOf(runId, waitId))!.output).toMatchObject({
      timedOut: false,
      event: 'message.received',
    });
    expect(await notesOf(p.id)).toEqual(['They replied: Tuesday works']);
  });

  it('times out when nobody replies', async () => {
    const p = await customerNamed(w, 'Tess');
    const runId = await enrolled(wfId, p.id);
    await runJob(w, runId);
    const r = await runOf(runId);
    expect(r.status).toBe('completed');
    expect((r.context['wait'] as Record<string, unknown>)['timed_out']).toBe(true);
    expect((await stepOf(runId, branchId))!.output).toMatchObject({ branchId: 'b_timedout' });
    expect(await notesOf(p.id)).toEqual(['No reply in time']);
  });

  it('ignores a reply from someone else', async () => {
    const p = await customerNamed(w, 'Ivy');
    const other = await customerNamed(w, 'Otto');
    const runId = await enrolled(wfId, p.id);
    await textIn(other.phone!, 'Wrong person');
    await drain(w);
    expect((await runOf(runId)).status).toBe('waiting');
  });
});

describe('stop on', () => {
  it('stops the run when the customer replies', async () => {
    const wf = await addWorkflow(w, 'Stops on a reply', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: sid('swait'),
          type: 'wait',
          until: { kind: 'duration', duration: { amount: 1, unit: 'days' } },
        },
        note(sid('snote'), 'Should never happen'),
      ],
      settings: { stopOn: ['reply'] },
    });
    const p = await customerNamed(w, 'Stan');
    const runId = await enrolled(wf.id, p.id);
    expect((await runOf(runId)).status).toBe('waiting');
    await textIn(p.phone!, 'Stop texting me about this, I booked elsewhere');
    await drain(w);
    expect(await runOf(runId)).toMatchObject({ status: 'stopped', end_reason: 'stop_on:reply' });
    expect(await runJobAt(runId)).toBeNull();
    expect(await notesOf(p.id)).toEqual([]);
  });

  it('stops before its next step when the reply came first (the dispatcher hadn’t seen it yet)', async () => {
    const wf = await addWorkflow(w, 'Stops on a reply, checked before a step', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: sid('twait'),
          type: 'wait',
          until: { kind: 'duration', duration: { amount: 1, unit: 'hours' } },
        },
        note(sid('tnote'), 'Should never happen either'),
      ],
      settings: { stopOn: ['reply'] },
    });
    const p = await customerNamed(w, 'Tom');
    const runId = await enrolled(wf.id, p.id);
    // The reply lands, but its event hasn't reached the dispatcher when the wait ends.
    await textIn(p.phone!, 'Got it');
    await rows(
      admin(),
      sql`update app.outbox set status = 'done' where workspace_id = ${w.workspaceId} and status = 'pending'`,
    );
    await runJob(w, runId);
    expect(await runOf(runId)).toMatchObject({ status: 'stopped', end_reason: 'stop_on:reply' });
    expect(await notesOf(p.id)).toEqual([]);
  });
});

describe('the lost-wakeup race', () => {
  const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });
  const reserve = (key: string) =>
    rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${w.workerId}
          where dedupe_key = ${key} and status = 'pending'`,
    );

  async function raceWith(
    result: 'later' | 'done',
  ): Promise<{ status: string; run_at: Date; payload: unknown }> {
    const kind = `test.race.${randomUUID().slice(0, 8)}`;
    const key = `race:${randomUUID()}`;
    const job = (runAt: Date) => ({ kind, dedupeKey: key, runAt, payload: { n: 1 }, ...scope() });
    await asWorker(w.s.db, scope(), (tx) => scheduleJob(tx, job(new Date(Date.now() - 1000))));
    const handler: JobHandler = async () => {
      // A wake is asked for while this job runs…
      await asWorker(w.s.db, scope(), (tx) =>
        scheduleJob(tx, job(new Date()), { pullEarlier: true }),
      );
      // …and the job was about to sleep for an hour (or finish).
      return result === 'later' ? { rescheduleAt: new Date(Date.now() + 3_600_000) } : undefined;
    };
    await reserve(key);
    await processJobs({
      ...w.s,
      jobs: { [kind]: handler },
      workerId: w.workerId,
      batchSize: 5,
      reservedOnly: true,
    });
    const [row] = await rows<{ status: string; run_at: Date; payload: unknown }>(
      admin(),
      sql`select status::text as status, run_at, payload from app.scheduled_jobs where dedupe_key = ${key}`,
    );
    // This kind has no handler outside this test: don't leave it for the next drain.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'cancelled' where dedupe_key = ${key}`,
    );
    return row!;
  }

  it('never pushes a job past a wake that came in while it ran', async () => {
    const row = await raceWith('later');
    expect(row.status).toBe('pending');
    expect(new Date(row.run_at).getTime()).toBeLessThan(Date.now() + 5_000);
    expect(row.payload).toEqual({ n: 1 });
  });

  it('keeps a job that would be done pending at that wake', async () => {
    const row = await raceWith('done');
    expect(row.status).toBe('pending');
    expect(new Date(row.run_at).getTime()).toBeLessThan(Date.now() + 5_000);
  });

  it('a reply that lands while the run’s job is running still wakes the run', async () => {
    const wf = await addWorkflow(w, 'Race', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: sid('rwait'),
          type: 'wait',
          until: {
            kind: 'event',
            events: ['message.received'],
            timeout: { amount: 1, unit: 'days' },
          },
        },
        note(sid('rnote'), 'Woke up'),
      ],
    });
    const p = await customerNamed(w, 'Rae');
    const runId = await enrolled(wf.id, p.id);
    const key = runJobKey(runId);
    const timeoutAt = (await runJobAt(runId))!;
    // The run's job is running right now (due, and locked by this worker)…
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() - interval '1 second', locked_at = now(), locked_by = ${w.workerId}
          where dedupe_key = ${key} and status = 'pending'`,
    );
    // …when the reply's event reaches the dispatcher.
    await textIn(p.phone!, 'Here');
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${w.workerId}
          where workspace_id = ${w.workspaceId} and status = 'pending'`,
    );
    await processOnce({
      ...w.s,
      handlers,
      workerId: w.workerId,
      batchSize: 50,
      reservedOnly: true,
    });
    const woke = await jobRow(key);
    expect(woke!.status).toBe('pending');
    // The running job read the run before the reply and goes back to sleep until its timeout…
    await processJobs({
      ...w.s,
      jobs: { 'workflow.step': async () => ({ rescheduleAt: new Date(timeoutAt) }) },
      workerId: w.workerId,
      batchSize: 5,
      reservedOnly: true,
    });
    // …but it stays due now, so the reply isn't lost until the timeout.
    expect((await runJobAt(runId))!).toBeLessThan(Date.now() + 5_000);
    await drain(w);
    expect((await runOf(runId)).status).toBe('completed');
    expect(await notesOf(p.id)).toEqual(['Woke up']);
  });
});
