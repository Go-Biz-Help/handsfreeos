/**
 * In your hands (core's messaging/hands.ts), on the real database with the scripted model: a person texting a customer
 * themselves takes them on everywhere, so the AI teammate leaves them alone, even in a conversation that starts later;
 * the list says whose hands and how; Take over does the same from the customer's page and Pick up is refused while
 * someone has them; and Give back to the AI hands their conversations back, so it answers what they're waiting on.
 */
import { randomUUID } from 'node:crypto';
import {
  conversationPickUp,
  executeCommand,
  messageSend,
  personHandBack,
  personInHands,
  personTakeOver,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemActor } from '../src/services';
import {
  admin,
  aiReplies,
  chatIn,
  conversationOf,
  newCustomer,
  query,
  replyNow,
  run,
  scopeOf,
  teammateWorld,
  textIn,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;

beforeAll(async () => {
  w = await teammateWorld('tmhands', { status: 'automatic' });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const inHands = async (personId: string) =>
  (await query(w, personInHands, { workspaceId: w.workspaceId, personId })).people[0] ?? null;

const events = (name: string, personId: string) =>
  rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from app.events
        where workspace_id = ${w.workspaceId} and event_type = ${name} and entity_id = ${personId}`,
  ).then(([r]) => r?.n ?? 0);

describe('in your hands', () => {
  it('a person texting a customer themselves takes them on, and the AI leaves them alone everywhere', async () => {
    const c = await newCustomer(w, 'Hana');
    const m = await textIn(w, c.phone, 'Do you clean gutters?');
    await replyNow(w, m.conversationId);
    expect(await aiReplies(m.conversationId)).toHaveLength(1);

    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: m.conversationId,
      channel: 'sms',
      body: 'Hi Hana, Dale here. Yes we do, when suits you?',
    });
    expect(await conversationOf(m.conversationId)).toMatchObject({
      handled_by: 'person',
      taken_over_by: w.owner.id,
    });
    expect(await inHands(c.id)).toMatchObject({
      personId: c.id,
      how: 'wrote',
      place: 'sms',
      user: { id: w.owner.id },
    });
    expect(await events('person.taken_over', c.id)).toBe(1);

    // They write again: the AI stays quiet.
    await textIn(w, c.phone, 'Saturday morning?');
    await replyNow(w, m.conversationId);
    expect(await aiReplies(m.conversationId)).toHaveLength(1);

    // A website chat that starts later, once it's theirs, starts in the same hands, and the AI leaves it too.
    const chat = await chatIn(w, c.id, 'Also, do you do windows?');
    expect(await conversationOf(chat.conversationId)).toMatchObject({
      handled_by: 'person',
      taken_over_by: w.owner.id,
    });
    await replyNow(w, chat.conversationId);
    expect(await aiReplies(chat.conversationId)).toHaveLength(0);

    // Writing to them again keeps them in the same hands, with no second "taken over".
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: m.conversationId,
      channel: 'sms',
      body: 'Saturday at 9 works.',
    });
    expect(await events('person.taken_over', c.id)).toBe(1);
  });

  it('Give back to the AI hands their conversations back, and it answers what they’re waiting on', async () => {
    const c = await newCustomer(w, 'Ivo');
    const m = await textIn(w, c.phone, 'Can you quote a new roof?');
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: m.conversationId,
      channel: 'sms',
      body: 'Hi Ivo, let me check.',
    });
    await textIn(w, c.phone, 'Any news?');
    expect(await inHands(c.id)).not.toBeNull();

    const out = await run(w, personHandBack, { workspaceId: w.workspaceId, personIds: [c.id] });
    expect(out).toEqual({ handedBack: 1, toAi: 1 });
    expect(await inHands(c.id)).toBeNull();
    expect(await conversationOf(m.conversationId)).toMatchObject({
      handled_by: 'ai',
      taken_over_by: null,
    });
    expect(await events('person.handed_back', c.id)).toBe(1);
    await replyNow(w, m.conversationId);
    expect(await aiReplies(m.conversationId)).toHaveLength(1);

    // Giving back someone who's in nobody's hands changes nothing.
    expect(await run(w, personHandBack, { workspaceId: w.workspaceId, personIds: [c.id] })).toEqual(
      { handedBack: 0, toAi: 0 },
    );
  });

  it('Take over from the customer’s page holds the AI back, and Pick up is refused while someone has them', async () => {
    const c = await newCustomer(w, 'Jun');
    const m = await textIn(w, c.phone, 'Is my appointment still on?');
    const took = await run(w, personTakeOver, { workspaceId: w.workspaceId, personId: c.id });
    expect(took).toMatchObject({ personId: c.id, already: false });
    expect(await inHands(c.id)).toMatchObject({ how: 'took_over', place: null });
    expect(await conversationOf(m.conversationId)).toMatchObject({ handled_by: 'person' });
    await replyNow(w, m.conversationId);
    expect(await aiReplies(m.conversationId)).toHaveLength(0);

    // Pressing it again changes nothing.
    expect(
      await run(w, personTakeOver, { workspaceId: w.workspaceId, personId: c.id }),
    ).toMatchObject({ already: true });
    // The AI's own Pick up can't take a conversation back from someone's hands.
    await rows(
      admin(),
      sql`update app.conversations set handled_by = 'none', taken_over_by = null where id = ${m.conversationId}`,
    );
    await expect(
      executeCommand(
        testDbs().worker.db,
        conversationPickUp,
        { workspaceId: w.workspaceId, conversationId: m.conversationId },
        systemActor(scopeOf(w)),
        { correlationId: randomUUID(), channel: 'worker' },
      ),
    ).rejects.toMatchObject({
      rule: 'conversation_taken',
      message: expect.stringMatching(/in their hands/),
    });
  });

  it('Give all back, only mine, takes only the person’s own', async () => {
    const a = await newCustomer(w, 'Kai');
    const b = await newCustomer(w, 'Lea');
    await run(w, personTakeOver, { workspaceId: w.workspaceId, personId: a.id });
    await run(w, personTakeOver, { workspaceId: w.workspaceId, personId: b.id });
    // Lea is someone else's: a teammate who has left.
    await rows(
      admin(),
      sql`update app.people_in_hands set user_id = null where person_id = ${b.id}`,
    );

    const all = await query(w, personInHands, { workspaceId: w.workspaceId });
    expect(all.people.map((p) => p.personId)).toEqual(expect.arrayContaining([a.id, b.id]));
    const mine = await query(w, personInHands, { workspaceId: w.workspaceId, mine: true });
    expect(mine.people.map((p) => p.personId)).not.toContain(b.id);

    await run(w, personHandBack, { workspaceId: w.workspaceId, all: true, mine: true });
    expect(await inHands(a.id)).toBeNull();
    expect(await inHands(b.id)).toMatchObject({ user: null });
    await expect(run(w, personHandBack, { workspaceId: w.workspaceId })).rejects.toMatchObject({
      status: 400,
    });
  });
});
