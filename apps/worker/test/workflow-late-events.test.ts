/**
 * M10 step 6b: workflows and events that reached HandsFreeOS late. A lead made on a phone with no signal three hours
 * ago starts its "new lead" workflow when the phone reconnects: the "thanks for reaching out just now" text doesn't
 * go and the run says why in plain words, the steps that don't reach the customer still happen, waits count from when
 * the lead was really made, and once a wait catches the run up its texts go as usual. A lead made just now is texted
 * at once, as before.
 *
 * A date trigger ("30 minutes after the lead is won") whose time passed only because the move reached HandsFreeOS late
 * starts when it arrives, marked late the same way. One whose time passed while the worker was down is still skipped.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  leadCreate,
  leadMoveStage,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { events } from '@hfos/db/schema';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lateDateStart } from '../src/workflows/late';
import { armDateTriggers } from '../src/workflows/triggers';
import {
  addWorkflow,
  admin,
  api,
  customerNamed,
  drain,
  flowWorld,
  readyTexting,
  run,
  runJob,
  runJobAt,
  runOf,
  runsOf,
  setQuietHours,
  sid,
  stepOf,
  textsTo,
  type World,
} from './workflow-world';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let w: World;
beforeAll(async () => {
  w = await flowWorld('wflate');
  await readyTexting(w);
  await setQuietHours(w, null);
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const text = (id: string, body: string) => ({
  id,
  type: 'action' as const,
  action: 'send_text' as const,
  config: { body },
});
const note = (id: string, body: string) => ({
  id,
  type: 'action' as const,
  action: 'add_note' as const,
  config: { body },
});
const wait = (id: string, amount: number, unit: 'hours' | 'days') => ({
  id,
  type: 'wait' as const,
  until: { kind: 'duration' as const, duration: { amount, unit } },
});

/** A change made on the phone `agoMs` ago, arriving now. */
const fromPhone = (agoMs: number): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'mobile',
  commandId: randomUUID(),
  occurredAt: new Date(Date.now() - agoMs),
  sentAt: new Date(),
  confirmedAt: null,
  appVersion: '1.0.0',
});

