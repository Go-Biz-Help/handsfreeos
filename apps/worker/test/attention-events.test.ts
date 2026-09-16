/**
 * M8 step 4 on the real database: the Action Center reconciles as events happen. A new lead that came in on its
 * own waits 15 open-hours minutes (its recheck is set for then, and opens it, urgent); a person's text clears it;
 * assigning the lead moves the item quietly; only transitions are recorded. And every command event about a lead,
 * a seat, a call, a task, an approval or a draft is one the worker listens to.
 */
import {
  ALWAYS_OPEN_HOURS,
  commands,
  leadUpdate,
  messageSend,
  zonedParts,
} from '@hfos/core/server';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTENTION_EVENTS, recheckJobKey } from '../src/attention/index';
import {
  attentionWorld,
  filedCustomer,
  inboundLead,
  itemEvents,
  itemOf,
  itemsOf,
  setOpenHours,
  type AttentionWorld,
} from './attention-world';
import { at, CHI, drain, jobRow, run, runDue } from './booking-world';

let w: AttentionWorld;

beforeAll(async () => {
  w = await attentionWorld('attnev');
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('the events the Action Center listens to', () => {
  it('covers every command event about a lead, a seat, a call, a task, an approval or a draft', () => {
    const about =
      /^(lead|appointment|attendee|call|task)\.|^workflow\.approval_|^ai_teammate\.draft_/;
    const emitted = new Set(commands.flatMap((c) => c.emits).filter((t) => about.test(t)));
    expect([...emitted].filter((t) => !ATTENTION_EVENTS.includes(t))).toEqual([]);
    expect(ATTENTION_EVENTS).toEqual(
      expect.arrayContaining([
        'message.received',
        'message.sent',
        'message.queued',
        'activity.logged',
        'conversation.assigned',
        'conversation.snoozed',
        'conversation.reopened',
        'conversation.closed',
        'conversation.handed_off',
        'conversation.taken_over',
        'conversation.handed_to_ai',
        'workflow.approval_requested',
        'workflow.approval_expired',
        'ai_teammate.drafted',
        'ai_teammate.draft_expired',
      ]),
    );
  });
});

describe('a new lead that came in on its own', () => {
  it('waits 15 open-hours minutes: its recheck is set for then, and opens it, urgent', async () => {
    // Open 9 to 5 tomorrow only, so the 15 minutes start at 9 whatever time the test runs.
    const tomorrow = zonedParts(at(1, '12:00'), CHI).weekday;
    await setOpenHours(w, [{ day: tomorrow, start: '09:00', end: '17:00' }]);
    try {
      const maria = await filedCustomer(w, 'Maria');
      const leadId = await inboundLead(w, maria.id, 'AC replacement');
      await drain(w);
      // Until then it only needs a next action.
      expect((await itemsOf(w, [leadId])).map((i) => [i.kind, i.state])).toEqual([
        ['missing_next_action', 'open'],
      ]);
      const key = recheckJobKey('lead', leadId);
      expect(new Date((await jobRow(key))!.run_at).getTime()).toBe(at(1, '09:15'));

      // The recheck, as of its time.
      await runDue(w, [key]);
      const card = await itemOf(w, leadId, 'unanswered_lead');
      expect(card.state).toBe('open');
      expect(card.urgentFrom?.getTime()).toBe(at(1, '09:15'));
      expect(await itemEvents(card.id)).toEqual(['became_urgent', 'opened']);
      // One card per lead: the next action folded into it.
      const folded = await itemOf(w, leadId, 'missing_next_action');
      expect(folded).toMatchObject({ state: 'resolved', resolution: 'folded' });
      expect(await itemEvents(folded.id)).toEqual(['opened', 'resolved']);
    } finally {
      await setOpenHours(w, ALWAYS_OPEN_HOURS);
    }
  });

  it('follows the lead to its new owner quietly, and clears when a person texts', async () => {
    const rosa = await filedCustomer(w, 'Rosa');
    const leadId = await inboundLead(w, rosa.id, 'No cooling', 20);
    await drain(w);
    const card = await itemOf(w, leadId, 'unanswered_lead');
    expect(card.state).toBe('open');
    expect(card.assigneeUserId).not.toBe(w.member.id);
    expect(await itemEvents(card.id)).toEqual(['became_urgent', 'opened']);

    // Dale gives the lead to Marco: the item follows, and nothing is recorded (it isn't a transition).
    await run(w, leadUpdate, { workspaceId: w.workspaceId, leadId, assigneeUserId: w.member.id });
    await drain(w);
    expect(await itemOf(w, leadId, 'unanswered_lead')).toMatchObject({
      state: 'open',
      assigneeUserId: w.member.id,
    });
    expect(await itemEvents(card.id)).toEqual(['became_urgent', 'opened']);

    // Dale texts her: nobody's waiting on a first reply now.
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      personId: rosa.id,
      body: 'Hi Rosa, Dale here. I can come by at 3.',
    });
    await drain(w);
    expect(await itemOf(w, leadId, 'unanswered_lead')).toMatchObject({
      state: 'resolved',
      resolution: 'contacted',
    });
    expect(await itemEvents(card.id)).toEqual(['became_urgent', 'opened', 'resolved']);
  });
});
