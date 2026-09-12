/**
 * Milestone 3 demo data for Lone Star: a business number from the fake carrier with texting approved,
 * conversations with texts both ways (assigned, snoozed, closed, an unknown number, a STOP), calls (one
 * answered in the browser, one placed from it, a voicemail with its words), and an email thread with a
 * signed attachment plus mail from someone not in Customers yet. Everything goes through the command
 * pipeline; afterwards the replies' times are set back, so each thread reads like a few days of work.
 */
import { randomUUID } from 'node:crypto';
import {
  callAttachRecording,
  callAttachTranscript,
  callRecord,
  callStart,
  callUpdateStatus,
  conversationAssign,
  conversationClose,
  conversationMarkRead,
  conversationSnooze,
  emailReceive,
  executeCommand,
  messageReceive,
  messageSend,
  messageUpdateStatus,
  phoneNumberBuy,
  registrationSubmit,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { processJobs } from '../src/jobs';
import { processOnce, type OutboxDeps } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { systemActor, workerMeta } from '../src/services';

export interface SeedMessagingDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services and loop settings, as the seed built them. */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeedMessagingWorkspace {
  readonly id: string;
  readonly organizationId: string;
  readonly dale: TestUser;
  readonly priya: TestUser;
}

/** The business number (toll-free, so one registration covers it). */
export const LONE_STAR_NUMBER = '+18335550100';

const MINUTE = 60_000;
const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE).toISOString();
const HOUR = 60;
const DAY = 24 * HOUR;

