/**
 * Chat replies the visitor hasn't seen (M7 step 8): a person's reply is marked sent and arms the follow-up; 10
 * minutes later the unseen replies go out once per batch, by email when the visitor gave one, otherwise by text
 * when their customer agreed to texts (and after quiet hours); seen or answered replies never do. Also the
 * timeline backfill for a chat that finds its customer, and how the team's unanswered-reply email names a
 * chat's visitor.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { scheduledJobs } from '@hfos/db/schema';
import { closeTestDbs } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHAT_UNREAD_AFTER_MS,
  chatUnreadFollowUp,
  onChatReplySent,
  unreadFollowUpKey,
} from '../src/chat/followup';
import { conversationContact } from '../src/chat/store';
import { unansweredEmail } from '../src/emails/templates';
import { onConversationLinked } from '../src/handlers/telephony';
import type { HandlerMap } from '../src/handlers/types';
import {
  admin,
  chatServer,
  chatWorld,
  closeServers,
  conversationOf,
  emailsTo,
  hh,
  hourNow,
  MIN,
  nextPhone,
  PAGE,
  processChatEvents,
  readyTexting,
  setQuietHours,
  SITE,
  staffReply,
  startedVisitor,
  visitorRow,
  type ChatWorld,
} from './chat-world';

const HANDLERS: HandlerMap = {
  'message.sent': onChatReplySent,
  'conversation.linked': onConversationLinked,
};
const LINK = `${SITE}${PAGE}#hfos-chat`;

let w: ChatWorld;
let app: FastifyInstance;
let business: string;

beforeAll(async () => {
  w = await chatWorld('chat-followup');
  app = await chatServer(w);
  await readyTexting(w);
  business = 'chat-followup Booking HVAC';
});
afterAll(async () => {
  await closeServers();
  await closeTestDbs();
});

async function pendingJob(conversationId: string) {
  const [job] = await admin()
    .select()
    .from(scheduledJobs)
    .where(
      and(
        eq(scheduledJobs.dedupeKey, unreadFollowUpKey(conversationId)),
        eq(scheduledJobs.status, 'pending'),
      ),
    );
  return job;
}

/** The follow-up job for this chat, run as of `now`. */
async function followUp(conversationId: string, now: number) {
  const job = await pendingJob(conversationId);
  expect(job).toBeDefined();
  return chatUnreadFollowUp({
    ...w.s,
    job: job!,
    scope: { workspaceId: w.workspaceId, organizationId: w.organizationId },
    attempt: 1,
    now,
  });
}

async function emailBodies(address: string): Promise<string[]> {
  const list = await rows<{ body_text: string }>(
    admin(),
    sql`select m.body_text from app.messages m join app.conversations c on c.id = m.conversation_id
        where c.workspace_id = ${w.workspaceId} and c.channel = 'email' and c.counterpart = ${address}
          and m.direction = 'outbound' order by m.created_at`,
  );
  return list.map((m) => m.body_text);
}

async function textsTo(phone: string): Promise<string[]> {
  const list = await rows<{ body_text: string }>(
    admin(),
    sql`select m.body_text from app.messages m join app.conversations c on c.id = m.conversation_id
        where c.workspace_id = ${w.workspaceId} and c.channel = 'sms' and c.counterpart = ${phone}
          and m.direction = 'outbound' order by m.created_at`,
  );
  return list.map((m) => m.body_text);
}

const later = (ms: number) => Date.now() + ms;