describe('a workflow started by an event that arrived late', () => {
  const ids = {
    thanks: sid('lthank'),
    note: sid('lnote'),
    hour: sid('lhour'),
    again: sid('lagain'),
    day: sid('lday'),
    follow: sid('lfollw'),
  };
  let workflowId: string;

  beforeAll(async () => {
    workflowId = (
      await addWorkflow(w, 'New lead follow-up', {
        version: 1,
        trigger: { kind: 'event', event: 'lead.created' },
        steps: [
          text(ids.thanks, 'Thanks for reaching out just now, {{person.first_name}}.'),
          note(ids.note, 'New lead: {{lead.title}}'),
          wait(ids.hour, 1, 'hours'),
          text(ids.again, 'Still there, {{person.first_name}}?'),
          wait(ids.day, 1, 'days'),
          text(ids.follow, 'Following up on your request, {{person.first_name}}.'),
        ],
      })
    ).id;
  });

  it('skips the texts that would be late, still does the rest, and counts waits from when it happened', async () => {
    const p = await customerNamed(w, 'Rosa');
    const made = Date.now() - 3 * HOUR;
    await executeCommand(
      api(),
      leadCreate,
      { workspaceId: w.workspaceId, personId: p.id, title: 'AC tune-up' },
      { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims },
      fromPhone(3 * HOUR),
    );
    await drain(w);
    const [r] = (await runsOf(workflowId)).filter((x) => x.person_id === p.id);
    expect(r!.status).toBe('waiting');

    const thanks = (await stepOf(r!.id, ids.thanks))!;
    expect(thanks.status).toBe('skipped');
    expect(thanks.output).toMatchObject({
      skipped: 'late_event',
      lateMinutes: 180,
      why: 'Not sent: what started this happened 3 hours before it reached HandsFreeOS, so a message now could be out of date.',
    });
    expect(thanks.input).toMatchObject({
      channel: 'sms',
      body: 'Thanks for reaching out just now, Rosa.',
    });
    expect((await stepOf(r!.id, ids.note))!.status).toBe('done');
    const notes = await rows<{ body: string }>(
      admin(),
      sql`select body from app.activities where person_id = ${p.id} and kind = 'note'`,
    );
    expect(notes.map((n) => n.body)).toEqual(['New lead: AC tune-up']);
    // An hour after it happened was two hours ago: the wait is already past, and the run still two hours behind.
    expect((await stepOf(r!.id, ids.hour))!.output).toMatchObject({ alreadyPast: true });
    expect((await stepOf(r!.id, ids.again))!.output).toMatchObject({
      skipped: 'late_event',
      lateMinutes: 120,
    });
    // A day counts from there too.
    const due = (await runJobAt(r!.id))!;
    expect(Math.abs(due - (made + HOUR + DAY))).toBeLessThan(2 * 60_000);
    expect(textsTo(w, p.phone!)).toHaveLength(0);

    // The day passes: the run is on time again, and its text goes.
    await runJob(w, r!.id);
    const done = await runOf(r!.id);
    expect(done.status).toBe('completed');
    expect(done.context['_late']).toBeUndefined();
    const sent = textsTo(w, p.phone!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Following up on your request, Rosa.');
  });

  it('a lead made just now is texted at once, as before', async () => {
    const p = await customerNamed(w, 'Maria');
    await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      personId: p.id,
      title: 'New AC install',
    });
    await drain(w);
    const [r] = (await runsOf(workflowId)).filter((x) => x.person_id === p.id);
    expect((await stepOf(r!.id, ids.thanks))!.status).toBe('done');
    expect(r!.context['_late']).toBeUndefined();
    expect(textsTo(w, p.phone!).map((m) => m.body)).toEqual([
      expect.stringContaining('Thanks for reaching out just now, Maria.'),
    ]);
    // A lead the phone sent within a minute isn't late either.
    const q = await customerNamed(w, 'Quinn');
    await executeCommand(
      api(),
      leadCreate,
      { workspaceId: w.workspaceId, personId: q.id, title: 'Duct cleaning' },
      { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims },
      fromPhone(20_000),
    );
    await drain(w);
    expect(textsTo(w, q.phone!)).toHaveLength(1);
  });
});

describe('when a date trigger that passed still starts', () => {
  const made = Date.parse('2026-09-17T06:00:00.000Z');
  const arrived = made + 2 * HOUR;
  const late = { occurredAt: new Date(made), createdAt: new Date(arrived) };
  const fire = made + 30 * MIN;

  it('starts when only the late change made it pass, and knows how far behind it is', () => {
    expect(lateDateStart(late, fire, arrived + 3000, 5 * MIN)).toEqual({
      ms: 90 * MIN + 3000,
      happenedAt: '2026-09-17T06:30:00.000Z',
      arrivedAt: '2026-09-17T08:00:00.000Z',
    });
  });

  it('doesn’t when the change came in on time, would have been too late anyway, or the worker was down', () => {
    const onTime = { occurredAt: new Date(arrived), createdAt: new Date(arrived) };
    expect(lateDateStart(onTime, fire, arrived + 3000, 5 * MIN)).toBeNull();
    expect(lateDateStart({ ...late, occurredAt: null }, fire, arrived + 3000, 5 * MIN)).toBeNull();
    // "An hour before the lead is won" had passed when it was won.
    expect(lateDateStart(late, made - HOUR, arrived + 3000, 5 * MIN)).toBeNull();
    // The worker took the change up two hours after it arrived.
    expect(lateDateStart(late, fire, arrived + 2 * HOUR, 5 * MIN)).toBeNull();
  });
});

