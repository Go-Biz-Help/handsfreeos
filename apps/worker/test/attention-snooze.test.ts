/**
 * M8 step 4 on the real database: a snoozed item comes back at its time (the `attention.snoozed` event schedules its
 * job), and sooner when its facts change (the customer writes in); a dismissed item stays dismissed through sweeps
 * and quiet changes, until its facts change.
 */
import { attentionDismiss, attentionSnooze, leadUpdate } from '@hfos/core/server';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsnoozeJobKey } from '../src/attention/index';
import { textIn } from './ai-team-world';
import {
  attentionWorld,
  DAY,
  filedCustomer,
  itemEvents,
  itemOf,
  itemsOf,
  runSweep,
  setReplyThreshold,
  typedLead,
  type AttentionWorld,
} from './attention-world';
import { drain, HOUR, iso, jobRow, run, runDue } from './booking-world';

let w: AttentionWorld;

beforeAll(async () => {
  w = await attentionWorld('attnsnz');
  // A customer's text is listed as waiting the moment it lands.
  await setReplyThreshold(w, 0);
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const snooze = (itemId: string, until: number) =>
  run(w, attentionSnooze, { workspaceId: w.workspaceId, itemId, until: iso(until) });

describe('a snoozed item', () => {
  it('comes back at its time, and sooner when its facts change', async () => {
    const ana = await filedCustomer(w, 'Ana');
    const leadId = await typedLead(w, ana.id, 'Water heater', { daysAgo: 2 });
    await drain(w);
    const card = await itemOf(w, leadId, 'missing_next_action');
    expect(card.state).toBe('open');

    // Two hours: its job waits for then, and brings it back.
    const until = Date.now() + 2 * HOUR;
    await snooze(card.id, until);
    await drain(w);
    const key = unsnoozeJobKey(card.id);
    expect(new Date((await jobRow(key))!.run_at).getTime()).toBe(until);
    await runDue(w, [key]);
    expect(await itemOf(w, leadId, 'missing_next_action')).toMatchObject({
      state: 'open',
      snoozedUntil: null,
    });
    expect(await itemEvents(card.id)).toEqual(['opened', 'snooze_ended']);

    // Two days, but Ana writes in: it's back now, with her waiting text on the card.
    await snooze(card.id, Date.now() + 2 * DAY);
    await drain(w);
    const { conversationId } = await textIn(
      w,
      ana.phone,
      'Hi, just checking in about the water heater.',
    );
    expect(await itemOf(w, leadId, 'missing_next_action')).toMatchObject({
      state: 'open',
      snoozedUntil: null,
      conversationId,
    });
    expect(await itemEvents(card.id)).toEqual(['opened', 'reopened', 'snooze_ended']);
    expect(await itemsOf(w, [conversationId])).toEqual([]);

    // When the two days are up, its job finds nothing left to do.
    await runDue(w, [key]);
    expect((await itemOf(w, leadId, 'missing_next_action')).state).toBe('open');
    expect(await itemEvents(card.id)).toEqual(['opened', 'reopened', 'snooze_ended']);
  });
});

describe('a dismissed item', () => {
  it('stays dismissed until its facts change', async () => {
    const lou = await filedCustomer(w, 'Lou');
    const leadId = await typedLead(w, lou.id, 'Furnace tune-up', { daysAgo: 2 });
    await drain(w);
    const card = await itemOf(w, leadId, 'missing_next_action');
    await run(w, attentionDismiss, {
      workspaceId: w.workspaceId,
      itemId: card.id,
      reason: 'Waiting on their landlord',
    });
    await drain(w);

    // The sweep, and a change that isn't new facts (its value), leave it dismissed and record nothing.
    await runSweep(w);
    await run(w, leadUpdate, { workspaceId: w.workspaceId, leadId, valueCents: 120_000 });
    await drain(w);
    expect(await itemOf(w, leadId, 'missing_next_action')).toMatchObject({
      state: 'dismissed',
      dismissReason: 'Waiting on their landlord',
      valueCents: 120_000,
    });
    expect(await itemEvents(card.id)).toEqual(['opened']);

    // Lou writes in: new facts, so it's back.
    const { conversationId } = await textIn(w, lou.phone, 'Any news on the furnace?');
    expect(await itemOf(w, leadId, 'missing_next_action')).toMatchObject({
      state: 'open',
      dismissedAt: null,
      conversationId,
    });
    expect(await itemEvents(card.id)).toEqual(['opened', 'reopened']);
  });
});
