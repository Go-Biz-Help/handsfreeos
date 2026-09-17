/**
 * M10 on the local database: the Action Center's cards quote what the customer said last, never the business's own
 * words that came after it in the conversation (an automatic receipt, a workflow's text). The urgent email and the
 * push read the same words through the same loader (the worker's attention-customer-said.test.ts).
 * - **The words:** a text's, an email's subject and first line, "Sent a photo." for photos alone, and a call of theirs
 *   nobody answered when it came after their last message.
 * - **A customer waiting** after an automatic receipt, and **a hot lead** after a workflow's text, quote the customer.
 * - **A new lead** doesn't quote words from before it came in.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { attentionItems, conversations } from '@hfos/db/schema';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { customerMessageLine } from '../src/attention/index';
import { loadCustomerSaid, reconcile, type AttentionSubjectRef } from '../src/attention/load';
import { executeCommand } from '../src/kernel/execute';
import type { CommandDef, WorkflowActor } from '../src/kernel/types';
import {
  callAttachRecording,
  callAttachTranscript,
  callRecord,
  callUpdateStatus,
  leadCreate,
  messageReceive,
  messageSend,
  personCreate,
  phoneUpdateSettings,
} from '../src/server';
import { admin, meta, MIN, run, runSystem, setupTeam, type Team } from './calendar-helpers';

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const uniq = () => randomUUID().slice(0, 8);

let t: Team;
/** The business number customers text and call. */
let number: string;

beforeAll(async () => {
  t = await setupTeam('said');
  // Texting ready: an approved toll-free number, and no quiet hours.
  number = `+1888556${String(1000 + Math.floor(Math.random() * 9000))}`;
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${t.wsId}, 'fake', ${`ACcs${uniq()}`}, 'active') returning id`,
  );
  const [line] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${t.wsId}, ${account!.id}, ${`PNcs${uniq()}`}, ${number}, 'toll_free', 'active') returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${t.wsId}, ${account!.id}, ${line!.id}, 'toll_free_verification', 'approved', ${`HHcs${uniq()}`}, now())`,
  );
  await run(
    phoneUpdateSettings,
    { workspaceId: t.wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    t.owner,
  );
});
afterAll(closeTestDbs);

let phones = 0;
const nextPhone = () => `+1512555${String(3000 + phones++).padStart(4, '0')}`;

/** A customer HandsFreeOS filed (a text, a web form), with a mobile number. */
async function customer(firstName: string) {
  const phone = nextPhone();
  const { personId } = await runSystem(
    personCreate,
    { workspaceId: t.wsId, firstName, lastName: 'Test', phone, ignoreDuplicates: true },
    t.scope,
  );
  return { personId, phone };
}

/** Their text to the business number, written `ago` milliseconds before now. */
const textIn = (from: string, body: string, opts: { ago?: number; photos?: number } = {}) =>
  runSystem(
    messageReceive,
    {
      workspaceId: t.wsId,
      provider: 'fake',
      providerMessageId: `SMcs${randomUUID()}`,
      from,
      to: number,
      body,
      media: Array.from({ length: opts.photos ?? 0 }, (_, i) => ({
        bucket: 'telephony',
        objectPath: `${t.wsId}/messages/${uniq()}/${i}.jpg`,
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        name: `photo-${i + 1}.jpg`,
      })),
      reminderAfterMs: DAY,
      ...(opts.ago ? { occurredAt: new Date(Date.now() - opts.ago).toISOString() } : {}),
    },
    t.scope,
  );

/** HandsFreeOS's own text in the conversation (a receipt, a confirmation): the customer still waits. */
const automaticText = (conversationId: string, body: string) =>
  runSystem(
    messageSend,
    { workspaceId: t.wsId, conversationId, body, keepConversationStatus: true },
    t.scope,
  );

const workflow = (): WorkflowActor => ({
  type: 'workflow',
  workspaceId: t.wsId,
  organizationId: t.orgId,
  workflowId: randomUUID(),
  versionId: null,
  runId: randomUUID(),
  stepKey: 'text_1#1',
  depth: 0,
  originRunId: null,
  workflowName: 'Speed to lead',
  test: false,
});
const asWorkflow = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
) =>
  executeCommand(testDbs().worker.db, cmd, input, workflow(), meta('workflow')).then(
    (r) => r.output,
  );

