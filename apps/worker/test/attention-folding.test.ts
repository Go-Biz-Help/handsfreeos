/**
 * M8 step 4 on the real database: one card per lead as events happen. A hot lead takes the card from the unanswered
 * one, and the customer's waiting text joins it; a waiting customer has a card of their own until a lead of theirs
 * has one, then that card takes the conversation.
 */
import { leadCreate } from '@hfos/core/server';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textIn } from './ai-team-world';
import {
  attentionWorld,
  codes,
  filedCustomer,
  inboundLead,
  itemEvents,
  itemOf,
  itemsOf,
  type AttentionWorld,
} from './attention-world';
import { drain, run } from './booking-world';

let w: AttentionWorld;

beforeAll(async () => {
  // The default reply threshold: a customer's text waits 10 minutes before it's listed.
  w = await attentionWorld('attnfold');
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('one card per lead', () => {
  it('a hot lead takes the card from the unanswered one, and her waiting text joins it', async () => {
    const rosa = await filedCustomer(w, 'Rosa');
    const leadId = await inboundLead(w, rosa.id, 'No cooling', 20);
    await drain(w);
    const unanswered = await itemOf(w, leadId, 'unanswered_lead');
    expect(unanswered.state).toBe('open');

    // She wrote 12 minutes ago, ready to book: hot, and past the reply threshold.
    const { conversationId } = await textIn(
      w,
      rosa.phone,
      'Can someone come out today? The AC quit.',
      { secondsAgo: 12 * 60 },
    );
    const hot = await itemOf(w, leadId, 'hot_lead');
    expect(hot).toMatchObject({ state: 'open', conversationId });
    expect(codes(hot)).toEqual(expect.arrayContaining(['ready_to_book', 'waiting']));
    expect(await itemEvents(hot.id)).toEqual(['became_urgent', 'opened']);
    expect(await itemOf(w, leadId, 'unanswered_lead')).toMatchObject({
      state: 'resolved',
      resolution: 'folded',
    });
    expect(await itemEvents(unanswered.id)).toEqual(['became_urgent', 'opened', 'resolved']);
    // Her waiting text is on the card, not a card of its own.
    expect(await itemsOf(w, [conversationId])).toEqual([]);
  });

  it('a waiting customer has a card of their own until a lead of theirs has one', async () => {
    const ken = await filedCustomer(w, 'Ken');
    const { conversationId } = await textIn(
      w,
      ken.phone,
      'Hi there, just a question about my account.',
      { secondsAgo: 12 * 60 },
    );
    const waiting = await itemOf(w, conversationId, 'customer_waiting');
    expect(waiting).toMatchObject({ state: 'open', personId: ken.id });
    expect(await itemEvents(waiting.id)).toEqual(['became_urgent', 'opened']);

    // Dale types in a lead for him: its card (it needs a next action) takes the conversation, and its urgency.
    const { leadId } = await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      title: 'Duct cleaning',
      personId: ken.id,
    });
    await drain(w);
    const card = await itemOf(w, leadId, 'missing_next_action');
    expect(card).toMatchObject({ state: 'open', conversationId });
    expect(codes(card)).toEqual(expect.arrayContaining(['no_next_action', 'waiting']));
    expect(card.urgentFrom?.getTime()).toBe(waiting.urgentFrom?.getTime());
    expect(await itemOf(w, conversationId, 'customer_waiting')).toMatchObject({
      state: 'resolved',
      resolution: 'folded',
    });
    expect(await itemEvents(card.id)).toContain('opened');
  });
});