describe('a date trigger whose time passed while the change that set it was on its way', () => {
  const ids = { note: sid('dwnote'), thanks: sid('dwthks') };
  let workflowId: string;
  let won: string;
  let owner: HumanActor;
  const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });

  beforeAll(async () => {
    owner = { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims };
    workflowId = (
      await addWorkflow(w, 'Thanks after a win', {
        version: 1,
        trigger: {
          kind: 'date',
          anchor: 'lead.stage_entered_at',
          offset: { amount: 30, unit: 'minutes', direction: 'after' },
          filters: {
            match: 'all',
            conditions: [{ field: 'lead.status', op: 'eq', value: 'won' }],
          },
        },
        steps: [
          note(ids.note, 'Won {{lead.title}}: mail the warranty card'),
          text(ids.thanks, 'Thanks for choosing us, {{person.first_name}}!'),
        ],
      })
    ).id;
    const [stage] = await rows<{ id: string }>(
      admin(),
      sql`select s.id from app.pipeline_stages s join app.pipelines p on p.id = s.pipeline_id
          where s.workspace_id = ${w.workspaceId} and s.kind = 'won' order by p.position, s.position limit 1`,
    );
    won = stage!.id;
  });

  it('starts when a move made two hours ago arrives: its note is added, and its text waits, saying why', async () => {
    const p = await customerNamed(w, 'Wanda');
    const { output } = await executeCommand(
      api(),
      leadCreate,
      { workspaceId: w.workspaceId, personId: p.id, title: 'Heat pump' },
      owner,
      fromPhone(3 * HOUR),
    );
    await executeCommand(
      api(),
      leadMoveStage,
      { workspaceId: w.workspaceId, leadId: output.leadId, stageId: won },
      owner,
      fromPhone(2 * HOUR),
    );
    await drain(w);
    const [r] = (await runsOf(workflowId)).filter((x) => x.person_id === p.id);
    expect(r).toMatchObject({ status: 'completed' });
    expect((await stepOf(r!.id, ids.note))!.status).toBe('done');
    const notes = await rows<{ body: string }>(
      admin(),
      sql`select body from app.activities where person_id = ${p.id} and kind = 'note'`,
    );
    expect(notes.map((n) => n.body)).toContain('Won Heat pump: mail the warranty card');
    const thanks = (await stepOf(r!.id, ids.thanks))!;
    expect(thanks.status).toBe('skipped');
    expect(thanks.output).toMatchObject({
      skipped: 'late_event',
      lateMinutes: 90,
      why: expect.stringContaining(
        'before it reached HandsFreeOS, so a message now could be out of date.',
      ),
    });
    expect(textsTo(w, p.phone!).map((m) => m.body)).not.toContainEqual(
      expect.stringContaining('Thanks for choosing us'),
    );
  });

  it('one whose time passed while the worker was down is still skipped, late change or not', async () => {
    const workerDown = async (leadId: string) => {
      const [moved] = await admin()
        .select()
        .from(events)
        .where(and(eq(events.entityId, leadId), eq(events.eventType, 'lead.stage_changed')));
      // The worker takes the move up two hours after it reached HandsFreeOS.
      await asWorker(testDbs().worker.db, scope(), (tx) =>
        armDateTriggers(tx, scope(), moved!, Date.now() + 2 * HOUR),
      );
      return rows(
        admin(),
        sql`select id from app.scheduled_jobs
            where kind = 'workflow.date' and dedupe_key like ${`date:${workflowId}:${leadId}%`}`,
      );
    };
    // Won on the web just now.
    const dora = await customerNamed(w, 'Dora');
    const onWeb = await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      personId: dora.id,
      title: 'Boiler',
    });
    await run(w, leadMoveStage, { workspaceId: w.workspaceId, leadId: onWeb.leadId, stageId: won });
    expect(await workerDown(onWeb.leadId)).toEqual([]);
    // Won on a phone with no signal, and the worker down when it arrived too.
    const eve = await customerNamed(w, 'Eve');
    const onPhone = await executeCommand(
      api(),
      leadCreate,
      { workspaceId: w.workspaceId, personId: eve.id, title: 'Vents' },
      owner,
      fromPhone(3 * HOUR),
    );
    await executeCommand(
      api(),
      leadMoveStage,
      { workspaceId: w.workspaceId, leadId: onPhone.output.leadId, stageId: won },
      owner,
      fromPhone(2 * HOUR),
    );
    expect(await workerDown(onPhone.output.leadId)).toEqual([]);
  });
});