const saidIn = (ids: readonly string[]) =>
  asWorker(testDbs().worker.db, t.scope, (tx) => loadCustomerSaid(tx, ids));
const settle = (subjects: readonly AttentionSubjectRef[], at: Date = new Date()) =>
  asWorker(testDbs().worker.db, t.scope, (tx) => reconcile(tx, t.wsId, subjects, at));
const itemOn = async (subjectId: string, kind: string) =>
  (
    await admin()
      .select()
      .from(attentionItems)
      .where(and(eq(attentionItems.subjectId, subjectId), eq(attentionItems.kind, kind)))
  )[0];
const conversationRow = async (id: string) =>
  (await admin().select().from(conversations).where(eq(conversations.id, id)))[0]!;

describe('what a customer said last', () => {
  it('reads a text, an email’s subject and first line, and photos alone, in one line', () => {
    expect(
      customerMessageLine({ channel: 'sms', body: '  Can you come out\ntoday?  ', photos: 0 }),
    ).toBe('Can you come out today?');
    // Words and a photo: the words.
    expect(customerMessageLine({ channel: 'sms', body: 'This one', photos: 1 })).toBe('This one');
    expect(customerMessageLine({ channel: 'sms', body: '', photos: 1 })).toBe('Sent a photo.');
    expect(customerMessageLine({ channel: 'sms', body: null, photos: 3 })).toBe('Sent 3 photos.');
    expect(
      customerMessageLine({
        channel: 'email',
        subject: 'Furnace noise',
        body: '\nHi,\nIt started rattling last night.',
        photos: 0,
      }),
    ).toBe('Furnace noise · Hi,');
    expect(customerMessageLine({ channel: 'chat', body: '   ', photos: 0 })).toBe('');
    // Long words keep to the inbox's one line.
    const line = customerMessageLine({ channel: 'sms', body: 'word '.repeat(60), photos: 0 });
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith('…')).toBe(true);
  });

  it('is their newest message, never the business’s words after it, or a call of theirs nobody answered after it', async () => {
    const linda = await customer('Linda');
    const { conversationId } = await textIn(
      linda.phone,
      'Did my payment go through? I paid the invoice this morning.',
    );
    await automaticText(
      conversationId,
      'Lone Star HVAC: Thanks, Linda. We got your $3,418.84 payment for invoice INV-1001.',
    );
    // The conversation's last message is the receipt, and she is still waiting.
    expect(await conversationRow(conversationId)).toMatchObject({
      lastPreview:
        'Lone Star HVAC: Thanks, Linda. We got your $3,418.84 payment for invoice INV-1001.',
      lastDirection: 'outbound',
      awaitingReplySince: expect.any(Date),
    });
    expect((await saidIn([conversationId])).get(conversationId)).toMatchObject({
      words: 'Did my payment go through? I paid the invoice this morning.',
      photos: 0,
    });

    // She calls and nobody picks up, then leaves a voicemail.
    const callSid = `CAcs${uniq()}`;
    await runSystem(
      callRecord,
      {
        workspaceId: t.wsId,
        providerSid: callSid,
        direction: 'inbound',
        from: linda.phone,
        to: number,
      },
      t.scope,
    );
    await runSystem(
      callUpdateStatus,
      { workspaceId: t.wsId, providerSid: callSid, status: 'completed', durationSeconds: 30 },
      t.scope,
    );
    expect((await saidIn([conversationId])).get(conversationId)?.words).toBe('Missed call');
    await runSystem(
      callAttachRecording,
      {
        workspaceId: t.wsId,
        providerSid: callSid,
        recordingSid: `RE${uniq()}`,
        objectPath: `${t.wsId}/calls/${uniq()}/voicemail.mp3`,
        seconds: 12,
      },
      t.scope,
    );
    await runSystem(
      callAttachTranscript,
      {
        workspaceId: t.wsId,
        providerSid: callSid,
        transcript: 'Hi, it’s Linda about the payment.',
        status: 'completed',
      },
      t.scope,
    );
    expect((await saidIn([conversationId])).get(conversationId)?.words).toBe(
      'Voicemail, 0:12: “Hi, it’s Linda about the payment.”',
    );

    // Then a photo with no words: that's what she said last.
    await textIn(linda.phone, '', { photos: 1 });
    expect((await saidIn([conversationId])).get(conversationId)).toMatchObject({
      words: 'Sent a photo.',
      photos: 1,
    });

    // A conversation only the business wrote in has nothing of theirs to quote.
    const quiet = await customer('Quinn');
    const sent = await runSystem(
      messageSend,
      {
        workspaceId: t.wsId,
        personId: quiet.personId,
        body: 'Your visit is confirmed for Friday.',
        keepConversationStatus: true,
      },
      t.scope,
    );
    expect((await saidIn([sent.conversationId])).has(sent.conversationId)).toBe(false);
  });

  it('a customer waiting card quotes them, not the automatic receipt sent after their message', async () => {
    const nia = await customer('Nia');
    const { conversationId } = await textIn(nia.phone, 'Is my receipt coming by email too?');
    await automaticText(
      conversationId,
      'Lone Star HVAC: Thanks, Nia. We got your $180 payment for invoice INV-1002.',
    );
    // Past the reply threshold.
    await settle([{ type: 'conversation', id: conversationId }], new Date(Date.now() + HOUR));
    expect(await itemOn(conversationId, 'customer_waiting')).toMatchObject({
      state: 'open',
      detail: 'Is my receipt coming by email too?',
    });
  });

  it('a hot lead card quotes them, not a workflow’s text after it, and says so when they send a photo alone', async () => {
    const nora = await customer('Nora');
    const { leadId } = await runSystem(
      leadCreate,
      { workspaceId: t.wsId, title: 'No cooling', personId: nora.personId },
      t.scope,
    );
    const { conversationId } = await textIn(
      nora.phone,
      'Can you come out today? I want to get this booked ASAP.',
    );
    await asWorkflow(messageSend, {
      workspaceId: t.wsId,
      conversationId,
      body: 'Thanks Nora! Someone from our team will call you shortly.',
      keepConversationStatus: true,
    });
    const person = [{ type: 'person' as const, id: nora.personId }];
    await settle(person);
    const card = await itemOn(leadId, 'hot_lead');
    expect(card).toMatchObject({
      state: 'open',
      conversationId,
      detail: 'Can you come out today? I want to get this booked ASAP.',
    });
    expect((await conversationRow(conversationId)).lastPreview).toBe(
      'Thanks Nora! Someone from our team will call you shortly.',
    );

    await textIn(nora.phone, '', { photos: 2 });
    await settle(person);
    expect((await itemOn(leadId, 'hot_lead'))!.detail).toBe('Sent 2 photos.');
  });

  it('a new lead doesn’t quote words from before it came in', async () => {
    const olga = await customer('Olga');
    // Ten days ago she wrote, and HandsFreeOS answered: nothing waits.
    const { conversationId } = await textIn(olga.phone, 'Thanks, the heater works great now.', {
      ago: 10 * DAY,
    });
    await runSystem(
      messageSend,
      { workspaceId: t.wsId, conversationId, body: 'Glad to hear it, Olga!' },
      t.scope,
    );
    // Today a new lead for her comes in on its own, worth $8,000: hot (a big lead that came in today).
    const { leadId } = await runSystem(
      leadCreate,
      { workspaceId: t.wsId, title: 'New furnace', personId: olga.personId, valueCents: 800_000 },
      t.scope,
    );
    await settle([{ type: 'person', id: olga.personId }]);
    expect(await itemOn(leadId, 'hot_lead')).toMatchObject({
      state: 'open',
      conversationId,
      detail: null,
    });
    // Her words are still what she said last in the conversation: only too old for this lead.
    expect((await saidIn([conversationId])).get(conversationId)?.words).toBe(
      'Thanks, the heater works great now.',
    );
  });
});
