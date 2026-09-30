/**
 * M10 step 6a on the real database, with the stand-in sender: push notifications.
 * - **What a push carries:** an iPhone gets an alert with its category; Android gets data only, at high priority,
 *   with the words inside for the app to draw. One notification id and one command id per button, the same on
 *   every phone. Nothing secret, and never too big for Expo.
 * - **Each moment reaches the right phones:** an urgent lead and a customer waiting (the urgent email's people),
 *   approvals (the AI teammate's drafts and a workflow's step), your appointments, things assigned to you, and a
 *   customer paying (off until turned on). Whoever did it hears nothing.
 * - **Switches:** a switch off means no push while the email still goes, and the email off doesn't stop the push.
 * - **Once:** a retried alert, an event whose other handler failed, a request Expo refused, a connection lost
 *   mid-send and a try that stopped partway never push a phone twice.
 * - **Receipts:** a phone the app is gone from is turned off, from its ticket at once or its receipt later, unless
 *   it registered again since.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appointmentCancel,
  appointmentCreate,
  appointmentReschedule,
  attentionAssign,
  commandButtonsOf,
  conversationAssign,
  conversationTakeOver,
  emailReceive,
  executeCommand,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  leadUpdate,
  messageReceive,
  messageSend,
  PUSH_BUTTONS,
  PushData,
  pushDeviceRegister,
  taskCreate,
  userUpdateProfile,
  money,
  whenLabel,
  workflowEnrol,
  type CommandDef,
  type HumanActor,
  type PushCategory,
  type WorkflowDefinitionInput,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { pushDevices } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEnv } from '../src/env';
import { handlers } from '../src/handlers/index';
import { handlersFor, type EventHandler, type HandlerMap } from '../src/handlers/types';
import { processJobs, type JobStats } from '../src/jobs';
import { processOnce } from '../src/outbox';
import {
  createFakePush,
  messageFor,
  noticeData,
  PUSH_JOBS,
  pushJobKey,
  queuePush,
  type FakePushSent,
  type PushMessage,
  type PushNotice,
} from '../src/push/index';
import { aiCanTake } from '../src/push/urgent';
import { jobs } from '../src/scheduled';
import { systemActor } from '../src/services';
import { newCustomer, replyNow, teammateWorld, textIn, type TeammateWorld } from './ai-team-world';
import {
  attentionWorld,
  filedCustomer,
  inboundLead,
  itemOf,
  runSweep,
  setReplyThreshold,
  type AttentionWorld,
} from './attention-world';
import {
  admin,
  api,
  at,
  CHI,
  drain,
  get,
  iso,
  mailTo,
  makeCalendar,
  post,
  run,
  waitForMail,
  type World,
} from './booking-world';
import { addWorkflow, sid } from './workflow-world';

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const as = <T = unknown>(u: TestUser, cmd: CommandDef, input: unknown): Promise<T> =>
  executeCommand(api(), cmd, input, actorOf(u), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output as T);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Phone {
  readonly deviceId: string;
  readonly token: string;
}

/** A phone the person signed in on, registered as the app does. */
async function phoneOf(
  u: TestUser,
  platform: 'ios' | 'android',
  label: string = platform,
): Promise<Phone> {
  const token = `ExponentPushToken[${label}-${randomUUID().slice(0, 12)}]`;
  const out = await as<{ deviceId: string }>(u, pushDeviceRegister, {
    platform,
    token,
    appVersion: '1.0.0',
    deviceName: label,
  });
  return { deviceId: out.deviceId, token };
}

const deviceRow = async (id: string) =>
  (await admin().select().from(pushDevices).where(eq(pushDevices.id, id)))[0]!;

/** The push data, read as the app will. */
const dataOf = (m: PushMessage) => PushData.parse(m.data);
const tokensOf = (list: readonly FakePushSent[]) => list.map((s) => s.message.to).sort();

