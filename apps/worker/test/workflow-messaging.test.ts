/**
 * Consent and quiet hours before every text, on the real database with the fake carrier. A text due at 10 PM
 * (a fixed clock; quiet hours 8 PM to 8 AM) waits for 8 AM plus a few minutes, then goes. A customer who said
 * STOP gets the message by email, or the step is skipped and logged, as the workflow says. Someone whose call
 * the business missed is texted back within 24 hours without having opted in; someone who never agreed and
 * hasn't been in touch is not.
 */
import { randomUUID } from 'node:crypto';
import {
  callRecord,
  callUpdateStatus,
  executeCommand,
  workflowEnrol,
  type WorkflowDefinitionInput,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processOnce } from '../src/outbox';
import { systemActor } from '../src/services';
import {
  addWorkflow,
  admin,
  at,
  BUSINESS,
  customerNamed,
  drain,
  emailsTo,
  flowWorld,
  MIN,
  readyTexting,
  run,
  runJob,
  runJobAt,
  runJobsAt,
  runOf,
  runsOf,
  setQuietHours,
  sid,
  stepOf,
  textsTo,
  type World,
} from './workflow-world';

let w: World;
let number: string;
beforeAll(async () => {
  w = await flowWorld('wfmsg');
  number = await readyTexting(w);
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const textFlow = (
  id: string,
  body: string,
  settings: WorkflowDefinitionInput['settings'] = {},
) => ({
  version: 1 as const,
  trigger: { kind: 'manual' as const },
  steps: [{ id, type: 'action' as const, action: 'send_text' as const, config: { body } }],
  settings,
});

/** Only the outbox: the run starts and its job is queued, but nothing runs it yet. */
async function outboxOnly(): Promise<void> {
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${w.workerId}
        where status = 'pending' and workspace_id = ${w.workspaceId}`,
  );
  await processOnce({ ...w.s, handlers, workerId: w.workerId, batchSize: 100, reservedOnly: true });
}

async function enrol(workflowId: string, personId: string): Promise<void> {
  await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId, personId });
}

describe('quiet hours', () => {
  it('holds a text due at 10 PM until 8 AM (plus a few minutes), then sends it', async () => {
    await setQuietHours(w, { start: '20:00', end: '08:00' });
    const textId = sid('qtext');
    const wf = await addWorkflow(
      w,
      'Evening text',
      textFlow(textId, 'Hi {{person.first_name}}, thanks for calling {{business.name}}.'),
    );
    const p = await customerNamed(w, 'Pat');
    await enrol(wf.id, p.id);
    await outboxOnly();
    const [r] = await runsOf(wf.id);

    await runJobsAt(w, at(1, '22:00'));
    const eightAm = at(2, '08:00');
    const due = (await runJobAt(r!.id))!;
    expect(due).toBeGreaterThanOrEqual(eightAm);
    expect(due).toBeLessThan(eightAm + 5 * MIN);
    expect(textsTo(w, p.phone!)).toHaveLength(0);
    const held = (await stepOf(r!.id, textId))!;
    expect(held.status).toBe('waiting');
    expect(held.output).toMatchObject({
      held: 'quiet_hours',
      decisions: [
        { check: 'consent', result: 'ok', reason: 'opted_in' },
        { check: 'quiet_hours', result: 'wait' },
      ],
    });
    expect((await runOf(r!.id)).status).toBe('waiting');

    // Morning (quiet hours are turned off here, so the real clock can't be in them either).
    await setQuietHours(w, null);
    await runJob(w, r!.id);
    expect((await runOf(r!.id)).status).toBe('completed');
    const sent = textsTo(w, p.phone!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(`Hi Pat, thanks for calling ${BUSINESS}.`);
    expect((await stepOf(r!.id, textId))!.output).toMatchObject({ channel: 'sms' });
  });

  it('emails instead when the workflow says so', async () => {
    await setQuietHours(w, { start: '20:00', end: '08:00' });
    const textId = sid('qmail');
    const wf = await addWorkflow(
      w,
      'Evening email',
      textFlow(textId, 'See you tomorrow, {{person.first_name}}.', { quietHours: 'email_instead' }),
    );
    const p = await customerNamed(w, 'Quinn');
    await enrol(wf.id, p.id);
    await outboxOnly();
    const [r] = await runsOf(wf.id);
    await runJobsAt(w, at(1, '23:00'));
    await setQuietHours(w, null);
    await drain(w);
    expect((await runOf(r!.id)).status).toBe('completed');
    expect(textsTo(w, p.phone!)).toHaveLength(0);
    expect(await emailsTo(w, p.email!)).toEqual([`A message from ${BUSINESS}`]);
    expect((await stepOf(r!.id, textId))!.output).toMatchObject({
      channel: 'email',
      instead: 'quiet_hours',
    });
  });
});

describe('consent', () => {
  it('emails a customer who said STOP instead of texting them', async () => {
    const textId = sid('ctext');
    const wf = await addWorkflow(
      w,
      'Text or email',
      textFlow(textId, 'Your estimate is ready, {{person.first_name}}.'),
    );
    const p = await customerNamed(w, 'Olive', { consent: 'opted_out' });
    await enrol(wf.id, p.id);
    await drain(w);
    const [r] = await runsOf(wf.id);
    expect(r!.status).toBe('completed');
    expect(textsTo(w, p.phone!)).toHaveLength(0);
    expect(await emailsTo(w, p.email!)).toEqual([`A message from ${BUSINESS}`]);
    expect((await stepOf(r!.id, textId))!.output).toMatchObject({
      channel: 'email',
      instead: 'opted_out',
      decisions: [
        { check: 'consent', result: 'blocked', reason: 'opted_out' },
        { check: 'consent', result: 'email_instead', reason: 'opted_out' },
        { check: 'email', result: 'ok' },
      ],
    });
  });

  it('skips and logs it when the workflow says skip', async () => {
    const textId = sid('cskip');
    const wf = await addWorkflow(
      w,
      'Text or skip',
      textFlow(textId, 'Hello {{person.first_name}}.', { noConsent: 'skip' }),
    );
    const p = await customerNamed(w, 'Skip', { consent: 'opted_out' });
    await enrol(wf.id, p.id);
    await drain(w);
    const [r] = await runsOf(wf.id);
    expect(r!.status).toBe('completed');
    const step = (await stepOf(r!.id, textId))!;
    expect(step.status).toBe('skipped');
    expect(step.output).toMatchObject({
      skipped: 'opted_out',
      decisions: [
        { check: 'consent', result: 'blocked', reason: 'opted_out' },
        { check: 'consent', result: 'skip', reason: 'opted_out' },
      ],
    });
    expect(textsTo(w, p.phone!)).toHaveLength(0);
    expect(await emailsTo(w, p.email!)).toEqual([]);
  });

  it('texts back someone whose call was missed, within 24 hours, without an opt-in', async () => {
    const textId = sid('mtext');
    const wf = await addWorkflow(w, 'Missed call back', {
      version: 1,
      trigger: { kind: 'event', event: 'call.missed' },
      steps: [
        {
          id: textId,
          type: 'action',
          action: 'send_text',
          config: { body: 'Sorry we missed your call! How can we help?' },
        },
      ],
    });
    const p = await customerNamed(w, 'Mick', { consent: 'unknown' });
    const system = systemActor({ workspaceId: w.workspaceId, organizationId: w.organizationId });
    const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
    const providerSid = `CA${randomUUID().replace(/-/g, '')}`;
    await executeCommand(
      w.s.db,
      callRecord,
      {
        workspaceId: w.workspaceId,
        providerSid,
        direction: 'inbound',
        from: p.phone,
        to: number,
        status: 'ringing',
      },
      system,
      meta(),
    );
    await executeCommand(
      w.s.db,
      callUpdateStatus,
      { workspaceId: w.workspaceId, providerSid, status: 'no_answer' },
      system,
      meta(),
    );
    await drain(w);
    const [r] = await runsOf(wf.id);
    expect(r).toMatchObject({ status: 'completed', person_id: p.id });
    const sent = textsTo(w, p.phone!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Sorry we missed your call!');
    expect((await stepOf(r!.id, textId))!.output).toMatchObject({
      channel: 'sms',
      decisions: [
        { check: 'consent', result: 'ok', reason: 'recent_contact' },
        { check: 'quiet_hours', result: 'ok' },
      ],
    });
  });

  it('doesn’t text someone who never agreed and hasn’t been in touch', async () => {
    const textId = sid('ntext');
    const wf = await addWorkflow(
      w,
      'Cold text',
      textFlow(textId, 'Hi there.', { noConsent: 'skip' }),
    );
    const p = await customerNamed(w, 'Nell', { consent: 'unknown' });
    await enrol(wf.id, p.id);
    await drain(w);
    const [r] = await runsOf(wf.id);
    expect((await stepOf(r!.id, textId))!).toMatchObject({ status: 'skipped' });
    expect((await stepOf(r!.id, textId))!.output).toMatchObject({ skipped: 'no_consent' });
    expect(textsTo(w, p.phone!)).toHaveLength(0);
  });
});
