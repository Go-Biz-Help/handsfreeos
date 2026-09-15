/**
 * The AI teammate answering customers (M7 step 6), on the real database with the fake carrier and the scripted
 * model: quick texts batched into one debounced run and the 90-second ceiling; replies sent (automatic) or
 * drafted (training), and the switch to automatic at N approvals; booking ("book me Thursday"), held in a draft
 * until approved, and a held time someone took before the approval; the quiet-hours reply window; and a website
 * chat visitor, who gets none of the matched customer's record.
 */
import { localDateOf, weekdayOf } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replyJobKey } from '../src/ai-team/index';
import {
  addFact,
  admin,
  aiMessages,
  aiReplies,
  allowPrices,
  appointmentsOf,
  attendeeByToken,
  bookOnline,
  chatIn,
  CHI,
  conversationOf,
  customer,
  decide,
  draftsOf,
  drain,
  handoffLines,
  hh,
  hourNow,
  newCustomer,
  openSlot,
  pendingReply,
  replyNow,
  requestAbout,
  runsOf,
  saveTeammate,
  setQuietHours,
  teammateWorld,
  textIn,
  textsTo,
  toolCallsOf,
  type TeammateWorld,
} from './ai-team-world';

let auto: TeammateWorld;
let training: TeammateWorld;

beforeAll(async () => {
  // An Appointment Coordinator on its own calendar, automatic, allowed to quote the price it knows.
  auto = await teammateWorld('tmauto', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
  await allowPrices(auto);
  await addFact(auto, 'AC tune-up price', 'An AC tune-up costs $89 and takes about an hour.');
  training = await teammateWorld('tmtrain', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
  });
});
afterAll(async () => {
  await auto.app.close();
  await training.app.close();
  await closeTestDbs();
});

