/**
 * M10 on the real database, with the fake carrier, the push stand-in and Mailpit: the moments about a customer quote
 * what the customer said last, never the business's own words that came after it in the conversation. The card, the
 * urgent email and the push say the same (core's loadCustomerSaid; the cards' own cases are in core's
 * attention-customer-said.test.ts).
 * - **A customer waiting** after an automatic payment receipt, and after the AI teammate's hand-off line.
 * - **A hot lead** after the AI teammate's hand-off line.
 * - **A new lead nobody answered** after an automatic reply.
 * - **A conversation given to someone** after an automatic text.
 * - **A photo alone:** "Sent a photo.".
 */
import { randomUUID } from 'node:crypto';
import {
  conversationAssign,
  executeCommand,
  leadCreate,
  messageReceive,
  messageSend,
  pushDeviceRegister,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PushMessage } from '../src/push/index';
import { systemActor } from '../src/services';
import {
  HANDOFF_LINE,
  handoffLines,
  newCustomer,
  replyNow,
  runDue,
  teammateWorld,
  textIn,
  type TeammateWorld,
} from './ai-team-world';
import {
  attentionWorld,
  filedCustomer,
  inboundLead,
  itemOf,
  runSweep,
  setReplyThreshold,
  sys,
  type AttentionWorld,
} from './attention-world';
import { admin, api, drain, post, run, waitForMail, type World } from './booking-world';

afterAll(closeTestDbs);

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));

/** A phone the person signed in on, as the app registers it; answers its token. */
async function phoneOf(u: TestUser, label: string): Promise<string> {
  const token = `ExponentPushToken[${label}-${randomUUID().slice(0, 12)}]`;
  const actor: HumanActor = { type: 'human', userId: u.id, email: u.email, claims: u.claims };
  await executeCommand(
    api(),
    pushDeviceRegister,
    { platform: 'ios', token, appVersion: '1.0.0', deviceName: label },
    actor,
    { correlationId: randomUUID(), channel: 'test' },
  );
  return token;
}

/** The pushes a phone was handed with this title, oldest first. */
const pushesTitled = (w: World, token: string, title: string): PushMessage[] =>
  w.s.push.fake.sent.map((s) => s.message).filter((m) => m.to === token && m.title === title);

/** Everything the Action Center has waiting for the business, run now. */
async function runJobs(w: World): Promise<void> {
  const res = await post(w, '/test/attention/run-jobs', { workspaceId: w.workspaceId });
  expect(res.statusCode, res.body).toBe(200);
  await drain(w);
}

/** HandsFreeOS's own text in the conversation (a receipt, a confirmation): the customer still waits. */
async function automaticText(w: World, conversationId: string, body: string): Promise<void> {
  await sys(w, messageSend, {
    workspaceId: w.workspaceId,
    conversationId,
    body,
    keepConversationStatus: true,
  });
  await drain(w);
}

/** The customer's wait began `minutes` ago (no event: only the clock moves). */
const waitedMinutes = (conversationId: string, minutes: number) =>
  rows(
    admin(),
    sql`update app.conversations
        set awaiting_reply_since = awaiting_reply_since - ${`${minutes} minutes`}::interval
        where id = ${conversationId}`,
  );

const lastPreviewOf = async (conversationId: string) =>
  (
    await rows<{ last_preview: string | null; last_direction: string | null }>(
      admin(),
      sql`select last_preview, last_direction::text as last_direction from app.conversations
          where id = ${conversationId}`,
    )
  )[0]!;

