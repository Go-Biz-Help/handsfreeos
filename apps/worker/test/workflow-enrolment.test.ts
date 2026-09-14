/**
 * Starting workflow runs, on the real database: an outbox retry makes one run; two events at once make one run
 * under "once" and under "again after they finish"; an A→B→A chain stops at depth 3 and a workflow never
 * triggers itself; a run on version 1 finishes on version 1 after version 2 is published.
 */
import {
  leadCreate,
  personUpdate,
  workflowEnrol,
  type WorkflowDefinitionInput,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { events } from '@hfos/db/schema';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onWorkflowEvent } from '../src/workflows/index';
import {
  addWorkflow,
  admin,
  customerNamed,
  drain,
  flowWorld,
  publish,
  run,
  runJob,
  runsOf,
  sid,
  stepsOf,
  writeDraft,
  type World,
} from './workflow-world';

let w: World;
beforeAll(async () => {
  w = await flowWorld('wfenrol');
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
const hourWait = (id: string) => ({
  id,
  type: 'wait' as const,
  until: { kind: 'duration' as const, duration: { amount: 1, unit: 'hours' as const } },
});

async function newLead(personId: string, title: string): Promise<string> {
  const out = await run(w, leadCreate, { workspaceId: w.workspaceId, personId, title });
  return out.leadId;
}

async function notesOf(personId: string): Promise<string[]> {
  const list = await rows<{ body: string }>(
    admin(),
    sql`select body from app.activities where person_id = ${personId} and kind = 'note' order by created_at`,
  );
  return list.map((n) => n.body);
}

async function eventIdsOf(type: string, entityIds: string[]): Promise<string[]> {
  const list = await rows<{ id: string; entity_id: string }>(
    admin(),
    sql`select id, entity_id from app.events where event_type = ${type}
          and entity_id in (${sql.join(
            entityIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
  );
  return entityIds.map((id) => list.find((e) => e.entity_id === id)!.id);
}

/** The dispatcher for one event, in its own transaction (as the outbox would run it). */
async function dispatch(eventId: string): Promise<void> {
  const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
  await asWorker(testDbs().worker.db, scope, async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId));
    await onWorkflowEvent({ ...w.s, tx, event: event!, scope, attempt: 1, maxAttempts: 5 });
  });
}

describe('enrolment', () => {
  it('makes one run for one trigger, even when the outbox runs the event again', async () => {
    const wf = await addWorkflow(w, 'New lead note', {
      version: 1,
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [note(sid('lnote'), 'New lead: {{lead.title}}')],
    });
    const p = await customerNamed(w, 'Rita');
    const leadId = await newLead(p.id, 'Furnace repair');
    await drain(w);
    let list = await runsOf(wf.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'completed', person_id: p.id, depth: 0 });
    expect(await notesOf(p.id)).toContain('New lead: Furnace repair');

    // The outbox runs lead.created again (a retry after a later handler failed): still one run.
    const [eventId] = await eventIdsOf('lead.created', [leadId]);
    await rows(
      admin(),
      sql`update app.outbox set status = 'pending', attempts = 1, next_attempt_at = now() where event_id = ${eventId!}`,
    );
    await drain(w);
    list = await runsOf(wf.id);
    expect(list).toHaveLength(1);
    const steps = await stepsOf(list[0]!.id);
    expect(steps.map((s) => [s.status, s.attempt])).toEqual([['done', 1]]);
    expect((await notesOf(p.id)).filter((n) => n === 'New lead: Furnace repair')).toHaveLength(1);
  });

  it('settles two events at once to one run, under "once" and "again after they finish"', async () => {
    const def = (mode: 'once' | 'after_exit'): WorkflowDefinitionInput => ({
      version: 1,
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [hourWait(sid('owait'))],
      settings: { reentry: { mode } },
    });
    const once = await addWorkflow(w, 'Once ever', def('once'));
    const again = await addWorkflow(w, 'Again after', def('after_exit'));
    const p = await customerNamed(w, 'Omar');
    const leads = [await newLead(p.id, 'Leak'), await newLead(p.id, 'Noise')];
    const [e1, e2] = await eventIdsOf('lead.created', leads);
    // Both events reach the dispatcher at the same moment, in two transactions.
    await Promise.all([dispatch(e1!), dispatch(e2!)]);
    expect(await runsOf(once.id)).toHaveLength(1);
    expect(await runsOf(again.id)).toHaveLength(1);
    // The outbox then delivers the same events again: nothing more.
    await drain(w);
    expect(await runsOf(once.id)).toHaveLength(1);
    expect(await runsOf(again.id)).toHaveLength(1);

    // Once they finish, "again after" lets a new lead in; "once" never does.
    for (const r of [...(await runsOf(once.id)), ...(await runsOf(again.id))])
      await runJob(w, r.id);
    expect((await runsOf(again.id)).map((r) => r.status)).toEqual(['completed']);
    await newLead(p.id, 'Third');
    await drain(w);
    expect(await runsOf(once.id)).toHaveLength(1);
    expect(await runsOf(again.id)).toHaveLength(2);
  });

  it('stops an A→B→A chain at depth 3 and never lets a workflow trigger itself', async () => {
    const setSource = (id: string, value: string) => ({
      id,
      type: 'action' as const,
      action: 'update_person' as const,
      config: { fields: [{ field: 'source' as const, value }] },
    });
    const sourceIs = (...values: string[]) => ({
      match: 'any' as const,
      conditions: values.map((value) => ({ field: 'person.source', op: 'eq' as const, value })),
    });
    const a = await addWorkflow(w, 'Ping', {
      version: 1,
      trigger: { kind: 'event', event: 'person.updated', filters: sourceIs('start', 'pong') },
      steps: [setSource(sid('aping'), 'ping')],
    });
    const b = await addWorkflow(w, 'Pong', {
      version: 1,
      trigger: { kind: 'event', event: 'person.updated', filters: sourceIs('ping') },
      steps: [setSource(sid('bpong'), 'pong')],
    });
    const p = await customerNamed(w, 'Loop');
    await run(w, personUpdate, { workspaceId: w.workspaceId, personId: p.id, source: 'start' });
    await drain(w);
    const pings = await runsOf(a.id);
    const pongs = await runsOf(b.id);
    expect(pings.map((r) => r.depth)).toEqual([0, 2]);
    expect(pongs.map((r) => r.depth)).toEqual([1, 3]);
    // Every run of the chain names its first run.
    const first = pings[0]!.id;
    expect([...pings.slice(1), ...pongs].every((r) => r.origin_run_id === first)).toBe(true);
    expect([...pings, ...pongs].every((r) => r.status === 'completed')).toBe(true);

    // A workflow whose own change matches its trigger doesn't start itself again.
    const self = await addWorkflow(w, 'Self', {
      version: 1,
      trigger: {
        kind: 'event',
        event: 'person.updated',
        filters: {
          match: 'all',
          conditions: [{ field: 'person.first_name', op: 'eq', value: 'Selfie' }],
        },
      },
      steps: [
        {
          id: sid('selfcy'),
          type: 'action',
          action: 'update_person',
          config: { fields: [{ field: 'city', value: 'Austin' }] },
        },
      ],
    });
    const q = await customerNamed(w, 'Selfie');
    await run(w, personUpdate, { workspaceId: w.workspaceId, personId: q.id, lastName: 'Again' });
    await drain(w);
    const selfRuns = await runsOf(self.id);
    expect(selfRuns).toHaveLength(1);
    expect(selfRuns[0]!.status).toBe('completed');
    const [city] = await rows<{ city: string }>(
      admin(),
      sql`select city from app.people where id = ${q.id}`,
    );
    expect(city!.city).toBe('Austin');
  });

  it('finishes a run on the version it started on after a new version is published', async () => {
    const waitId = sid('vwait');
    const noteId = sid('vnote');
    const v1 = {
      version: 1 as const,
      trigger: { kind: 'manual' as const },
      steps: [hourWait(waitId), note(noteId, 'Version one')],
    };
    const wf = await addWorkflow(w, 'Versioned', v1);
    const p = await customerNamed(w, 'Vera');
    await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId: wf.id, personId: p.id });
    await drain(w);
    const [first] = await runsOf(wf.id);
    expect(first).toMatchObject({ status: 'waiting', version_id: wf.versionId });

    await writeDraft(wf.id, { ...v1, steps: [hourWait(waitId), note(noteId, 'Version two')] });
    const v2 = await publish(w, wf.id);
    expect(v2).not.toBe(wf.versionId);

    await runJob(w, first!.id);
    const done = (await runsOf(wf.id))[0]!;
    expect(done).toMatchObject({ status: 'completed', version_id: wf.versionId });
    expect(await notesOf(p.id)).toEqual(['Version one']);

    // A new run starts on version 2.
    await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId: wf.id, personId: p.id });
    await drain(w);
    const second = (await runsOf(wf.id))[1]!;
    expect(second.version_id).toBe(v2);
    await runJob(w, second.id);
    expect(await notesOf(p.id)).toEqual(['Version one', 'Version two']);
  });

  it('runs a manual enrolment from start to end, rendering its templates', async () => {
    const wf = await addWorkflow(w, 'Quiet one', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [note(sid('qnote'), 'Hello {{person.first_name}}')],
    });
    const p = await customerNamed(w, 'Quin');
    await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId: wf.id, personId: p.id });
    await drain(w);
    const [r] = await runsOf(wf.id);
    expect(r).toMatchObject({ status: 'completed', end_reason: 'finished' });
    expect(await notesOf(p.id)).toEqual(['Hello Quin']);
  });
});