describe('batching and debounce', () => {
  it('answers three quick texts in one run, each text pushing the reply back', async () => {
    const c = await newCustomer(auto, 'Bea');
    const one = await textIn(auto, c.phone, 'Hi there');
    const first = await pendingReply(one.conversationId);
    await textIn(auto, c.phone, 'Quick question for you');
    const second = await pendingReply(one.conversationId);
    await textIn(auto, c.phone, 'How much is an AC tune-up?');
    const third = await pendingReply(one.conversationId);
    expect(second!.runAt).toBeGreaterThan(first!.runAt);
    expect(third!.runAt).toBeGreaterThan(second!.runAt);
    expect(third!.runAt).toBeLessThanOrEqual(Date.now() + 20_000);
    expect(third!.runAt).toBeLessThanOrEqual(one.at + 90_000);
    const [jobs] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs where dedupe_key = ${replyJobKey(one.conversationId)}`,
    );
    expect(jobs!.n).toBe(1);
    expect(await runsOf(one.conversationId)).toHaveLength(0);

    await replyNow(auto, one.conversationId);
    const runs = await runsOf(one.conversationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'done',
      outcome: 'replied',
      triggered_by: 'message.received',
    });
    expect(runs[0]!.message_ids).toHaveLength(3);
    expect(runs[0]!.knowledge).toEqual([expect.objectContaining({ title: 'AC tune-up price' })]);
    expect(runs[0]!.checks.every((ch) => ch.ok)).toBe(true);
    const sent = await aiMessages(one.conversationId);
    expect(sent).toHaveLength(1);
    // Its first message says it's an AI (first_message), and the price is the one the knowledge base gives.
    expect(sent[0]!.body_text).toContain('AI assistant');
    expect(sent[0]!.body_text).toContain('$89');
    expect(sent[0]!.ai_run_id).toBe(runs[0]!.id);
    expect(textsTo(auto, c.phone).map((t) => t.body)).toContain(sent[0]!.body_text);
    const conv = await conversationOf(one.conversationId);
    expect(conv).toMatchObject({ handled_by: 'ai', ai_teammate_id: auto.teammateId });
    expect(conv.ai_disclosed_at).not.toBeNull();
  });

  it('never waits more than 90 seconds after the first unanswered message', async () => {
    const c = await newCustomer(auto, 'Cal');
    const m = await textIn(auto, c.phone, 'Hello, what are your hours?', { secondsAgo: 80 });
    const job = await pendingReply(m.conversationId);
    // A text waits 20 seconds for more, but this one came in 80 seconds ago: its reply is due 10 seconds from now.
    expect(Math.abs(job!.runAt - (m.at + 90_000))).toBeLessThan(5);
    await replyNow(auto, m.conversationId);
    expect(await aiMessages(m.conversationId)).toHaveLength(1);
  });
});

describe('automatic and training', () => {
  it('makes one draft while training, with the message, its client id and the text it answers', async () => {
    const c = await newCustomer(training, 'Dee');
    const m = await textIn(training, c.phone, 'What areas do you serve?');
    await replyNow(training, m.conversationId);
    const [r] = await runsOf(m.conversationId);
    expect(r).toMatchObject({ status: 'done', outcome: 'drafted' });
    const drafts = await draftsOf(m.conversationId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'reply', status: 'pending', client_id: `ai:${r!.id}` });
    expect(drafts[0]!.preview.message).toMatchObject({
      channel: 'sms',
      inReplyToMessageId: m.messageId,
    });
    expect(drafts[0]!.preview.message!.body).toContain('AI assistant');
    expect(await aiMessages(m.conversationId)).toHaveLength(0);
  });

  it('turns automatic at the third approval, and then replies without a draft', async () => {
    const t = await teammateWorld('tmthree');
    // The builder keeps it between 5 and 200; the database counts to whatever the settings say.
    await rows(
      admin(),
      sql`update app.ai_teammates set config = jsonb_set(config, '{autonomy,approvalsNeeded}', '3')
          where id = ${t.teammateId}`,
    );
    try {
      const c = await newCustomer(t, 'Nora');
      let conversationId = '';
      for (let i = 1; i <= 3; i++) {
        const m = await textIn(t, c.phone, `Question ${i}: do you work in Katy?`);
        conversationId = m.conversationId;
        await replyNow(t, conversationId);
        const pending = (await draftsOf(conversationId)).filter((d) => d.status === 'pending');
        expect(pending).toHaveLength(1);
        expect(await aiMessages(conversationId)).toHaveLength(i - 1);
        const out = await decide(t, pending[0]!.id, 'approve');
        expect(out.progress.becameAutomatic).toBe(i === 3);
        await drain(t);
        const sent = await aiMessages(conversationId);
        expect(sent).toHaveLength(i);
        // It goes out as the teammate, with the approver's name and the draft on it.
        expect(sent[i - 1]).toMatchObject({ approved_by: t.owner.id, ai_draft_id: pending[0]!.id });
      }
      await textIn(t, c.phone, 'And do you work weekends?');
      await replyNow(t, conversationId);
      expect((await draftsOf(conversationId)).filter((d) => d.status === 'pending')).toHaveLength(
        0,
      );
      const sent = await aiMessages(conversationId);
      expect(sent).toHaveLength(4);
      expect(sent[3]).toMatchObject({ approved_by: null, ai_draft_id: null });
      expect(textsTo(t, c.phone)).toHaveLength(4);
    } finally {
      await t.app.close();
    }
  });
});

describe('booking', () => {
  it('books "Thursday" when automatic: find_times, then book, then the reply', async () => {
    const c = await newCustomer(auto, 'Eve');
    const m = await textIn(auto, c.phone, 'Can you book me in for Thursday?');
    await replyNow(auto, m.conversationId);
    const [r] = await runsOf(m.conversationId);
    expect(r).toMatchObject({ status: 'done', outcome: 'replied' });
    const calls = await toolCallsOf(r!.id);
    expect(calls.map((x) => [x.tool, x.status])).toEqual([
      ['find_times', 'done'],
      ['book', 'held'],
      ['reply', 'done'],
    ]);
    const booked = await appointmentsOf(c.id);
    expect(booked).toHaveLength(1);
    expect(weekdayOf(localDateOf(new Date(booked[0]!.starts_at).getTime(), CHI))).toBe(4);
    const [sent] = await aiMessages(m.conversationId);
    // Texts go out plain: straight apostrophes.
    expect(sent!.body_text).toMatch(/You're booked for Thu/);
  });

  it('holds a booking in the draft until approved, and hands off when the time was taken meanwhile', async () => {
    const f = await newCustomer(training, 'Frank');
    const one = await textIn(training, f.phone, 'Please book me for Thursday');
    await replyNow(training, one.conversationId);
    const [held] = await draftsOf(one.conversationId);
    expect(held!.preview.actions).toEqual([expect.objectContaining({ kind: 'book' })]);
    expect(await appointmentsOf(f.id)).toHaveLength(0);
    await decide(training, held!.id, 'approve');
    await drain(training);
    expect(await appointmentsOf(f.id)).toHaveLength(1);
    expect(await aiMessages(one.conversationId)).toHaveLength(1);

    const g = await newCustomer(training, 'Gia');
    const two = await textIn(training, g.phone, 'Book me Thursday please');
    await replyNow(training, two.conversationId);
    const [draft] = await draftsOf(two.conversationId);
    const startsAt = draft!.preview.actions[0]!.startsAt!;
    // Someone else takes that time on the booking page before anyone approves.
    await bookOnline(training, training.calendar!.slug, Date.parse(startsAt), {
      ...customer('Hal'),
      smsConsent: true,
    });
    await decide(training, draft!.id, 'approve');
    await drain(training);
    expect(await appointmentsOf(g.id)).toHaveLength(0);
    // No reply went out; the customer hears the hand-off line instead.
    expect(await aiReplies(two.conversationId)).toHaveLength(0);
    expect(await handoffLines(two.conversationId)).toHaveLength(1);
    const conv = await conversationOf(two.conversationId);
    expect(conv).toMatchObject({ handled_by: 'person', handoff_reason: 'error' });
    expect(conv.handoff_note).toMatch(/couldn’t go out/);
  });
});

describe('quiet hours', () => {
  it('answers a text from 14 minutes ago, and waits for the morning at 16', async () => {
    await setQuietHours(auto, { start: hh(hourNow() - 1), end: hh(hourNow() + 2) });
    try {
      const a = await newCustomer(auto, 'Lena');
      const early = await textIn(auto, a.phone, 'Are you open tomorrow?', { secondsAgo: 14 * 60 });
      await replyNow(auto, early.conversationId);
      expect(await aiMessages(early.conversationId)).toHaveLength(1);

      const b = await newCustomer(auto, 'Otto');
      const late = await textIn(auto, b.phone, 'Are you open tomorrow?', { secondsAgo: 16 * 60 });
      await replyNow(auto, late.conversationId);
      expect(await aiMessages(late.conversationId)).toHaveLength(0);
      const [r] = await runsOf(late.conversationId);
      expect(r).toMatchObject({ status: 'done', outcome: 'no_reply' });
      expect(r!.summary).toMatch(/^Quiet hours/);
      // It answers again once quiet hours end (at least an hour from now).
      const job = await pendingReply(late.conversationId);
      expect(job!.runAt).toBeGreaterThan(Date.now() + 50 * 60_000);
      expect((await conversationOf(late.conversationId)).ai_answered_through).toBeNull();
    } finally {
      await setQuietHours(auto, null);
    }
  });
});

describe('website chat', () => {
  it('gives an unverified visitor none of the matched customer’s history, visits or details', async () => {
    await saveTeammate(auto, { channels: { chat: true } });
    const p = await newCustomer(auto, 'Priya');
    // Priya's own texts, and a visit she booked.
    const sms = await textIn(auto, p.phone, 'My gate code is 4321');
    await replyNow(auto, sms.conversationId);
    const booked = await bookOnline(auto, auto.calendar!.slug, await openSlot(auto, 3), {
      name: 'Priya Customer',
      phone: p.phone,
      email: p.email,
      smsConsent: true,
    });
    const { appointment_id: appointmentId } = await attendeeByToken(booked.manageToken);
    expect(await appointmentsOf(p.id)).toEqual([expect.objectContaining({ id: appointmentId })]);

    // Someone types Priya's number into the website chat: the chat is linked to her, as chat.identify does.
    const chat = await chatIn(auto, p.id, 'When is my appointment?');
    await drain(auto);
    const req = requestAbout(auto, 'When is my appointment?');
    expect(req).toBeDefined();
    const seen = `${req!.context}\n${JSON.stringify(req!.messages)}`;
    expect(seen).toContain('website chat visitor');
    expect(seen).not.toContain('4321');
    expect(seen).not.toContain(p.phone);
    expect(seen).not.toContain(p.email!);
    expect(seen).not.toContain(appointmentId);
    const tools = (req!.tools ?? []).map((t) => t.name);
    for (const hidden of ['my_appointments', 'reschedule', 'cancel', 'update_customer'])
      expect(tools).not.toContain(hidden);
    expect(tools).toContain('find_times');
    const sent = await aiMessages(chat.conversationId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'chat', status: 'sent' });
  });

  it('stays out of a chat whose widget is left to people, whatever its own chat setting says', async () => {
    await saveTeammate(auto, { channels: { chat: true } });
    const chat = await chatIn(auto, null, 'Hi, what are your hours?', { teammate: false });
    expect(await pendingReply(chat.conversationId)).toBeNull();
    await drain(auto);
    expect(await runsOf(chat.conversationId)).toHaveLength(0);
    expect(await aiMessages(chat.conversationId)).toHaveLength(0);
    expect((await conversationOf(chat.conversationId)).handled_by).toBe('none');
  });
});