describe('after an automatic text', () => {
  let w: AttentionWorld;
  let dale: string;
  let marco: string;

  beforeAll(async () => {
    w = await attentionWorld('custsaid');
    // A customer's message waits 10 minutes before the urgent email.
    await setReplyThreshold(w, 10);
    dale = await phoneOf(w.owner, 'dale');
    marco = await phoneOf(w.member, 'marco');
  });
  afterAll(async () => {
    await w?.app.close();
  });

  it('a customer waiting: the card, the urgent email and the push quote their text, not the receipt', async () => {
    const c = await filedCustomer(w, 'Linda');
    const words = 'Did my payment go through? I paid the invoice this morning.';
    const { conversationId } = await textIn(w, c.phone, words);
    await automaticText(
      w,
      conversationId,
      'Thanks, Linda. We got your $3,418.84 payment for invoice INV-1001. Your receipt: https://pay.example.com/r/1001',
    );
    expect(await lastPreviewOf(conversationId)).toMatchObject({ last_direction: 'outbound' });
    await waitedMinutes(conversationId, 11);
    await runSweep(w);
    await runJobs(w);

    const mail = await waitForMail(w.owner.email, 'Linda Test is waiting for a reply');
    expect(mail.text).toContain(`“${words}”`);
    expect(mail.text).not.toContain('We got your');
    expect((await itemOf(w, conversationId, 'customer_waiting')).detail).toBe(words);
    const [push] = pushesTitled(w, dale, 'Customer waiting · Linda Test');
    expect(push?.body).toBe(words);
  });

  it('a photo alone: “Sent a photo.” on the card, in the email and in the push', async () => {
    const c = await filedCustomer(w, 'Pat');
    const { output } = await executeCommand(
      testDbs().worker.db,
      messageReceive,
      {
        workspaceId: w.workspaceId,
        provider: 'fake',
        providerMessageId: `SM${randomUUID()}`,
        from: c.phone,
        to: w.number!,
        body: '',
        media: [
          {
            bucket: 'telephony',
            objectPath: `${w.workspaceId}/messages/${randomUUID()}/0.jpg`,
            contentType: 'image/jpeg',
            sizeBytes: 2048,
            name: 'photo-1.jpg',
          },
        ],
        reminderAfterMs: 86_400_000,
      },
      systemActor({ workspaceId: w.workspaceId, organizationId: w.organizationId }),
      { correlationId: randomUUID(), channel: 'worker' },
    );
    await drain(w);
    await automaticText(
      w,
      output.conversationId,
      'Your visit with us is confirmed for Friday at 9:00 AM.',
    );
    await waitedMinutes(output.conversationId, 11);
    await runSweep(w);
    await runJobs(w);

    const mail = await waitForMail(w.owner.email, 'Pat Test is waiting for a reply');
    expect(mail.text).toContain('“Sent a photo.”');
    expect(mail.text).toContain('with 1 photo');
    expect(mail.text).not.toContain('is confirmed');
    expect((await itemOf(w, output.conversationId, 'customer_waiting')).detail).toBe(
      'Sent a photo.',
    );
    const [push] = pushesTitled(w, dale, 'Customer waiting · Pat Test');
    expect(push?.body).toBe('Sent a photo.');
  });

  it('a new lead nobody answered: the email and the push quote their text, not the automatic reply', async () => {
    const c = await filedCustomer(w, 'Tom');
    const words = 'Do you service tankless water heaters?';
    const { conversationId } = await textIn(w, c.phone, words);
    await automaticText(
      w,
      conversationId,
      'Thanks for texting! We got your message and will be in touch shortly.',
    );
    // Then their lead is made, and waits 20 minutes with nobody reaching out (only its clock moves).
    const leadId = await inboundLead(w, c.id, 'Tankless water heater', 20);
    await drain(w);
    await runSweep(w);
    await runJobs(w);

    const mail = await waitForMail(w.owner.email, 'New lead: Tom Test');
    expect(mail.text).toContain(`“${words}”`);
    expect(mail.text).not.toContain('We got your message');
    const item = await itemOf(w, leadId, 'unanswered_lead');
    expect(item.conversationId).toBe(conversationId);
    const [push] = pushesTitled(w, dale, 'Unanswered lead · Tom Test');
    expect(push?.body).toBe(`Tankless water heater. ${words}`);
  });

  it('a conversation given to someone: the push quotes their text, not the automatic text after it', async () => {
    const c = await filedCustomer(w, 'Rosa');
    const { conversationId } = await textIn(w, c.phone, 'Thursday works for me.');
    await automaticText(w, conversationId, 'See you Thursday at 10:00 AM.');
    await run(w, conversationAssign, {
      workspaceId: w.workspaceId,
      conversationId,
      assigneeUserId: w.member.id,
    });
    await drain(w);
    const [push] = pushesTitled(w, marco, 'Assigned to you · Rosa Test');
    expect(push?.body).toBe('“Thursday works for me.” · from Dale Owner');
  });
});

describe('after the AI teammate’s hand-off line', () => {
  let t: TeammateWorld;
  let dale: string;

  beforeAll(async () => {
    t = await teammateWorld('custsaidai', { status: 'automatic' });
    // Open all week, so a hand-off's 15 open-hours minutes are 15 minutes whenever the suite runs.
    await rows(
      admin(),
      sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ openHours: ALL_WEEK })}::jsonb
          where id = ${t.workspaceId}`,
    );
    await setReplyThreshold(t, 10);
    dale = await phoneOf(t.owner, 'dale-ai');
  });
  afterAll(async () => {
    await t?.app.close();
  });

  /** The teammate hands the conversation to a person, and says so to the customer: its words come last. */
  async function handedOff(phone: string, words: string): Promise<string> {
    const m = await textIn(t, phone, words);
    await replyNow(t, m.conversationId);
    const [line] = await handoffLines(m.conversationId);
    expect(line?.body_text).toMatch(HANDOFF_LINE);
    expect(await lastPreviewOf(m.conversationId)).toMatchObject({ last_direction: 'outbound' });
    return m.conversationId;
  }

  it('a customer waiting: the urgent email and the push quote them, not the teammate', async () => {
    const c = await newCustomer(t, 'Lena');
    const words = 'Could somebody call me back?';
    const conversationId = await handedOff(c.phone, words);
    // Sixteen minutes on, nobody has written back.
    await rows(
      admin(),
      sql`update app.conversations set needs_person_since = needs_person_since - interval '16 minutes'
          where id = ${conversationId}`,
    );
    await runDue(t, [`unanswered:${conversationId}`]);

    const mail = await waitForMail(t.owner.email, 'Lena Customer is waiting for a reply');
    expect(mail.text).toContain(`“${words}”`);
    expect(mail.text).not.toContain('Thanks for your patience');
    const [push] = pushesTitled(t, dale, 'Customer waiting · Lena Customer');
    expect(push?.body).toBe(words);
  });

  it('a hot lead: the card, the urgent email and the push quote them, not the teammate', async () => {
    const c = await newCustomer(t, 'Nora');
    const words =
      'Can you come out today? I want to get this booked ASAP. Could somebody call me back?';
    const conversationId = await handedOff(c.phone, words);
    // Her lead came in on its own, and she has waited 11 minutes.
    const { leadId } = await sys(t, leadCreate, {
      workspaceId: t.workspaceId,
      title: 'No cooling',
      personId: c.id,
    });
    await drain(t);
    await waitedMinutes(conversationId, 11);
    await runSweep(t);
    await runJobs(t);

    const mail = await waitForMail(t.owner.email, 'Hot lead: Nora Customer is waiting');
    expect(mail.text).toContain(`“${words}”`);
    expect(mail.text).not.toContain('Thanks for your patience');
    expect((await itemOf(t, leadId, 'hot_lead')).detail).toBe(words);
    const [push] = pushesTitled(t, dale, 'Hot lead · Nora Customer');
    expect(push?.body).toBe(`No cooling. ${words}`);
  });
});