/** The world's due jobs, once, retries allowed (drain refuses them). */
async function jobsOnce(w: World): Promise<JobStats> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${w.workerId}
        where status = 'pending' and workspace_id = ${w.workspaceId} and run_at <= now()`,
  );
  return processJobs({ ...w.s, jobs, workerId: w.workerId, batchSize: 50, reservedOnly: true });
}

async function pushJob(momentKey: string) {
  const [j] = await rows<{
    id: string;
    status: string;
    attempts: number;
    payload: Record<string, unknown>;
  }>(
    admin(),
    sql`select id, status::text as status, attempts, payload from app.scheduled_jobs
        where kind = ${PUSH_JOBS.send} and dedupe_key = ${pushJobKey(momentKey)}
        order by created_at desc limit 1`,
  );
  return j;
}

// ---------- what a push carries (no database) ----------

describe('what a push carries', () => {
  const WS = randomUUID();
  const CONV = randomUUID();
  const notice = (category: PushCategory, over: Partial<PushNotice> = {}): PushNotice => ({
    notificationId: randomUUID(),
    category,
    workspaceId: WS,
    business: 'Lone Star HVAC & Roofing',
    title: 'Mike Johnson',
    subtitle: 'Text · Lone Star HVAC & Roofing',
    body: 'Is Marco still coming? It’s 84 in the house.',
    path: `/app/w/${WS}/inbox/${CONV}`,
    refs: { conversationId: CONV, channel: 'sms' },
    commandIds: Object.fromEntries(commandButtonsOf(category).map((b) => [b, randomUUID()])),
    sentAt: new Date().toISOString(),
    ...over,
  });

  it('gives an iPhone an alert with its category, and Android data it draws itself', () => {
    const n = notice('customer_message');
    const ios = messageFor({ platform: 'ios', token: 'ExponentPushToken[ios]' }, n);
    expect(ios).toMatchObject({
      to: 'ExponentPushToken[ios]',
      title: 'Mike Johnson',
      subtitle: 'Text · Lone Star HVAC & Roofing',
      body: n.body,
      categoryId: 'customer_message',
      sound: 'default',
      priority: 'high',
      // A new message arrives the ordinary way; the urgent kinds may break through Focus.
      interruptionLevel: 'active',
      ttl: 12 * 3_600,
    });
    expect(dataOf(ios)).toEqual(noticeData(n));
    expect(ios.data).not.toHaveProperty('title');
    expect(messageFor({ platform: 'ios', token: 't' }, notice('customer_waiting'))).toMatchObject({
      interruptionLevel: 'time-sensitive',
      sound: 'default',
    });

    const android = messageFor({ platform: 'android', token: 'ExponentPushToken[android]' }, n);
    // Nothing the system would draw by itself: data only, at high priority.
    expect(Object.keys(android).sort()).toEqual(['data', 'priority', 'to', 'ttl']);
    expect(android.priority).toBe('high');
    expect(dataOf(android)).toEqual({
      ...noticeData(n),
      title: n.title,
      subtitle: n.subtitle,
      body: n.body,
    });

    // A booking isn't urgent: it arrives the ordinary way, and is kept a day for a phone that's off.
    expect(messageFor({ platform: 'ios', token: 't' }, notice('booking'))).toMatchObject({
      categoryId: 'booking',
      interruptionLevel: 'active',
      ttl: 24 * 3_600,
    });
  });

  it('replaces a conversation’s notification, quietly for the next message of a burst', () => {
    const collapseId = `conversation-${CONV}`;
    const first = notice('customer_message', { collapseId });
    const ios = messageFor({ platform: 'ios', token: 't' }, first);
    expect(ios).toMatchObject({
      collapseId,
      threadId: collapseId,
      sound: 'default',
      interruptionLevel: 'active',
    });
    expect(dataOf(ios)).toMatchObject({ collapseId });
    expect(ios.data).not.toHaveProperty('quiet');

    const next = notice('customer_message', { collapseId, quiet: true, body: 'Actually, 3 PM?' });
    const quietIos = messageFor({ platform: 'ios', token: 't' }, next);
    // No sound, nothing lighting up: it goes in passively over the one already showing.
    expect(quietIos).toMatchObject({
      collapseId,
      interruptionLevel: 'passive',
      body: 'Actually, 3 PM?',
    });
    expect(quietIos).not.toHaveProperty('sound');
    const quietAndroid = messageFor({ platform: 'android', token: 't' }, next);
    expect(dataOf(quietAndroid)).toMatchObject({
      collapseId,
      quiet: true,
      body: 'Actually, 3 PM?',
    });
    expect(Object.keys(quietAndroid).sort()).toEqual(['data', 'priority', 'to', 'ttl']);
  });

  it('carries a command id for exactly the buttons that run one, and names the ones that need unlocking', () => {
    expect(commandButtonsOf('customer_message')).toEqual(['reply', 'let_ai_handle']);
    expect(commandButtonsOf('customer_message_no_ai')).toEqual(['reply']);
    expect(commandButtonsOf('customer_waiting')).toEqual(['reply', 'let_ai_handle']);
    expect(commandButtonsOf('customer_waiting_no_ai')).toEqual(['reply']);
    expect(commandButtonsOf('urgent_lead')).toEqual(['let_handle', 'snooze']);
    expect(commandButtonsOf('urgent_lead_no_ai')).toEqual(['snooze']);
    expect(commandButtonsOf('approval')).toEqual(['approve']);
    expect(commandButtonsOf('job_check')).toEqual(['done', 'no_show', 'still_there']);
    for (const c of ['booking', 'assigned', 'payment'] as const)
      expect(commandButtonsOf(c)).toEqual([]);
    const unlock = Object.entries(PUSH_BUTTONS)
      .filter(([, b]) => b.unlock)
      .map(([id]) => id)
      .sort();
    // Marking a visit changes the records; "Still there" only asks again later.
    expect(unlock).toEqual(['approve', 'done', 'let_ai_handle', 'let_handle', 'no_show', 'reply']);
    expect(PUSH_BUTTONS.call.opensApp && PUSH_BUTTONS.review.opensApp).toBe(true);
  });

  it('stays well inside Expo’s 4 KB with the longest words a push is given', () => {
    const long = (n: number) => '€'.repeat(n);
    const n = notice('urgent_lead', {
      title: long(64),
      subtitle: long(64),
      body: long(180),
      business: long(120),
      commandIds: { let_handle: randomUUID(), snooze: randomUUID() },
      refs: {
        itemId: randomUUID(),
        leadId: randomUUID(),
        personId: randomUUID(),
        conversationId: CONV,
        channel: 'email',
      },
    });
    for (const platform of ['ios', 'android'] as const) {
      const m = messageFor({ platform, token: `ExponentPushToken[${'x'.repeat(40)}]` }, n);
      expect(Buffer.byteLength(JSON.stringify(m)), platform).toBeLessThan(3_000);
    }
  });

  it('keys a moment’s job inside the 200 characters a dedupe key holds', () => {
    expect(pushJobKey('booking:abc')).toBe('push:booking:abc');
    const long = `urgent:item:${'x'.repeat(300)}`;
    expect(pushJobKey(long).length).toBeLessThanOrEqual(200);
    expect(pushJobKey(long)).toBe(pushJobKey(long));
    expect(pushJobKey(long)).not.toBe(pushJobKey(`${long}y`));
  });

  it('stands in for Expo: gone and dead phones, refused and lost requests', async () => {
    const fake = createFakePush();
    const msg = (token: string) => messageFor({ platform: 'android', token }, notice('assigned'));
    const tickets = await fake.send([
      msg('ExponentPushToken[fine]'),
      msg('ExponentPushToken[Dead-1]'),
      msg('ExponentPushToken[Gone-1]'),
    ]);
    expect(tickets.map((t) => t.status)).toEqual(['ok', 'error', 'ok']);
    expect(tickets[1]).toMatchObject({ error: 'DeviceNotRegistered' });
    const ids = tickets.flatMap((t) => (t.status === 'ok' ? [t.id] : []));
    const receipts = await fake.receipts([...ids, 'unknown']);
    expect(receipts[ids[0]!]).toEqual({ status: 'ok' });
    expect(receipts[ids[1]!]).toMatchObject({ status: 'error', error: 'DeviceNotRegistered' });
    expect(receipts).not.toHaveProperty('unknown');

    fake.failNext('refused');
    await expect(fake.send([msg('ExponentPushToken[fine]')])).rejects.toMatchObject({
      refused: true,
    });
    expect(fake.sent).toHaveLength(3);
    fake.failNext('lost');
    await expect(fake.send([msg('ExponentPushToken[fine]')])).rejects.toMatchObject({
      refused: false,
    });
    expect(fake.sent).toHaveLength(4);
  });
});

describe('the worker’s push settings', () => {
  const key = randomBytes(32).toString('base64');
  const base = {
    DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db',
    SMTP_URL: 'smtp://h',
    WORKER_ENCRYPTION_KEY: key,
  };
  const production = {
    ...base,
    NODE_ENV: 'production',
    TWILIO_ACCOUNT_SID: 'ACx',
    TWILIO_AUTH_TOKEN: 'y',
    WORKER_PUBLIC_URL: 'https://hooks.example.com',
    POSTMARK_SERVER_TOKEN: 'p',
    POSTMARK_ACCOUNT_TOKEN: 'a',
    POSTMARK_WEBHOOK_PASSWORD: 'w'.repeat(32),
    CHAT_IP_KEY: 'c'.repeat(40),
    TURNSTILE_SECRET_KEY: 't',
  };

  it('uses the stand-in locally, Expo with its access token in production, and never the stand-in there', () => {
    expect(readEnv(base)).toMatchObject({ pushProvider: 'fake', expoAccessToken: null });
    // No token yet: the worker starts with push off rather than refusing to start.
    expect(readEnv(production)).toMatchObject({ pushProvider: 'none', expoAccessToken: null });
    expect(readEnv({ ...production, EXPO_ACCESS_TOKEN: ' tok ' })).toMatchObject({
      pushProvider: 'expo',
      expoAccessToken: 'tok',
    });
    expect(() => readEnv({ ...production, PUSH_PROVIDER: 'fake' })).toThrow(
      /development and tests/,
    );
    expect(() => readEnv({ ...base, PUSH_PROVIDER: 'expo' })).toThrow(/EXPO_ACCESS_TOKEN/);
    expect(() => readEnv({ ...base, PUSH_PROVIDER: 'apns' })).toThrow(/PUSH_PROVIDER/);
    expect(readEnv({ ...base, PUSH_PROVIDER: 'none' }).pushProvider).toBe('none');
    // The SDK would send the token wherever EXPO_BASE_URL points.
    expect(() =>
      readEnv({ ...production, EXPO_ACCESS_TOKEN: 'tok', EXPO_BASE_URL: 'https://example.com' }),
    ).toThrow(/EXPO_BASE_URL/);
  });
});

// ---------- a business: Dale (owner), Priya (admin), Marco (member) ----------

describe('the moments, on a business with phones', () => {
  let w: AttentionWorld;
  let priya: TestUser;
  let business: string;
  const phones = {} as Record<'daleIphone' | 'daleAndroid' | 'priyaIphone' | 'marcoIphone', Phone>;
  const sent = () => w.s.push.fake.sent;
  const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });

  beforeAll(async () => {
    w = await attentionWorld('pushes');
    // A customer's message counts as waiting at once; a hot lead's own 10 minutes decide when it's urgent.
    await setReplyThreshold(w, 10);
    priya = await createTestUser('pushes-priya', { fullName: 'Priya Admin' });
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${w.workspaceId}, ${priya.id}, 'admin')`,
    );
    const [ws] = await rows<{ name: string }>(
      admin(),
      sql`select name from app.workspaces where id = ${w.workspaceId}`,
    );
    business = ws!.name;
    phones.daleIphone = await phoneOf(w.owner, 'ios', 'dale-iphone');
    phones.daleAndroid = await phoneOf(w.owner, 'android', 'dale-android');
    phones.priyaIphone = await phoneOf(priya, 'ios', 'priya-iphone');
    phones.marcoIphone = await phoneOf(w.member, 'ios', 'marco-iphone');
  });
  afterAll(async () => {
    await w?.app.close();
  });

  /** A lead whose customer texted ready-to-book words `minutes` ago: urgent once its 10 minutes are up. */
  async function hotLead(name: string, minutes = 11) {
    const c = await filedCustomer(w, name);
    const leadId = await inboundLead(w, c.id, `${name}: no cooling`);
    await drain(w);
    await textIn(w, c.phone, 'Can you come out today? I want to get this booked ASAP.');
    await rows(
      admin(),
      sql`update app.conversations
          set awaiting_reply_since = awaiting_reply_since - ${`${minutes} minutes`}::interval
          where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
    );
    return { leadId, personId: c.id, phone: c.phone };
  }

  /** Everything the Action Center has waiting, run now, then what it queued (the pushes among it). */
  async function runJobs(): Promise<void> {
    const res = await post(w, '/test/attention/run-jobs', { workspaceId: w.workspaceId });
    expect(res.statusCode, res.body).toBe(200);
    await drain(w);
  }

  async function settingsOf(u: TestUser, settings: Record<string, unknown>) {
    await as(u, userUpdateProfile, { settings });
  }

  /** A customer's text as the carrier's webhook files it, written `secondsAgo` before it arrived. Nothing runs yet. */
  async function textArrives(from: string, body: string, secondsAgo = 0) {
    const { output } = await executeCommand(
      testDbs().worker.db,
      messageReceive,
      {
        workspaceId: w.workspaceId,
        provider: 'fake',
        providerMessageId: `SM${randomUUID()}`,
        from,
        to: w.number!,
        body,
        occurredAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
        reminderAfterMs: 86_400_000,
      },
      systemActor(scope()),
      { correlationId: randomUUID(), channel: 'worker' },
    );
    return { conversationId: output.conversationId, messageId: output.messageId };
  }

  /** The business's waiting events, once, through the worker's handlers: a push gets queued, and not sent. */
  async function eventsOnly(): Promise<void> {
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${w.workerId}
          where workspace_id = ${w.workspaceId} and status = 'pending'`,
    );
    const stats = await processOnce({
      ...w.s,
      handlers,
      workerId: w.workerId,
      batchSize: 100,
      reservedOnly: true,
    });
    expect(stats.retried + stats.failed).toBe(0);
  }

  const onPhone = (list: readonly FakePushSent[], phone: Phone) =>
    list.filter((s) => s.message.to === phone.token).map((s) => s.message);

  it('tells the owners’ phones about an urgent lead once, in both shapes, beside the email', async () => {
    const { leadId, personId } = await hotLead('Maria');
    // Her text buzzed the owners and admins as it arrived; what follows is the urgent push.
    const before = sent().length;
    await runSweep(w);
    await runJobs();
    await waitForMail(w.owner.email, 'Hot lead: Maria Test is waiting');
    const item = await itemOf(w, leadId, 'hot_lead');

    const pushes = sent().slice(before);
    // The owners and admins: Dale's two phones and Priya's. Marco, a member, isn't told about unassigned leads.
    expect(tokensOf(pushes)).toEqual(
      [phones.daleIphone.token, phones.daleAndroid.token, phones.priyaIphone.token].sort(),
    );
    const ios = pushes.find((s) => s.message.to === phones.daleIphone.token)!.message;
    // No AI teammate here to hand it to, so no Let HandsFreeOS handle: Call and Snooze 1 hour.
    expect(ios).toMatchObject({
      title: 'Hot lead · Maria Test',
      subtitle: business,
      categoryId: 'urgent_lead_no_ai',
      sound: 'default',
      priority: 'high',
      interruptionLevel: 'time-sensitive',
    });
    // The lead, then what they said.
    expect(ios.body).toBe(
      'Maria: no cooling. Can you come out today? I want to get this booked ASAP.',
    );
    const data = dataOf(ios);
    expect(data).toMatchObject({
      category: 'urgent_lead_no_ai',
      workspaceId: w.workspaceId,
      business,
      path: `/app/w/${w.workspaceId}?item=${item.id}`,
      refs: { itemId: item.id, leadId, personId, channel: 'sms' },
    });
    expect(Object.keys(data.commandIds)).toEqual(['snooze']);

    const android = pushes.find((s) => s.message.to === phones.daleAndroid.token)!.message;
    expect(android.title).toBeUndefined();
    expect(android.categoryId).toBeUndefined();
    expect(dataOf(android)).toMatchObject({
      title: ios.title,
      subtitle: ios.subtitle,
      body: ios.body,
      category: 'urgent_lead_no_ai',
    });
    // One notice: the same notification and the same command ids on every phone.
    expect(new Set(pushes.map((s) => dataOf(s.message).notificationId)).size).toBe(1);
    expect(dataOf(android).commandIds).toEqual(data.commandIds);

    // Its receipt check waits 15 minutes.
    const [receipts] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs
          where workspace_id = ${w.workspaceId} and kind = ${PUSH_JOBS.receipts} and status = 'pending'
            and payload ->> 'notificationId' = ${data.notificationId}`,
    );
    expect(new Date(receipts!.run_at).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    // Another sweep and the jobs, and the conversation's own unanswered check, land on the same wait: nothing more.
    await runSweep(w);
    await runJobs();
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${w.workspaceId} and kind = 'conversation.unanswered_check' and status = 'pending'`,
    );
    await drain(w);
    expect(sent()).toHaveLength(before + 3);
  });

  it('escalates a customer still waiting, to the person it is assigned to, in place of their message’s push', async () => {
    const c = await filedCustomer(w, 'Quinn');
    const arrived = sent().length;
    await textIn(w, c.phone, 'Are you open on Saturday?');
    const [conv] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.conversations where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
    );
    const collapseId = `conversation-${conv!.id}`;
    // Nobody had it yet, so her text buzzed the owners and admins as it came in.
    const first = sent().slice(arrived);
    expect(tokensOf(first)).toEqual(
      [phones.daleIphone.token, phones.daleAndroid.token, phones.priyaIphone.token].sort(),
    );
    expect(dataOf(first[0]!.message)).toMatchObject({
      category: 'customer_message_no_ai',
      collapseId,
    });

    // Marco's conversation, eleven minutes in (no event: only the clock and the owner moved).
    await rows(
      admin(),
      sql`update app.conversations
          set awaiting_reply_since = awaiting_reply_since - interval '11 minutes', assignee_user_id = ${w.member.id}
          where id = ${conv!.id}`,
    );
    const before = sent().length;
    await runSweep(w);
    await runJobs();
    await waitForMail(w.member.email, 'Quinn Test is waiting for a reply');
    const pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    const m = pushes[0]!.message;
    // An urgent item: it replaces the conversation's notification and buzzes again, through Focus. No AI
    // teammate here, so no Let AI handle.
    expect(m).toMatchObject({
      title: 'Customer waiting · Quinn Test',
      subtitle: `Text · ${business}`,
      body: 'Are you open on Saturday?',
      categoryId: 'customer_waiting_no_ai',
      collapseId,
      sound: 'default',
      interruptionLevel: 'time-sensitive',
    });
    expect(dataOf(m)).toMatchObject({
      category: 'customer_waiting_no_ai',
      collapseId,
      path: `/app/w/${w.workspaceId}/inbox/${conv!.id}`,
      refs: { conversationId: conv!.id, channel: 'sms', personId: c.id },
    });
    expect(Object.keys(dataOf(m).commandIds)).toEqual(['reply']);
  });

  it('buzzes the owners and admins when a customer writes to nobody in particular, and only the assignee once there is one', async () => {
    const c = await filedCustomer(w, 'Uma');
    let before = sent().length;
    const { conversationId, messageId } = await textArrives(
      c.phone,
      'Is anyone free to look at my furnace today?',
    );
    await drain(w);
    let pushes = sent().slice(before);
    // As it arrives, not at the reply threshold. Marco, a member, isn't told about conversations nobody has.
    expect(tokensOf(pushes)).toEqual(
      [phones.daleIphone.token, phones.daleAndroid.token, phones.priyaIphone.token].sort(),
    );
    const collapseId = `conversation-${conversationId}`;
    const ios = onPhone(pushes, phones.daleIphone)[0]!;
    expect(ios).toMatchObject({
      title: 'Uma Test',
      subtitle: `Text · ${business}`,
      body: 'Is anyone free to look at my furnace today?',
      categoryId: 'customer_message_no_ai',
      sound: 'default',
      interruptionLevel: 'active',
      collapseId,
      threadId: collapseId,
    });
    expect(dataOf(ios)).toMatchObject({
      category: 'customer_message_no_ai',
      path: `/app/w/${w.workspaceId}/inbox/${conversationId}`,
      refs: { conversationId, channel: 'sms', messageId, personId: c.id },
      collapseId,
    });
    expect(dataOf(ios).quiet).toBeUndefined();
    expect(Object.keys(dataOf(ios).commandIds)).toEqual(['reply']);
    expect(dataOf(onPhone(pushes, phones.daleAndroid)[0]!)).toMatchObject({
      title: 'Uma Test',
      body: 'Is anyone free to look at my furnace today?',
      collapseId,
    });

    // Dale answers, and the conversation becomes Marco's. Her next message is a new wait: it buzzes Marco alone.
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId,
      channel: 'sms',
      body: 'Let me check who is nearby.',
    });
    await rows(
      admin(),
      sql`update app.conversations set assignee_user_id = ${w.member.id} where id = ${conversationId}`,
    );
    await drain(w);
    before = sent().length;
    await textArrives(c.phone, 'Thanks. Anytime after 2 works.');
    await drain(w);
    pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'Uma Test',
      body: 'Thanks. Anytime after 2 works.',
      sound: 'default',
      collapseId,
    });
  });

  it('buzzes only its person for mail to their own address, and nobody for the team’s Other mail', async () => {
    // Marco has an address of his own on the business's domain (M19).
    const domain = `own-${randomUUID().slice(0, 8)}.example.com`;
    const [d] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.email_domains (workspace_id, domain, status, receiving, created_by)
          values (${w.workspaceId}, ${domain}, 'verified', 'on', ${w.owner.id}) returning id`,
    );
    const [mine] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name,
            created_by, owner_user_id)
          values (${w.workspaceId}, ${d!.id}, 'marco', '', 'Pushes', ${w.owner.id}, ${w.member.id})
          returning id`,
    );
    const [team] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.email_addresses where workspace_id = ${w.workspaceId} and is_default`,
    );
    const mailIn = (from: string, emailAddressId: string, over: Record<string, unknown> = {}) =>
      executeCommand(
        testDbs().worker.db,
        emailReceive,
        {
          workspaceId: w.workspaceId,
          provider: 'postmark',
          providerMessageId: `pm-${randomUUID()}`,
          messageIdHeader: `<${randomUUID()}@mail.example.com>`,
          from: { address: from },
          to: [{ address: `marco@${domain}` }],
          subject: 'Dinner Friday?',
          bodyText: 'Are we still on for Friday?',
          emailAddressId,
          ...over,
        },
        systemActor(scope()),
        { correlationId: randomUUID(), channel: 'worker' },
      ).then((r) => r.output);

    let before = sent().length;
    const friend = `friend-${randomUUID().slice(0, 8)}@example.com`;
    const got = await mailIn(friend, mine!.id);
    expect(got.folder).toBe('inbox');
    await drain(w);
    let pushes = sent().slice(before);
    // Marco alone: not Dale or Priya, who run the business but can't see his mail.
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    const collapseId = `conversation-${got.conversationId}`;
    expect(pushes[0]!.message).toMatchObject({
      title: friend,
      body: 'Dinner Friday? · Are we still on for Friday?',
      categoryId: 'customer_message_no_ai',
      collapseId,
    });
    expect(dataOf(pushes[0]!.message)).toMatchObject({
      category: 'customer_message_no_ai',
      path: `/app/w/${w.workspaceId}/inbox/${got.conversationId}`,
      refs: { conversationId: got.conversationId, channel: 'email' },
    });

    // A newsletter to the team's address waits in Other mail, and buzzes nobody.
    before = sent().length;
    const other = await mailIn(`news-${randomUUID().slice(0, 8)}@example.com`, team!.id, {
      automatic: true,
    });
    expect(other.folder).toBe('other');
    await drain(w);
    pushes = sent().slice(before);
    expect(pushes).toEqual([]);
  });

  it('updates one notification quietly for a burst of messages, and buzzes again once it runs out', async () => {
    const c = await filedCustomer(w, 'Val');
    let before = sent().length;
    const { conversationId } = await textArrives(c.phone, 'Hi, my AC stopped.');
    await drain(w);
    await textArrives(c.phone, 'It is making a clicking noise.');
    await drain(w);
    await textArrives(c.phone, 'Can someone come today?');
    await drain(w);
    const collapseId = `conversation-${conversationId}`;
    const ios = onPhone(sent().slice(before), phones.daleIphone);
    // One notification with the latest words: the first buzzes, the next two replace it without a sound.
    expect(ios.map((m) => m.body)).toEqual([
      'Hi, my AC stopped.',
      'It is making a clicking noise.',
      'Can someone come today?',
    ]);
    expect(ios.map((m) => m.collapseId)).toEqual([collapseId, collapseId, collapseId]);
    expect(ios.map((m) => m.sound ?? null)).toEqual(['default', null, null]);
    expect(ios.map((m) => m.interruptionLevel)).toEqual(['active', 'passive', 'passive']);
    expect(ios.map((m) => dataOf(m).quiet ?? false)).toEqual([false, true, true]);
    // Android's app does the same with the data: it replaces its notification, alerting only the first time.
    const android = onPhone(sent().slice(before), phones.daleAndroid);
    expect(android.map((m) => [dataOf(m).collapseId, dataOf(m).quiet ?? false])).toEqual([
      [collapseId, false],
      [collapseId, true],
      [collapseId, true],
    ]);
    // Each message is its own push, with its own command ids for Reply.
    expect(new Set(ios.map((m) => dataOf(m).notificationId)).size).toBe(3);

    // Two minutes on, the burst has run out: her next message buzzes again.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where kind = ${PUSH_JOBS.burst} and dedupe_key = ${`push-burst:${conversationId}`} and status = 'pending'`,
    );
    await drain(w);
    before = sent().length;
    await textArrives(c.phone, 'Hello?');
    await drain(w);
    expect(onPhone(sent().slice(before), phones.daleIphone)).toEqual([
      expect.objectContaining({ body: 'Hello?', sound: 'default', interruptionLevel: 'active' }),
    ]);
  });

  it('says nothing about a message that needs no answer, is old news, or was answered before its push went', async () => {
    // A STOP isn't a question for the team.
    const stopper = await filedCustomer(w, 'Wes');
    let before = sent().length;
    await textArrives(stopper.phone, 'STOP');
    await drain(w);
    expect(sent().slice(before)).toEqual([]);

    // Written twenty minutes before it arrived: catching up, not news. It is past the business's 10-minute reply
    // threshold already, though, so what reaches the phones is the urgent push that a customer is waiting.
    const late = await filedCustomer(w, 'Xena');
    before = sent().length;
    await textArrives(late.phone, 'Sent this a while ago.', 20 * 60);
    await drain(w);
    expect([
      ...new Set(
        sent()
          .slice(before)
          .map((s) => dataOf(s.message).category),
      ),
    ]).toEqual(['customer_waiting_no_ai']);

    // Answered in that instant: its push was queued, and Dale replied before it went.
    const quick = await filedCustomer(w, 'Yara');
    before = sent().length;
    const asked = await textArrives(quick.phone, 'Do you service heat pumps?');
    await eventsOnly();
    expect(await pushJob(`message:${asked.messageId}`)).toMatchObject({ status: 'pending' });
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: asked.conversationId,
      channel: 'sms',
      body: 'We do.',
    });
    await drain(w);
    expect(sent().slice(before)).toEqual([]);
    expect(await pushJob(`message:${asked.messageId}`)).toMatchObject({ status: 'done' });

    // Snoozed again before its event was handled (nothing reopened it): nothing.
    const snoozed = await filedCustomer(w, 'Zoe');
    before = sent().length;
    const quiet = await textArrives(snoozed.phone, 'No rush on this one.');
    await rows(
      admin(),
      sql`update app.conversations set status = 'snoozed', snoozed_until = now() + interval '1 day'
          where id = ${quiet.conversationId}`,
    );
    await drain(w);
    expect(sent().slice(before)).toEqual([]);
  });

  it('follows each person’s push switch, whatever their email switch says', async () => {
    try {
      // Dale turns urgent pushes off: his email still comes, his phones stay quiet, Priya's still hears.
      await settingsOf(w.owner, { push: { urgent: false } });
      await hotLead('Nadia');
      let before = sent().length;
      await runSweep(w);
      await runJobs();
      await waitForMail(w.owner.email, 'Hot lead: Nadia Test is waiting');
      expect(tokensOf(sent().slice(before))).toEqual([phones.priyaIphone.token]);

      // Priya turns the urgent email off but keeps the push: her phone hears, her inbox doesn't.
      await settingsOf(priya, { notifications: { unansweredEmail: false } });
      await hotLead('Opal');
      before = sent().length;
      await runSweep(w);
      await runJobs();
      await waitForMail(w.owner.email, 'Hot lead: Opal Test is waiting');
      expect(tokensOf(sent().slice(before))).toEqual([phones.priyaIphone.token]);
      await pause(300);
      expect((await mailTo(priya.email)).filter((m) => m.Subject.includes('Opal'))).toEqual([]);

      // Both of them off: the email alone, and no push job at all.
      await settingsOf(priya, { push: { urgent: false } });
      await settingsOf(priya, { notifications: {} });
      const pilar = await hotLead('Pilar');
      before = sent().length;
      await runSweep(w);
      await runJobs();
      await waitForMail(w.owner.email, 'Hot lead: Pilar Test is waiting');
      expect(sent()).toHaveLength(before);
      const [urgentJobs] = await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.scheduled_jobs
            where workspace_id = ${w.workspaceId} and kind = ${PUSH_JOBS.send}
              and payload -> 'refs' ->> 'leadId' = ${pilar.leadId}`,
      );
      expect(urgentJobs!.n).toBe(0);

      // A new message follows its own switch: Dale turns customer messages off, and only Priya's phone buzzes.
      await settingsOf(w.owner, { push: { customerWaiting: false } });
      const hugo = await filedCustomer(w, 'Hugo');
      before = sent().length;
      await textIn(w, hugo.phone, 'Do you do duct cleaning?');
      expect(tokensOf(sent().slice(before))).toEqual([phones.priyaIphone.token]);
    } finally {
      await settingsOf(w.owner, { push: {} });
      await settingsOf(priya, { push: {}, notifications: {} });
    }
  });

  it('tells whoever a lead, a task, a conversation or a Home item is given to, unless they took it', async () => {
    const c = await filedCustomer(w, 'Rosa');
    const leadId = await inboundLead(w, c.id, 'AC tune-up');
    await drain(w);

    let before = sent().length;
    await run(w, leadUpdate, { workspaceId: w.workspaceId, leadId, assigneeUserId: w.member.id });
    await drain(w);
    let pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'Assigned to you · Rosa Test',
      subtitle: business,
      body: 'Lead: AC tune-up · from Dale Owner',
      categoryId: 'assigned',
    });
    expect(dataOf(pushes[0]!.message)).toMatchObject({
      path: `/app/w/${w.workspaceId}/leads/${leadId}`,
      refs: { leadId, personId: c.id },
      commandIds: {},
    });

    // Dale takes it himself: nobody is told.
    before = sent().length;
    await run(w, leadUpdate, { workspaceId: w.workspaceId, leadId, assigneeUserId: w.owner.id });
    await drain(w);
    expect(sent().slice(before)).toEqual([]);

    // A task for Marco, due tomorrow at 10.
    before = sent().length;
    const due = at(1, '10:00');
    const { taskId } = await run(w, taskCreate, {
      workspaceId: w.workspaceId,
      title: 'Call Rosa back about the quote',
      dueAt: iso(due),
      allDay: false,
      assigneeUserId: w.member.id,
      personId: c.id,
    });
    await drain(w);
    pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'Task assigned to you',
      body: `Call Rosa back about the quote · due ${whenLabel(due, CHI)} · from Dale Owner`,
    });
    expect(dataOf(pushes[0]!.message).refs).toEqual({ taskId, personId: c.id });

    // Her conversation, given to Priya.
    await textIn(w, c.phone, 'Thursday works for me.');
    const [conv] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.conversations where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
    );
    before = sent().length;
    await run(w, conversationAssign, {
      workspaceId: w.workspaceId,
      conversationId: conv!.id,
      assigneeUserId: priya.id,
    });
    await drain(w);
    pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([phones.priyaIphone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'Assigned to you · Rosa Test',
      subtitle: `Text · ${business}`,
      body: '“Thursday works for me.” · from Dale Owner',
    });

    // A lead's Home item given to Marco passes the lead on: one push, from the lead's own event.
    const d = await filedCustomer(w, 'Sam');
    const other = await inboundLead(w, d.id, 'Furnace check', 30);
    await drain(w);
    await runSweep(w);
    const item = await itemOf(w, other, 'unanswered_lead');
    before = sent().length;
    await run(w, attentionAssign, {
      workspaceId: w.workspaceId,
      itemId: item.id,
      assigneeUserId: w.member.id,
    });
    await drain(w);
    pushes = sent()
      .slice(before)
      .filter((s) => dataOf(s.message).category === 'assigned');
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    expect(pushes[0]!.message.body).toBe('Lead: Furnace check · from Dale Owner');
  });

  it('tells the people working an appointment when it is booked, moved or cancelled by someone else', async () => {
    const cal = await makeCalendar(w, 'Service visits', {
      team: { members: [{ userId: w.owner.id }, { userId: w.member.id }] },
    });
    const c = await filedCustomer(w, 'Mike');
    const start = at(3, '13:00');
    let before = sent().length;
    const { appointmentId } = await run(w, appointmentCreate, {
      workspaceId: w.workspaceId,
      calendarId: cal.id,
      startsAt: iso(start),
      durationMinutes: 60,
      userIds: [w.owner.id, w.member.id],
      personId: c.id,
      title: 'AC repair',
      notify: false,
      acknowledgeWarnings: true,
    });
    await drain(w);
    let pushes = sent().slice(before);
    // Dale booked it, so only Marco hears.
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'New booking · Mike Test',
      body: `AC repair · ${whenLabel(start, CHI)}`,
      categoryId: 'booking',
    });
    expect(dataOf(pushes[0]!.message)).toMatchObject({
      path: `/app/w/${w.workspaceId}/calendar?appt=${appointmentId}`,
      refs: { appointmentId, personId: c.id },
    });

    const moved = at(4, '09:00');
    before = sent().length;
    await run(w, appointmentReschedule, {
      workspaceId: w.workspaceId,
      appointmentId,
      startsAt: iso(moved),
      notify: false,
      acknowledgeWarnings: true,
    });
    await drain(w);
    pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'Moved · Mike Test',
      body: `AC repair · ${whenLabel(moved, CHI)} (was ${whenLabel(start, CHI)})`,
    });

    before = sent().length;
    await run(w, appointmentCancel, { workspaceId: w.workspaceId, appointmentId, notify: false });
    await drain(w);
    pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([phones.marcoIphone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'Cancelled · Mike Test',
      body: `AC repair · ${whenLabel(moved, CHI)}`,
    });
  });

  it('tells the owners and admins a customer paid, only once they turn it on', async () => {
    const c = await filedCustomer(w, 'Elena');
    const lines = [{ name: 'AC tune-up', quantity: 1, unitPriceCents: 18_000, unitLabel: 'each' }];
    const paid = async () => {
      const { invoiceId } = await run(w, invoiceCreate, {
        workspaceId: w.workspaceId,
        personId: c.id,
        title: 'AC tune-up',
        lines,
      });
      const sentInvoice = await run(w, invoiceSend, {
        workspaceId: w.workspaceId,
        invoiceId,
        channels: ['sms'],
      });
      await drain(w);
      const before = sent().length;
      await run(w, invoiceRecordCashPayment, {
        workspaceId: w.workspaceId,
        invoiceId,
        amountCents: sentInvoice.totalCents,
        method: 'check',
      });
      await drain(w);
      return {
        invoiceId,
        number: sentInvoice.number,
        total: sentInvoice.totalCents,
        pushes: sent().slice(before),
      };
    };
    // Off until turned on: nobody hears (and Dale recorded it anyway).
    expect((await paid()).pushes).toEqual([]);

    try {
      await settingsOf(priya, { push: { payment: true } });
      await settingsOf(w.owner, { push: { payment: true } });
      const { invoiceId, number, total, pushes } = await paid();
      expect(tokensOf(pushes)).toEqual([phones.priyaIphone.token]);
      expect(pushes[0]!.message).toMatchObject({
        title: 'Paid · Elena Test',
        body: `${number} · ${money(total)} by check`,
        categoryId: 'payment',
      });
      expect(dataOf(pushes[0]!.message)).toMatchObject({
        path: `/app/w/${w.workspaceId}/money/invoices/${invoiceId}`,
        refs: { invoiceId, personId: c.id },
      });
    } finally {
      await settingsOf(priya, { push: {} });
      await settingsOf(w.owner, { push: {} });
    }
  });

  it('turns off a phone the app is gone from: at once from its ticket, or from its receipt later', async () => {
    const dead = await phoneOf(priya, 'ios', 'Dead');
    const gone = await phoneOf(priya, 'android', 'Gone');
    const back = await phoneOf(w.member, 'android', 'Gone-back');
    const c = await filedCustomer(w, 'Tess');
    const one = await inboundLead(w, c.id, 'Heat pump');
    const two = await inboundLead(w, c.id, 'Duct cleaning');
    await drain(w);
    await run(w, leadUpdate, { workspaceId: w.workspaceId, leadId: one, assigneeUserId: priya.id });
    await run(w, leadUpdate, {
      workspaceId: w.workspaceId,
      leadId: two,
      assigneeUserId: w.member.id,
    });
    await drain(w);
    // The dead one's ticket said so: off already. The others wait for their receipts.
    expect(await deviceRow(dead.deviceId)).toMatchObject({ disabledReason: 'not_registered' });
    expect((await deviceRow(gone.deviceId)).disabledAt).toBeNull();
    expect((await deviceRow(back.deviceId)).disabledAt).toBeNull();
    // Marco's app registered again after its push went: that phone is back, whatever the receipt says.
    await pause(20);
    await as(w.member, pushDeviceRegister, {
      platform: 'android',
      token: back.token,
      appVersion: '1.0.1',
    });

    const res = await post(w, '/test/push/run-due', { workspaceId: w.workspaceId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ran: { failed: 0, retried: 0 } });
    expect(await deviceRow(gone.deviceId)).toMatchObject({ disabledReason: 'not_registered' });
    expect((await deviceRow(back.deviceId)).disabledAt).toBeNull();
    expect((await deviceRow(phones.priyaIphone.deviceId)).disabledAt).toBeNull();

    // Off phones get nothing more.
    const before = sent().length;
    await run(w, leadUpdate, { workspaceId: w.workspaceId, leadId: two, assigneeUserId: priya.id });
    await drain(w);
    expect(tokensOf(sent().slice(before))).toEqual([phones.priyaIphone.token]);
  });

  describe('never twice', () => {
    let riley: TestUser;
    let rileyPhone: Phone;
    beforeAll(async () => {
      riley = await createTestUser('pushes-riley', { fullName: 'Riley Member' });
      await rows(
        admin(),
        sql`insert into app.workspace_memberships (workspace_id, user_id, role)
            values (${w.workspaceId}, ${riley.id}, 'member')`,
      );
      rileyPhone = await phoneOf(riley, 'ios', 'riley');
    });
    const toRiley = () => sent().filter((s) => s.message.to === rileyPhone.token);
    const queue = (key: string, userIds = [riley.id]) =>
      asWorker(w.s.db, scope(), (tx) =>
        queuePush(tx, scope(), {
          key,
          category: 'assigned',
          userIds,
          title: 'Assigned to you',
          body: 'A test',
          path: `/app/w/${w.workspaceId}`,
          refs: {},
        }),
      );

    it('queues one job for a moment queued twice', async () => {
      const key = `test:${randomUUID()}`;
      expect(await queue(key)).toBe(1);
      expect(await queue(key)).toBe(1);
      const before = toRiley().length;
      await drain(w);
      expect(toRiley()).toHaveLength(before + 1);
      // Nobody listening: nothing queued at all.
      expect(await queue(`test:${randomUUID()}`, [randomUUID()])).toBe(0);
    });

    it('sends again only what Expo refused, and never what may have gone', async () => {
      // Refused: none of it went, so the job's next try sends it, once.
      const refusedKey = `test:${randomUUID()}`;
      let before = toRiley().length;
      w.s.push.fake.failNext('refused');
      await queue(refusedKey);
      expect(await jobsOnce(w)).toMatchObject({ retried: 1 });
      expect(toRiley()).toHaveLength(before);
      const job = await pushJob(refusedKey);
      expect(job).toMatchObject({ status: 'pending', attempts: 1 });
      await rows(admin(), sql`update app.scheduled_jobs set run_at = now() where id = ${job!.id}`);
      await drain(w);
      expect(toRiley()).toHaveLength(before + 1);

      // Lost: it may have gone, so the job is done, and even run again it sends nothing.
      const lostKey = `test:${randomUUID()}`;
      before = toRiley().length;
      w.s.push.fake.failNext('lost');
      await queue(lostKey);
      await drain(w);
      expect(toRiley()).toHaveLength(before + 1);
      const lost = await pushJob(lostKey);
      expect(lost).toMatchObject({ status: 'done' });
      expect(lost!.payload['_delivery']).toEqual({
        handedOver: [rileyPhone.deviceId],
        inFlight: [],
      });
      await rows(
        admin(),
        sql`update app.scheduled_jobs set status = 'pending', run_at = now(), finished_at = null
            where id = ${lost!.id}`,
      );
      await drain(w);
      expect(toRiley()).toHaveLength(before + 1);

      // A try that stopped mid-request (the worker restarted): its phones in flight count as told.
      const stoppedKey = `test:${randomUUID()}`;
      before = toRiley().length;
      const marcoBefore = sent().filter((s) => s.message.to === phones.marcoIphone.token).length;
      await queue(stoppedKey, [riley.id, w.member.id]);
      const stopped = await pushJob(stoppedKey);
      await rows(
        admin(),
        sql`update app.scheduled_jobs
            set payload = jsonb_set(payload, '{_delivery}', ${JSON.stringify({ handedOver: [], inFlight: [rileyPhone.deviceId] })}::jsonb)
            where id = ${stopped!.id}`,
      );
      await drain(w);
      expect(toRiley()).toHaveLength(before);
      expect(sent().filter((s) => s.message.to === phones.marcoIphone.token)).toHaveLength(
        marcoBefore + 1,
      );
    });

    it('goes with its event: an event retried after another handler failed pushes once', async () => {
      let failures = 1;
      const flaky: EventHandler = async () => {
        if (failures-- > 0) throw new Error('the handler after the push failed');
      };
      const map: HandlerMap = {
        ...handlers,
        'task.created': [...handlersFor(handlers, 'task.created'), flaky],
      };
      const before = toRiley().length;
      const { taskId } = await run(w, taskCreate, {
        workspaceId: w.workspaceId,
        title: 'Check the thermostat',
        assigneeUserId: riley.id,
      });
      const once = async () => {
        await rows(
          admin(),
          sql`update app.outbox set locked_at = now(), locked_by = ${w.workerId}, next_attempt_at = now()
              where workspace_id = ${w.workspaceId} and status = 'pending'`,
        );
        return processOnce({
          ...w.s,
          handlers: map,
          workerId: w.workerId,
          batchSize: 50,
          reservedOnly: true,
        });
      };
      expect(await once()).toMatchObject({ retried: 1 });
      // Rolled back with the event: no push job was left behind.
      const [queued] = await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.scheduled_jobs
            where workspace_id = ${w.workspaceId} and kind = ${PUSH_JOBS.send}
              and payload -> 'refs' ->> 'taskId' = ${taskId}`,
      );
      expect(queued!.n).toBe(0);
      expect(await once()).toMatchObject({ done: 1 });
      await drain(w, 20_000, map);
      expect(toRiley()).toHaveLength(before + 1);
      expect(dataOf(toRiley().at(-1)!.message).refs).toMatchObject({ taskId });
    });
  });

  it('shows Playwright what the stand-in was handed for one business', async () => {
    const res = await get(w, `/test/push/sent?workspaceId=${w.workspaceId}`);
    expect(res.statusCode, res.body).toBe(200);
    const { sent: listed } = res.json() as {
      sent: { to: string; platform: string; categoryId: string | null; data: PushData }[];
    };
    expect(listed.length).toBe(sent().length);
    expect(listed.every((s) => s.data.workspaceId === w.workspaceId)).toBe(true);
    expect(listed.filter((s) => s.platform === 'android').every((s) => !s.categoryId)).toBe(true);
    const other = await get(w, `/test/push/sent?workspaceId=${randomUUID()}`);
    expect((other.json() as { sent: unknown[] }).sent).toEqual([]);
  });

  it('never puts a secret in a push', async () => {
    expect(sent().length).toBeGreaterThan(15);
    const [secrets] = await rows<{ tokens: string[] }>(
      admin(),
      sql`select coalesce(array_agg(email_reply_token) filter (where email_reply_token is not null), '{}') as tokens
          from app.conversations where workspace_id = ${w.workspaceId}`,
    );
    const allowed = new Set([
      'v',
      'notificationId',
      'category',
      'workspaceId',
      'business',
      'path',
      'sentAt',
      'refs',
      'commandIds',
      'collapseId',
      'quiet',
      'title',
      'subtitle',
      'body',
    ]);
    for (const { message } of sent()) {
      const { to, ...rest } = message;
      const words = JSON.stringify(rest);
      expect(to).toMatch(/^ExponentPushToken\[/);
      // No push token but its own address, no link (a customer's pages carry their codes), no key, no token.
      expect(words).not.toMatch(/Expo(nent)?PushToken/);
      expect(words).not.toMatch(/https?:\/\//);
      expect(words).not.toMatch(/sk_|whsec_|sb_secret|Bearer/);
      for (const t of secrets!.tokens) expect(words).not.toContain(t);
      for (const k of Object.keys(message.data)) expect(allowed.has(k), k).toBe(true);
    }
  });
});

