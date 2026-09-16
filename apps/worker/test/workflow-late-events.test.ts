/**
 * M10 step 6b: workflows and events that reached HandsFreeOS late. A lead made on a phone with no signal three hours
 * ago starts its "new lead" workflow when the phone reconnects: the "thanks for reaching out just now" text doesn't
 * go and the run says why in plain words, the steps that don't reach the customer still happen, waits count from when
 * the lead was really made, and once a wait catches the run up its texts go as usual. A lead made just now is texted
 * at once, as before.
 */
import { randomUUID } from 'node:crypto';
import { executeCommand, leadCreate, type RequestMeta } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const HOUR = 3_600_000;
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
