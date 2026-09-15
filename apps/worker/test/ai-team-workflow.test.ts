/**
 * The workflow action "Hand to the AI teammate" (M7 step 7), on the real database with the fake carrier and the
 * scripted model: a new lead a workflow hands over gets the teammate's first message, with the workflow's goal
 * and note in its context and its loop guard on everything it does (and the teammate's own first message stands
 * aside); an A → teammate → A loop stops at one run of A; and the step is skipped, with a reason, when the
 * teammate is off or doesn't answer the channel.
 */
import { leadCreate, workflowEnrol, type WorkflowDefinitionInput } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachJobKey } from '../src/ai-team/index';
import { TEAMMATE_SYSTEM } from '../src/ai-team/prompt';
import {
  admin,
  aiMessages,
  bookOnline,
  conversationOf,
  customer,
  drain,
  newCustomer,
  openSlot,
  run,
  runDue,
  saveTeammate,
  setStatus,
  teammateWorld,
  textIn,
  type TeammateWorld,
} from './ai-team-world';
import { addWorkflow, runsOf as workflowRunsOf, sid, stepOf } from './workflow-world';

let w: TeammateWorld;

beforeAll(async () => {
  w = await teammateWorld('tmflow', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const handOver = (
  id: string,
  trigger: WorkflowDefinitionInput['trigger'],
  config: Record<string, unknown>,
): WorkflowDefinitionInput => ({
  version: 1,
  trigger,
  steps: [{ id, type: 'action', action: 'hand_to_ai_teammate', config }],
  settings: {},
});

async function agreesToTexts(personId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${personId}`,
  );
}

function teammateRunsFor(personId: string) {
  return rows<{ triggered_by: string; outcome: string | null; conversation_id: string | null }>(
    admin(),
    sql`select triggered_by, outcome, conversation_id from app.ai_teammate_runs
        where person_id = ${personId} and not is_test order by started_at, id`,
  );
}

describe('handing a customer to the teammate', () => {
  it('writes first to a new lead a workflow hands over, with its goal, its note and its loop guard', async () => {
    const stepId = sid('speed');
    const wf = await addWorkflow(
      w,
      'Speed to lead with Ava',
      handOver(
        stepId,
        { kind: 'event', event: 'lead.created' },
        {
          goal: 'book',
          firstMessage: 'ai_writes',
          channel: 'sms',
          note: 'Asked about a new furnace.',
        },
      ),
    );
    const c = await newCustomer(w, 'Hal');
    await agreesToTexts(c.id);
    const { leadId } = await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      title: 'Furnace',
      personId: c.id,
    });
    await drain(w);

    const [r] = await workflowRunsOf(wf.id);
    expect((await stepOf(r!.id, stepId))!).toMatchObject({
      status: 'done',
      output: expect.objectContaining({ conversationId: null, writesFirstAt: expect.any(String) }),
    });
    const [first] = await teammateRunsFor(c.id);
    expect(first).toMatchObject({ triggered_by: 'workflow', outcome: 'replied' });
    const [sent] = await aiMessages(first!.conversation_id!);
    expect(sent!.body_text).toMatch(/book a visit/);
    const asked = w.requests.find(
      (q) =>
        q.system === TEAMMATE_SYSTEM && (q.context ?? '').includes('Asked about a new furnace.'),
    );
    expect(asked?.context).toContain(
      'A workflow handed this customer to you. Your goal: get them booked',
    );
    // Everything it does carries the workflow's loop guard.
    const [queued] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'message.queued' and entity_id = ${sent!.id}`,
    );
    expect(queued!.payload['_workflow']).toMatchObject({
      runId: r!.id,
      workflowId: wf.id,
      depth: 0,
    });

    // The teammate's own first message to the new lead stands aside for the workflow's.
    await runDue(w, [outreachJobKey(leadId)]);
    expect(await teammateRunsFor(c.id)).toHaveLength(1);
    expect(await aiMessages(first!.conversation_id!)).toHaveLength(1);
  });

  it('stops an A → teammate → A loop after one run of A', async () => {
    // A: whenever something is booked, the teammate takes the conversation. What it books then doesn't start A
    // again: its booking carries A's loop guard.
    const stepId = sid('loopa');
    const wf = await addWorkflow(
      w,
      'Booked: hand to Ava',
      handOver(
        stepId,
        { kind: 'event', event: 'appointment.booked' },
        { goal: 'book', firstMessage: 'none', channel: 'sms', note: '' },
      ),
    );
    const c = await newCustomer(w, 'Ian');
    // They text while the teammate is off, so the message waits for someone.
    await setStatus(w, 'off');
    const m = await textIn(w, c.phone, 'Please book me for Thursday too');
    await setStatus(w, 'training');
    await setStatus(w, 'automatic');
    expect(await aiMessages(m.conversationId)).toHaveLength(0);
    // Something booked for them on the booking page starts A.
    await bookOnline(w, w.calendar!.slug, await openSlot(w, 5), {
      ...customer('Ian'),
      phone: c.phone,
      email: c.email,
      smsConsent: true,
    });
    await drain(w);

    expect(await workflowRunsOf(wf.id)).toHaveLength(1);
    expect(await conversationOf(m.conversationId)).toMatchObject({
      handled_by: 'ai',
      ai_teammate_id: w.teammateId,
    });
    const booked = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events
          where event_type = 'appointment.booked' and workspace_id = ${w.workspaceId}
            and actor_type = 'ai_employee' and payload -> '_workflow' ->> 'workflowId' = ${wf.id}`,
    );
    expect(booked).toHaveLength(1);
    const [sent] = await aiMessages(m.conversationId);
    expect(sent!.body_text).toMatch(/You're booked for Thu/);
  });

  it('is skipped, with the reason, when the teammate is off or doesn’t answer that channel', async () => {
    const stepId = sid('skip');
    const offFlow = await addWorkflow(
      w,
      'Hand over (manual)',
      handOver(
        stepId,
        { kind: 'manual' },
        { goal: 'respond', firstMessage: 'none', channel: 'sms' },
      ),
    );
    const emailId = sid('mail');
    const emailFlow = await addWorkflow(
      w,
      'Hand over by email',
      handOver(
        emailId,
        { kind: 'manual' },
        { goal: 'respond', firstMessage: 'none', channel: 'email' },
      ),
    );
    const c = await newCustomer(w, 'Joy');
    await setStatus(w, 'off');
    try {
      await run(w, workflowEnrol, {
        workspaceId: w.workspaceId,
        workflowId: offFlow.id,
        personId: c.id,
      });
      await drain(w);
    } finally {
      await setStatus(w, 'training');
      await setStatus(w, 'automatic');
    }
    const [r] = await workflowRunsOf(offFlow.id);
    expect((await stepOf(r!.id, stepId))!).toMatchObject({
      status: 'skipped',
      output: expect.objectContaining({ skipped: 'teammate_off' }),
    });
    // With email off, it doesn't take email conversations.
    await saveTeammate(w, { channels: { email: false } });
    try {
      await run(w, workflowEnrol, {
        workspaceId: w.workspaceId,
        workflowId: emailFlow.id,
        personId: c.id,
      });
      await drain(w);
    } finally {
      await saveTeammate(w, { channels: { email: true } });
    }
    const [e] = await workflowRunsOf(emailFlow.id);
    expect((await stepOf(e!.id, emailId))!).toMatchObject({
      status: 'skipped',
      output: expect.objectContaining({ skipped: 'channel_off' }),
    });
  });
});