// ---------- approvals: the AI teammate's drafts, and a workflow's approval step ----------

describe('approvals waiting', () => {
  let t: TeammateWorld;
  let dalePhone: Phone;
  beforeAll(async () => {
    t = await teammateWorld('pushappr');
    dalePhone = await phoneOf(t.owner, 'ios', 'dale');
  });
  afterAll(async () => {
    await t?.app.close();
    await closeTestDbs();
  });
  const sent = () => t.s.push.fake.sent;

  it('tells whoever may decide a draft from the AI teammate, with Approve', async () => {
    const c = await newCustomer(t, 'Angela');
    const arrived = sent().length;
    const m = await textIn(t, c.phone, 'Can you move my tune-up to Friday?');
    // The teammate is answering her (its reply is waiting to run), so nobody is buzzed about the message itself.
    expect(sent().slice(arrived)).toEqual([]);
    const before = sent().length;
    await replyNow(t, m.conversationId);
    const [draft] = await rows<{ id: string; preview: { message: { body: string } } }>(
      admin(),
      sql`select id, preview from app.ai_teammate_drafts
          where conversation_id = ${m.conversationId} and status = 'pending'`,
    );
    expect(draft).toBeDefined();
    const pushes = sent().slice(before);
    // Nobody is assigned the conversation, so the teammate's hand-off list: the owners and admins.
    expect(tokensOf(pushes)).toEqual([dalePhone.token]);
    const msg = pushes[0]!.message;
    expect(msg).toMatchObject({ title: 'Approval · Angela Customer', categoryId: 'approval' });
    expect(msg.body).toMatch(/^Ava wrote: “/);
    expect(msg.body).toContain(draft!.preview.message.body.replace(/\s+/g, ' ').slice(0, 40));
    expect(dataOf(msg)).toMatchObject({
      path: `/app/w/${t.workspaceId}/workflows/approvals?filter=ai`,
      refs: {
        draftId: draft!.id,
        conversationId: m.conversationId,
        personId: c.id,
        channel: 'sms',
      },
    });
    expect(Object.keys(dataOf(msg).commandIds)).toEqual(['approve']);
    // The teammate answers texts here, so an urgent push about this conversation would offer the hand-over
    // buttons; not once it is answering the conversation itself, and never without a conversation.
    const takes = await asWorker(t.s.db, { workspaceId: t.workspaceId }, (tx) =>
      Promise.all([
        aiCanTake(tx, t.workspaceId, { channel: 'sms', handledBy: 'person' }),
        aiCanTake(tx, t.workspaceId, { channel: 'sms', handledBy: 'ai' }),
        aiCanTake(tx, t.workspaceId, null),
      ]),
    );
    expect(takes).toEqual([true, false, false]);
  });

  it('buzzes about a customer’s messages once a person has the conversation, with Let AI handle', async () => {
    const c = await newCustomer(t, 'Bianca');
    const arrived = sent().length;
    const m = await textIn(t, c.phone, 'Is the 10 AM slot still open tomorrow?');
    await replyNow(t, m.conversationId);
    expect(
      sent()
        .slice(arrived)
        .filter((s) => dataOf(s.message).category !== 'approval'),
    ).toEqual([]);
    // Dale takes it from Ava: from now on her messages are the team's to answer.
    await run(t, conversationTakeOver, {
      workspaceId: t.workspaceId,
      conversationId: m.conversationId,
    });
    await drain(t);
    const before = sent().length;
    await textIn(t, c.phone, 'Also, can you check my thermostat while you are here?');
    const pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([dalePhone.token]);
    // The teammate answers texts and isn't answering this conversation, so it can be handed back.
    expect(pushes[0]!.message).toMatchObject({
      title: 'Bianca Customer',
      categoryId: 'customer_message',
      body: 'Also, can you check my thermostat while you are here?',
    });
    expect(Object.keys(dataOf(pushes[0]!.message).commandIds)).toEqual(['reply', 'let_ai_handle']);
  });

  it('tells a workflow approval step’s approvers, with Approve and Review', async () => {
    const aiId = sid('pwrite');
    const def: WorkflowDefinitionInput = {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: aiId,
          type: 'ai',
          task: 'write',
          prompt: 'Write a short apology.',
          fallback: 'Sorry the visit didn’t go well. Someone will call you today.',
        },
        {
          id: sid('pappr'),
          type: 'approval',
          message: 'Check this reply before it goes out.',
          previewStepId: aiId,
          expiresAfter: { amount: 1, unit: 'hours' },
          onExpire: 'end',
          rejected: { steps: [] },
        },
      ],
    };
    const { id: workflowId } = await addWorkflow(t, 'Check the apology', def);
    const c = await newCustomer(t, 'Brooks');
    const before = sent().length;
    await run(t, workflowEnrol, { workspaceId: t.workspaceId, workflowId, personId: c.id });
    await drain(t);
    const [approval] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.workflow_approvals where workflow_id = ${workflowId}`,
    );
    const pushes = sent().slice(before);
    expect(tokensOf(pushes)).toEqual([dalePhone.token]);
    expect(pushes[0]!.message).toMatchObject({
      title: 'Approval · Brooks Customer',
      body: 'Check the apology: “Sorry the visit didn’t go well. Someone will call you today.”',
      categoryId: 'approval',
    });
    expect(dataOf(pushes[0]!.message)).toMatchObject({
      path: `/app/w/${t.workspaceId}/workflows/approvals`,
      refs: { approvalId: approval!.id, personId: c.id },
    });
  });
});