describe('replies the visitor hasn’t seen', () => {
  it('marks a person’s reply sent, then emails the unseen replies once per batch after 10 minutes', async () => {
    const email = `maria-${randomUUID().slice(0, 6)}@example.com`;
    const v = await startedVisitor(app, w.key, '198.51.100.40');
    await v.send('Do you do duct cleaning?');
    expect((await v.identify({ name: 'Maria Lopez', email })).statusCode).toBe(200);
    const conversationId = await conversationOf(v);
    const reply = await staffReply(w, conversationId, 'Yes, we do. Want a quote?');
    expect(reply.status).toBe('queued');
    await processChatEvents(w, HANDLERS);
    // The live feed showed it the moment it was saved, so it's sent.
    const [m] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.messages where id = ${reply.messageId}`,
    );
    expect(m!.status).toBe('sent');
    const job = await pendingJob(conversationId);
    expect(job!.runAt.getTime() - Date.now()).toBeGreaterThan(CHAT_UNREAD_AFTER_MS - MIN);

    // Too soon: it waits for the 10 minutes.
    const early = await followUp(conversationId, later(5 * MIN));
    expect(early).toMatchObject({ rescheduleAt: expect.any(Date) });
    expect(await emailsTo(w, email)).toEqual([]);

    // Unseen for 10 minutes: one email, with the reply and a link back to the chat.
    expect(await followUp(conversationId, later(11 * MIN))).toBeUndefined();
    expect(await emailsTo(w, email)).toEqual([`${business} replied to your chat`]);
    const [body] = await emailBodies(email);
    expect(body).toContain('Dale: Yes, we do. Want a quote?');
    expect(body).toContain(`Continue the chat: ${LINK}`);
    // Once per batch.
    await followUp(conversationId, later(12 * MIN));
    expect(await emailsTo(w, email)).toHaveLength(1);

    // A later reply is a new batch, carrying only itself.
    await staffReply(w, conversationId, 'We have openings Thursday.');
    await processChatEvents(w, HANDLERS);
    await followUp(conversationId, later(11 * MIN));
    const bodies = await emailBodies(email);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('We have openings Thursday.');
    expect(bodies[1]).not.toContain('Want a quote?');
  });

  it('sends nothing for replies the window showed, or that the visitor answered', async () => {
    const email = `sam-${randomUUID().slice(0, 6)}@example.com`;
    const v = await startedVisitor(app, w.key, '198.51.100.41');
    await v.send('What are your hours?');
    await v.identify({ email });
    const conversationId = await conversationOf(v);
    const seen = await staffReply(w, conversationId, 'We’re open 8 to 5, Monday to Friday.');
    await processChatEvents(w, HANDLERS);
    expect((await v.read(seen.messageId)).statusCode).toBe(200);
    expect(await followUp(conversationId, later(11 * MIN))).toBeUndefined();
    await staffReply(w, conversationId, 'Anything else?');
    await v.send('No, that’s all. Thanks!');
    await processChatEvents(w, HANDLERS);
    expect(await followUp(conversationId, later(11 * MIN))).toBeUndefined();
    expect(await emailsTo(w, email)).toEqual([]);
  });

  it('texts when the visitor gave a number and agreed to texts, waiting out quiet hours; never without consent', async () => {
    const phone = nextPhone();
    const v = await startedVisitor(app, w.key, '198.51.100.42');
    await v.send('Can someone text me a quote?');
    expect((await v.identify({ name: 'Tom Reyes', phone, smsConsent: true })).statusCode).toBe(200);
    const conversationId = await conversationOf(v);
    await staffReply(w, conversationId, 'A tune-up is $89. Want to book?');
    await processChatEvents(w, HANDLERS);

    // In quiet hours it waits for them to end.
    await setQuietHours(w, { start: hh(hourNow() - 1), end: hh(hourNow() + 2) });
    try {
      const waited = (await followUp(conversationId, later(11 * MIN))) as { rescheduleAt: Date };
      expect(waited.rescheduleAt.getTime()).toBeGreaterThan(later(11 * MIN));
      expect(waited.rescheduleAt.getTime()).toBeLessThanOrEqual(later(3 * 60 * MIN + 11 * MIN));
      expect(await textsTo(phone)).toEqual([]);
    } finally {
      await setQuietHours(w, null);
    }
    expect(await followUp(conversationId, later(11 * MIN))).toBeUndefined();
    const texts = await textsTo(phone);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(
      `${business}: Dale replied to your chat: "A tune-up is $89. Want to book?"`,
    );
    expect(texts[0]).toContain(`Continue here: ${LINK}`);
    expect(texts[0]).toContain('Reply STOP to opt out.');

    // No texts box ticked: no text (and nothing else to reach them by).
    const other = nextPhone();
    const quiet = await startedVisitor(app, w.key, '198.51.100.43');
    await quiet.send('Just looking');
    await quiet.identify({ phone: other });
    const otherConversation = await conversationOf(quiet);
    await staffReply(w, otherConversation, 'Let us know if you have questions.');
    await processChatEvents(w, HANDLERS);
    expect(await followUp(otherConversation, later(11 * MIN))).toBeUndefined();
    expect(await textsTo(other)).toEqual([]);
  });
});

describe('chats in the rest of the app', () => {
  it('files a chat’s earlier messages on the customer’s timeline as chat once it finds them', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.44');
    await v.send('Hello, I need a quote');
    await v.send('For a new AC');
    await v.identify({ name: 'Nina Park', phone: nextPhone() });
    await processChatEvents(w, HANDLERS);
    const conversationId = await conversationOf(v);
    const [c] = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from app.conversations where id = ${conversationId}`,
    );
    const timeline = await rows<{ kind: string; subtype: string; body: string }>(
      admin(),
      sql`select kind::text as kind, subtype, body from app.activities
          where person_id = ${c!.person_id} and kind = 'chat' order by occurred_at`,
    );
    expect(timeline).toEqual([
      { kind: 'chat', subtype: 'inbound', body: 'Hello, I need a quote' },
      { kind: 'chat', subtype: 'inbound', body: 'For a new AC' },
    ]);
  });

  it('names a chat’s visitor in the team’s unanswered-reply email, never chat:<id>', async () => {
    const named = await startedVisitor(app, w.key, '198.51.100.45');
    await named.send('Hi');
    await named.identify({ name: 'Grace Kim' });
    const unnamed = await startedVisitor(app, w.key, '198.51.100.46');
    await unnamed.send('Hello?');
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    const contactOf = async (conversationId: string) => {
      const [c] = await rows<{ id: string; channel: string; counterpart: string }>(
        admin(),
        sql`select id, channel::text as channel, counterpart from app.conversations where id = ${conversationId}`,
      );
      return asWorker(w.s.db, scope, (tx) => conversationContact(tx, c!));
    };
    expect(await contactOf(await conversationOf(named))).toBe('Grace Kim');
    expect(await contactOf(await conversationOf(unnamed))).toBe('Website visitor');
    expect((await visitorRow(unnamed)).conversation_id).not.toBeNull();
    const mail = unansweredEmail({
      customer: 'Website visitor',
      firstName: 'Website visitor',
      business: 'Lone Star',
      minutesWaiting: 16,
      preview: 'Hello?',
      receivedAt: '9:14 AM',
      contact: 'Website visitor',
      link: 'http://localhost:3000/app/inbox',
      assignedToYou: false,
      channel: 'chat',
    });
    expect(mail.text).toContain(
      'Website visitor wrote to Lone Star in the website chat 16 minutes ago, and nobody has replied yet.',
    );
    expect(mail.text).toContain('9:14 AM · Website visitor');
    expect(mail.html).toContain('in the website chat');
  });
});