/** Runs the outbox and job loops over the seed's own work until `until` holds (or until idle). */
async function settle(d: SeedMessagingDeps, until?: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    for (const table of ['outbox', 'scheduled_jobs'])
      await rows(
        d.admin,
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${d.worker.workerId}
            where status = 'pending' and created_at >= ${d.since}::timestamptz`,
      );
    const outbox = await processOnce(d.worker);
    const due = await processJobs({ ...d.worker, jobs });
    if (outbox.retried + outbox.failed + due.retried + due.failed > 0)
      throw new Error(
        'Seeding messages failed (see last_error in app.outbox and app.scheduled_jobs).',
      );
    if (until ? await until() : outbox.claimed + due.claimed === 0) return;
    if (Date.now() > deadline) throw new Error('The messaging seed did not settle in 30 seconds.');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A short silent recording, so the voicemail player has something to play. */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34); // 8-bit: 128 is silence
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
}

/** A one-page PDF that says what it is. */
function onePagePdf(line: string): Buffer {
  const text = `BT /F1 16 Tf 72 720 Td (${line.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${text.length}>>stream\n${text}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

export async function seedMessaging(
  d: SeedMessagingDeps,
  ws: SeedMessagingWorkspace,
): Promise<{ conversations: number; calls: number }> {
  const workspaceId = ws.id;
  const sys = systemActor({ workspaceId, organizationId: ws.organizationId });
  const as = (u: TestUser) => d.actor(u);
  const human = <I extends z.ZodType, O extends z.ZodType>(
    u: TestUser,
    command: Parameters<typeof executeCommand<I, O>>[1],
    input: z.input<I>,
  ) => executeCommand(d.api, command, input, as(u), d.meta()).then((r) => r.output);
  const system = <I extends z.ZodType, O extends z.ZodType>(
    command: Parameters<typeof executeCommand<I, O>>[1],
    input: z.input<I>,
  ) => executeCommand(d.worker.db, command, input, sys, workerMeta()).then((r) => r.output);

  d.step('Lone Star gets a business number; the (fake) carriers approve texting');
  const { phoneNumberId } = await human(ws.dale, phoneNumberBuy, {
    workspaceId,
    e164: LONE_STAR_NUMBER,
    numberType: 'toll_free' as const,
  });
  const numberStatus = async () =>
    (
      await rows<{ status: string }>(
        d.admin,
        sql`select status from app.phone_numbers where id = ${phoneNumberId}`,
      )
    )[0]?.status;
  await settle(d, async () => (await numberStatus()) === 'active');
  await human(ws.dale, registrationSubmit, {
    workspaceId,
    kind: 'toll_free_verification' as const,
    business: {
      legalName: 'Lone Star HVAC & Roofing LLC',
      businessType: 'llc' as const,
      ein: '74-1234567',
      website: 'https://lonestarhvac.test',
      address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'TX', postalCode: '77027' },
      contact: {
        firstName: 'Dale',
        lastName: 'Ramsey',
        email: ws.dale.email,
        phone: '(713) 555-0161',
      },
      useCase: 'customer_care' as const,
      messageSamples: [
        'Hi Mike, this is Lone Star HVAC. Marco is on the way and should be there by 10. Reply STOP to opt out.',
      ],
      optInDescription:
        'Customers give us their cell number when they book a visit and agree to texts about it.',
      monthlyVolume: 'under_1000' as const,
    },
  });
  await settle(d, async () => {
    const [r] = await rows<{ status: string }>(
      d.admin,
      sql`select status from app.telephony_registrations where workspace_id = ${workspaceId}`,
    );
    return r?.status === 'approved';
  });

  d.step('Texts, calls and email with customers');
  const people = await rows<{ id: string; email: string | null }>(
    d.admin,
    sql`select id, lower(email) as email from app.people where workspace_id = ${workspaceId}`,
  );
  const person = (email: string) => {
    const p = people.find((x) => x.email === email);
    if (!p) throw new Error(`The CRM seed has no customer ${email}.`);
    return p.id;
  };
  const mike = { id: person('mike.johnson@example.com'), phone: '+17135550142' };
  const sarah = { id: person('salvarez@example.com'), email: 'salvarez@example.com' };
  const linda = { id: person('linda.okafor@example.com'), phone: '+18325550177' };
  const jwhit = { id: person('jwhit@example.com'), phone: '+17135550163' };
  const dkim = { id: person('dkim88@example.com'), phone: '+17135550188' };
  const abrooks = { id: person('abrooks@example.com'), phone: '+18325550134' };
  const unknownNumber = '+12815550123';

  const backdates: { messageId: string; at: string }[] = [];
  const text = async (from: string, body: string, at: string) =>
    system(messageReceive, {
      workspaceId,
      provider: 'fake' as const,
      providerMessageId: `SMseed${randomUUID().replace(/-/g, '')}`,
      from,
      to: LONE_STAR_NUMBER,
      body,
      occurredAt: at,
    });
  const reply = async (
    who: TestUser,
    target: { conversationId: string } | { personId: string },
    body: string,
    at: string,
  ) => {
    const out = await human(who, messageSend, {
      workspaceId,
      ...target,
      channel: 'sms' as const,
      body,
      acknowledgeQuietHours: true,
    });
    backdates.push({ messageId: out.messageId, at });
    return out;
  };
  const read = (conversationId: string) =>
    human(ws.dale, conversationMarkRead, { workspaceId, conversationId });

  // Mike: the AC is out; Priya books Marco; Mike asks again this morning (waiting, assigned to Priya).
  const m1 = await text(
    mike.phone,
    'Hi, this is Mike on Oak Hollow. The AC is blowing warm air again. Can someone come out this week?',
    ago(2 * DAY + 3 * HOUR),
  );
  await reply(
    ws.priya,
    { conversationId: m1.conversationId },
    'Hi Mike, sorry to hear it. Marco can come Thursday between 9 and 11. Does that work?',
    ago(2 * DAY + 2 * HOUR + 40),
  );
  await text(mike.phone, 'Thursday works. Gate code is 4412.', ago(2 * DAY + 2 * HOUR + 25));
  await reply(
    ws.dale,
    { conversationId: m1.conversationId },
    'Great, you’re on the schedule for Thursday, 9 to 11. Marco will text when he’s on the way.',
    ago(2 * DAY + 2 * HOUR + 10),
  );
  await human(ws.dale, conversationAssign, {
    workspaceId,
    conversationId: m1.conversationId,
    assigneeUserId: ws.priya.id,
  });

  // Linda: Priya answers her call in the browser, then confirms by text; closed.
  const lindaCall = `CAseed${randomUUID().replace(/-/g, '')}`;
  const lindaAt = ago(DAY + 5 * HOUR);
  await system(callRecord, {
    workspaceId,
    providerSid: lindaCall,
    direction: 'inbound' as const,
    from: linda.phone,
    to: LONE_STAR_NUMBER,
    status: 'ringing' as const,
    startedAt: lindaAt,
  });
  await system(callUpdateStatus, {
    workspaceId,
    providerSid: lindaCall,
    status: 'in_progress' as const,
    answeredVia: 'browser' as const,
    answeredByUserId: ws.priya.id,
    at: new Date(Date.parse(lindaAt) + 12_000).toISOString(),
  });
  await system(callUpdateStatus, {
    workspaceId,
    providerSid: lindaCall,
    status: 'completed' as const,
    durationSeconds: 252,
    at: new Date(Date.parse(lindaAt) + 264_000).toISOString(),
  });
  const l1 = await reply(
    ws.priya,
    { personId: linda.id },
    'Thanks for the call, Linda. Your roof inspection is booked for Monday at 10.',
    ago(DAY + 4 * HOUR + 50),
  );
  await text(linda.phone, 'Perfect, thank you!', ago(DAY + 4 * HOUR + 30));

  // Sarah: Dale called from the browser yesterday; Priya followed up by email; Sarah's signed reply waits.
  const started = await human(ws.dale, callStart, { workspaceId, personId: sarah.id });
  const sarahCall = `CAseed${randomUUID().replace(/-/g, '')}`;
  const sarahAt = ago(DAY + 7 * HOUR);
  await system(callRecord, {
    workspaceId,
    callId: started.callId,
    providerSid: sarahCall,
    direction: 'outbound' as const,
    from: LONE_STAR_NUMBER,
    to: started.to,
    status: 'ringing' as const,
    startedAt: sarahAt,
  });
  await system(callUpdateStatus, {
    workspaceId,
    providerSid: sarahCall,
    status: 'in_progress' as const,
    // Sarah picked up (the carrier reports the number that answered, as for any outbound call).
    answeredNumber: started.to,
    at: new Date(Date.parse(sarahAt) + 9_000).toISOString(),
  });
  await system(callUpdateStatus, {
    workspaceId,
    providerSid: sarahCall,
    status: 'completed' as const,
    durationSeconds: 95,
    at: new Date(Date.parse(sarahAt) + 104_000).toISOString(),
  });
  // call.start made the row just now; the call happened yesterday.
  await rows(
    d.admin,
    sql`update app.calls set started_at = ${sarahAt}::timestamptz, created_at = ${sarahAt}::timestamptz,
          answered_at = ${sarahAt}::timestamptz + interval '9 seconds',
          ended_at = ${sarahAt}::timestamptz + interval '104 seconds'
        where id = ${started.callId}`,
  );
  await rows(
    d.admin,
    sql`update app.activities a set occurred_at = ${sarahAt}::timestamptz
        from app.calls c where c.id = ${started.callId} and a.id = c.activity_id`,
  );
  const renewal = await human(ws.priya, messageSend, {
    workspaceId,
    personId: sarah.id,
    channel: 'email' as const,
    subject: 'Maintenance plan renewal',
    body: 'Hi Sarah,\n\nYour maintenance plan renews on October 1. Two tune-ups a year, spring and fall, at the same $189.\n\nWant us to book your fall visit?\n\nPriya\nLone Star HVAC & Roofing',
  });
  backdates.push({ messageId: renewal.messageId, at: ago(DAY + 6 * HOUR) });

  // Mike again: a missed call this morning with a voicemail, then his text (waiting).
  const vmCall = `CAseed${randomUUID().replace(/-/g, '')}`;
  const vmAt = ago(3 * HOUR);
  const voicemail = await system(callRecord, {
    workspaceId,
    providerSid: vmCall,
    direction: 'inbound' as const,
    from: mike.phone,
    to: LONE_STAR_NUMBER,
    status: 'ringing' as const,
    startedAt: vmAt,
  });
  await system(callUpdateStatus, {
    workspaceId,
    providerSid: vmCall,
    status: 'completed' as const,
    durationSeconds: 41,
    at: new Date(Date.parse(vmAt) + 41_000).toISOString(),
  });
  const vmPath = `${workspaceId}/calls/${voicemail.callId}/voicemail.wav`;
  await d.worker.store.upload('telephony', vmPath, silentWav(18), 'audio/wav', { upsert: true });
  await system(callAttachRecording, {
    workspaceId,
    providerSid: vmCall,
    recordingSid: `REseed${randomUUID().replace(/-/g, '')}`,
    objectPath: vmPath,
    seconds: 18,
    voicemail: true,
  });
  await system(callAttachTranscript, {
    workspaceId,
    providerSid: vmCall,
    transcript:
      'Hi, this is Mike Johnson on Oak Hollow. The AC is out again and it’s getting hot in here. Can somebody call me back at 713-555-0142? Thanks.',
    status: 'completed' as const,
  });
  await text(mike.phone, 'Is Marco still coming? It’s 84 in the house.', ago(40));

  // J: a spring tune-up offer, answered with STOP (texting is off for him now).
  const j1 = await reply(
    ws.dale,
    { personId: jwhit.id },
    'Hi, this is Lone Star HVAC. Your spring tune-up is due. Want us to book it?',
    ago(3 * DAY + 5 * HOUR),
  );
  await text(jwhit.phone, 'STOP', ago(3 * DAY + 3 * HOUR));

  // A new question from someone who isn't a customer yet.
  await text(unknownNumber, 'Do you do duct cleaning? How much for a 2,000 sq ft house?', ago(25));

  // D. Kim: a water heater quote, snoozed until tomorrow morning.
  const k1 = await text(
    dkim.phone,
    'Can you quote a new water heater? 50 gallon, gas.',
    ago(5 * HOUR),
  );
  await human(ws.dale, conversationSnooze, {
    workspaceId,
    conversationId: k1.conversationId,
    until: new Date(Date.now() + 20 * HOUR * MINUTE).toISOString(),
  });

  // A. Brooks: thanks for the thermostat; answered and closed.
  const a1 = await text(abrooks.phone, 'Thanks for fixing the thermostat so fast!', ago(4 * DAY));
  await reply(
    ws.priya,
    { conversationId: a1.conversationId },
    'Anytime! Call us if it acts up again.',
    ago(4 * DAY - 15),
  );

  // The worker sends everything queued; the fake carrier and Mailpit report nothing back, so mark them.
  await settle(d);
  for (const { messageId } of backdates)
    await system(messageUpdateStatus, { workspaceId, messageId, status: 'delivered' as const });

  // Replies went out just now: set their times back so each thread reads in order. Email only moves a
  // thread's preview for its newest message, so this runs before Sarah's reply comes in, and again at the end.
  const fixTimes = async () => {
    for (const { messageId, at } of backdates) {
      await rows(
        d.admin,
        sql`update app.messages set occurred_at = ${at}::timestamptz, created_at = ${at}::timestamptz,
              sent_at = ${at}::timestamptz,
              delivered_at = case when delivered_at is null then null else ${at}::timestamptz + interval '4 seconds' end
            where id = ${messageId}`,
      );
      await rows(
        d.admin,
        sql`update app.activities a set occurred_at = ${at}::timestamptz
            from app.messages m where m.id = ${messageId} and a.id = m.activity_id`,
      );
    }
    await rows(
      d.admin,
      sql`update app.conversations c
          set last_message_at = t.last_at, last_inbound_at = t.last_in, last_outbound_at = t.last_out
          from (
            select conversation_id,
              max(at) as last_at,
              max(at) filter (where direction = 'inbound') as last_in,
              max(at) filter (where direction = 'outbound') as last_out
            from (
              select conversation_id, occurred_at as at, direction::text as direction from app.messages
                where workspace_id = ${workspaceId}
              union all
              select conversation_id, started_at, direction::text from app.calls
                where workspace_id = ${workspaceId} and conversation_id is not null and started_at is not null
            ) x
            group by conversation_id
          ) t
          where c.id = t.conversation_id`,
    );
  };
  await fixTimes();

  // Sarah's reply by email, with the signed renewal attached.
  const [conv] = await rows<{ token: string; id: string }>(
    d.admin,
    sql`select email_reply_token as token, id from app.conversations
        where workspace_id = ${workspaceId} and channel = 'email' and counterpart = ${sarah.email}`,
  );
  const [shared] = await rows<{ id: string; address: string }>(
    d.admin,
    sql`select id, address from app.email_addresses where workspace_id = ${workspaceId} and is_default`,
  );
  const pdfPath = `${workspaceId}/email/seed-${randomUUID().slice(0, 8)}/renewal-signed.pdf`;
  const pdf = onePagePdf('Lone Star HVAC maintenance plan renewal - signed');
  await d.worker.store.upload('telephony', pdfPath, pdf, 'application/pdf', { upsert: true });
  await system(emailReceive, {
    workspaceId,
    provider: 'postmark' as const,
    providerMessageId: `seed-${randomUUID()}`,
    messageIdHeader: `<${randomUUID()}@example.com>`,
    from: { address: sarah.email, name: 'Sarah Alvarez' },
    to: [{ address: shared!.address, name: 'Lone Star HVAC & Roofing' }],
    subject: 'Re: Maintenance plan renewal',
    bodyText:
      'Sounds good. Can we do the 18th in the morning? Anytime before 11 works. The signed renewal is attached.\n\nSarah',
    media: [
      {
        bucket: 'telephony',
        objectPath: pdfPath,
        contentType: 'application/pdf',
        sizeBytes: pdf.length,
        name: 'renewal-signed.pdf',
      },
    ],
    replyToken: conv?.token ?? null,
    emailAddressId: shared!.id,
    occurredAt: ago(2 * HOUR),
  });
  if (conv)
    await human(ws.dale, conversationAssign, {
      workspaceId,
      conversationId: conv.id,
      assigneeUserId: ws.priya.id,
    });

  // Someone who isn't a customer writes to the workspace address: it waits in Settings → Email.
  await system(emailReceive, {
    workspaceId,
    provider: 'postmark' as const,
    providerMessageId: `seed-${randomUUID()}`,
    messageIdHeader: `<${randomUUID()}@example.net>`,
    from: { address: 'kliu@example.net', name: 'Karen Liu' },
    to: [{ address: shared!.address, name: 'Lone Star HVAC & Roofing' }],
    subject: 'Quote for an AC tune-up?',
    bodyText: 'Hi, do you do AC tune-ups in Katy? What does one cost for a 3-ton unit?\n\nKaren',
    emailAddressId: shared!.id,
    occurredAt: ago(2 * HOUR + 20),
  });

  await fixTimes();

  // Threads the team already handled are read; closed ones close.
  for (const id of [l1.conversationId, j1.conversationId, a1.conversationId]) await read(id);
  await human(ws.priya, conversationClose, { workspaceId, conversationId: l1.conversationId });
  await human(ws.priya, conversationClose, { workspaceId, conversationId: a1.conversationId });
  await settle(d);

  const [count] = await rows<{ conversations: number; calls: number }>(
    d.admin,
    sql`select (select count(*)::int from app.conversations where workspace_id = ${workspaceId}) as conversations,
               (select count(*)::int from app.calls where workspace_id = ${workspaceId}) as calls`,
  );
  return count ?? { conversations: 0, calls: 0 };
}
