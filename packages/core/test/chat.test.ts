/**
 * M7 step 4 on the local database: website chat widgets (channels.manage), visitors and their tokens (only
 * hashes), chat messages (one conversation per visitor, sent once, blocks, pauses and the daily cap), who a
 * visitor says they are (a matched customer is linked and never edited; STOP wins), blocking from the inbox,
 * and chats in the inbox.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  activities,
  chatVisitors,
  conversations,
  events,
  messages,
  optOuts,
  people,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { formatPhone } from '../src/crm/phone';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  aiTeammateCreate,
  chatBlockVisitor,
  chatIdentify,
  chatMarkRead,
  chatMarkSent,
  chatReceive,
  chatUnblockVisitor,
  chatVisitorRecordSeen,
  chatVisitorResume,
  chatVisitorRotateToken,
  chatVisitorStart,
  chatWidgetCreate,
  chatWidgetGet,
  chatWidgetList,
  chatWidgetPause,
  chatWidgetRecordSeen,
  chatWidgetResume,
  chatWidgetRotateKey,
  chatWidgetUpdate,
  conversationClose,
  conversationGet,
  conversationThread,
  inboxList,
  messageSend,
  organizationCreate,
  personCreate,
} from '../src/server';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});

let owner: TestUser;
let manager: TestUser;
let member: TestUser;
let outsider: TestUser;
let wsId: string;
let orgId: string;
let teammateId: string;
/** lonestarhvac.com, answered by Ava. */
let widgetId: string;

const runFull = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta());
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => runFull(cmd, input, u).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const system = (): SystemActor => ({ type: 'system', workspaceId: wsId, organizationId: orgId });
/** The worker's chat routes: the system actor on the chat_widget channel. */
const sysFull = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(worker(), cmd, input, system(), meta('chat_widget'));
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  sysFull(cmd, input).then((r) => r.output);

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

/** A token's or an IP's hash, as the worker makes them. */
const hash = () => randomBytes(32).toString('hex');
let phoneSeq = 0;
const nextPhone = () => `+1713555${String(2000 + phoneSeq++).padStart(4, '0')}`;

/** A visitor, as the chat window's start route makes one. */
async function visit(opts: { widget?: string; ip?: string; page?: string } = {}) {
  const token = hash();
  const { visitorId } = await sys(chatVisitorStart, {
    workspaceId: wsId,
    widgetId: opts.widget ?? widgetId,
    tokenHash: token,
    ...(opts.ip ? { ipHmac: opts.ip } : {}),
    pagePath: opts.page ?? '/services/ac-repair',
  });
  return { visitorId, token };
}
const say = (visitorId: string, body: string, clientId: string = randomUUID()) =>
  sys(chatReceive, { workspaceId: wsId, visitorId, body, clientId, reminderAfterMs: 86_400_000 });

async function visitorRow(id: string) {
  const [v] = await admin().select().from(chatVisitors).where(eq(chatVisitors.id, id));
  return v!;
}
async function conv(id: string) {
  const [c] = await admin().select().from(conversations).where(eq(conversations.id, id));
  return c!;
}
async function personRow(id: string) {
  const [p] = await admin().select().from(people).where(eq(people.id, id));
  return p!;
}
async function eventsOf(ids: readonly string[]) {
  return admin()
    .select({ type: events.eventType, entityId: events.entityId, payload: events.payload })
    .from(events)
    .where(inArray(events.id, [...ids]));
}

beforeAll(async () => {
  [owner, manager, member, outsider] = await Promise.all([
    createTestUser('chat-core-owner', { fullName: 'Dale Owner' }),
    createTestUser('chat-core-admin', { fullName: 'Priya Admin' }),
    createTestUser('chat-core-member', { fullName: 'Marco Member' }),
    createTestUser('chat-core-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Chat Core HVAC' }, owner);
  wsId = org.workspaceId;
  orgId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${manager.id}, 'admin'), (${wsId}, ${member.id}, 'member')`,
  );
  teammateId = (
    await run(
      aiTeammateCreate,
      { workspaceId: wsId, preset: 'lead_responder', name: 'Ava', disclosure: 'first_message' },
      owner,
    )
  ).teammateId;
  widgetId = (
    await run(
      chatWidgetCreate,
      { workspaceId: wsId, allowedOrigins: ['lonestarhvac.com'], teammateId },
      manager,
    )
  ).widgetId;
});
afterAll(closeTestDbs);

describe('chat widgets (owners and admins)', () => {
  it('saves the sites people type as exact origins with www twins, and says why it refuses one', async () => {
    const made = await runFull(
      chatWidgetCreate,
      {
        workspaceId: wsId,
        allowedOrigins: ['https://LoneStarHVAC.com/contact', 'localhost:4191'],
        teammateId,
        greeting: 'Hi! Questions about a repair?',
        accentColor: '#0F766E',
      },
      manager,
    );
    expect(made.output).toMatchObject({
      allowedOrigins: [
        'https://lonestarhvac.com',
        'https://www.lonestarhvac.com',
        'http://localhost:4191',
      ],
      publicKey: expect.stringMatching(/^wk_[A-Za-z0-9]{20}$/),
    });
    expect((await eventsOf(made.eventIds)).map((e) => e.type)).toEqual(['chat_widget.created']);
    const refused = await expectHfos(
      () =>
        run(
          chatWidgetCreate,
          { workspaceId: wsId, allowedOrigins: ['acme.com', '192.168.1.5'] },
          manager,
        ),
      'validation',
    );
    expect(refused.details).toEqual([
      { path: 'allowedOrigins.1', message: expect.stringMatching(/not a number address/) },
    ]);
    await expectHfos(
      () =>
        run(
          chatWidgetCreate,
          { workspaceId: wsId, allowedOrigins: ['acme.com'], teammateId: randomUUID() },
          manager,
        ),
      'validation',
    );
    await expectHfos(
      () => run(chatWidgetCreate, { workspaceId: wsId, allowedOrigins: ['acme.com'] }, member),
      'forbidden',
    );
    await expectHfos(
      () => run(chatWidgetCreate, { workspaceId: wsId, allowedOrigins: ['acme.com'] }, outsider),
      'not_found',
    );
  });

  it('changes only what’s sent, pauses and resumes, and a new key retires older snippets', async () => {
    const { widgetId: w, publicKey } = await run(
      chatWidgetCreate,
      { workspaceId: wsId, allowedOrigins: ['acme-heating.com'] },
      owner,
    );
    const change = {
      workspaceId: wsId,
      widgetId: w,
      greeting: 'Hello!',
      askFor: { phone: 'before_chat' },
      dailyCap: 50,
    };
    expect((await run(chatWidgetUpdate, change, manager)).updated).toEqual([
      'greeting',
      'askFor',
      'dailyCap',
    ]);
    const same = await runFull(chatWidgetUpdate, change, manager);
    expect(same.output.updated).toEqual([]);
    expect(same.eventIds).toEqual([]);
    const tooMany = await expectHfos(
      () =>
        run(
          chatWidgetUpdate,
          {
            workspaceId: wsId,
            widgetId: w,
            allowedOrigins: ['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com', 'a6.com'],
          },
          manager,
        ),
      'validation',
    );
    expect(tooMany.details).toEqual([
      { path: 'allowedOrigins', message: expect.stringMatching(/up to 10 sites/) },
    ]);
    await expectHfos(
      () => run(chatWidgetUpdate, { workspaceId: wsId, widgetId: w, greeting: 'Yo' }, member),
      'forbidden',
    );

    const ref = { workspaceId: wsId, widgetId: w };
    expect(await run(chatWidgetPause, ref, manager)).toEqual({ widgetId: w, paused: true });
    expect((await runFull(chatWidgetPause, ref, manager)).eventIds).toEqual([]);
    await expectHfos(() => run(chatWidgetResume, ref, member), 'forbidden');
    expect(await run(chatWidgetResume, ref, manager)).toEqual({ widgetId: w, paused: false });
    const rotated = await run(chatWidgetRotateKey, ref, manager);
    expect(rotated.publicKey).toMatch(/^wk_[A-Za-z0-9]{20}$/);
    expect(rotated.publicKey).not.toBe(publicKey);
    await expectHfos(() => run(chatWidgetRotateKey, ref, member), 'forbidden');

    const { widget } = await ask(chatWidgetGet, ref, member);
    expect(widget).toMatchObject({
      name: 'acme-heating.com',
      publicKey: rotated.publicKey,
      allowedOrigins: ['https://acme-heating.com', 'https://www.acme-heating.com'],
      greeting: 'Hello!',
      askFor: { name: 'when_needed', phone: 'before_chat', email: 'when_needed' },
      dailyCap: 50,
      paused: false,
      accentColor: '#2d69d8',
      textColor: '#ffffff',
      teammate: null,
      install: { seen: false, lastSeenOrigin: null, lastSeenAt: null },
    });
  });

  it('names the business’s pages when it offers the texts box, so the box links to the policy and terms', async () => {
    const siteOf = async (workspaceId: string) =>
      (
        await rows<{ slug: string; enabled: boolean }>(
          admin(),
          sql`select slug::text as slug, enabled from app.booking_sites where workspace_id = ${workspaceId}`,
        )
      )[0];
    // Made with the box (the texting registration's chat): named at once, switched off.
    const made = await run(organizationCreate, { businessName: 'Texts Box Plumbing' }, owner);
    await run(
      chatWidgetCreate,
      {
        workspaceId: made.workspaceId,
        allowedOrigins: ['texts-box.com'],
        smsConsent: true,
        askFor: { name: 'after_first_message', phone: 'after_first_message', email: 'never' },
      },
      owner,
    );
    expect(await siteOf(made.workspaceId)).toEqual({
      slug: expect.stringMatching(/^texts-box-plumbing/),
      enabled: false,
    });

    // Without it, nothing is named until the box is turned on.
    const later = await run(organizationCreate, { businessName: 'Box Later Roofing' }, owner);
    const { widgetId: w } = await run(
      chatWidgetCreate,
      { workspaceId: later.workspaceId, allowedOrigins: ['box-later.com'], smsConsent: false },
      owner,
    );
    expect(await siteOf(later.workspaceId)).toBeUndefined();
    await run(
      chatWidgetUpdate,
      {
        workspaceId: later.workspaceId,
        widgetId: w,
        smsConsent: true,
        askFor: { phone: 'after_first_message' },
      },
      owner,
    );
    expect(await siteOf(later.workspaceId)).toMatchObject({ enabled: false });
    const { widget } = await ask(
      chatWidgetGet,
      { workspaceId: later.workspaceId, widgetId: w },
      owner,
    );
    expect(widget.askFor).toEqual({
      name: 'when_needed',
      phone: 'after_first_message',
      email: 'when_needed',
    });
  });

  it('lists widgets with the install check and the public key, and nothing secret', async () => {
    const seen = (origin: string) =>
      sys(chatWidgetRecordSeen, { workspaceId: wsId, widgetId, origin });
    expect(await seen('https://www.lonestarhvac.com')).toEqual({ widgetId, recorded: true });
    // At most once a minute per site, and only on the widget's own sites.
    expect(await seen('https://www.lonestarhvac.com')).toEqual({ widgetId, recorded: false });
    expect(await seen('https://evil.example')).toEqual({ widgetId, recorded: false });
    await expectHfos(
      () =>
        run(chatWidgetRecordSeen, { workspaceId: wsId, widgetId, origin: 'https://x.com' }, owner),
      'forbidden',
    );
    const listed = await ask(chatWidgetList, { workspaceId: wsId }, member);
    expect(listed.canManage).toBe(false);
    expect((await ask(chatWidgetList, { workspaceId: wsId }, manager)).canManage).toBe(true);
    const mine = listed.items.find((w) => w.id === widgetId)!;
    expect(mine).toMatchObject({
      name: 'lonestarhvac.com',
      teammate: { id: teammateId, name: 'Ava', status: 'off' },
      install: { seen: true, lastSeenOrigin: 'https://www.lonestarhvac.com' },
    });
    expect(Object.keys(mine).sort()).toEqual(
      [
        'id',
        'name',
        'publicKey',
        'allowedOrigins',
        'teammate',
        'greeting',
        'launcherLabel',
        'accentColor',
        'textColor',
        'position',
        'awayMessage',
        'askFor',
        'smsConsent',
        'dailyCap',
        'paused',
        'pausedAt',
        'install',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
});

describe('visits', () => {
  it('starts a visitor with only hashes, and finds them again by their token', async () => {
    const ip = hash();
    const { visitorId, token } = await visit({ ip });
    const row = await visitorRow(visitorId);
    expect(Buffer.from(row.tokenHash).toString('hex')).toBe(token);
    expect(Buffer.from(row.ipHmac!).toString('hex')).toBe(ip);
    expect(row.lastPagePath).toBe('/services/ac-repair');
    const back = await sys(chatVisitorResume, {
      workspaceId: wsId,
      widgetId,
      tokenHash: token,
      pagePath: '/pricing',
    });
    expect(back).toMatchObject({
      visitorId,
      conversationId: null,
      viaPreviousToken: false,
      rotateDue: false,
      turnstilePassedAt: null,
      blocked: false,
      gave: { name: false, phone: false, email: false },
    });
    expect((await visitorRow(visitorId)).lastPagePath).toBe('/pricing');
    await expectHfos(
      () => sys(chatVisitorResume, { workspaceId: wsId, widgetId, tokenHash: hash() }),
      'rule_violation',
      'chat_not_found',
    );
    // A token belongs to one widget.
    const other = await run(
      chatWidgetCreate,
      { workspaceId: wsId, allowedOrigins: ['other-site.com'] },
      manager,
    );
    await expectHfos(
      () =>
        sys(chatVisitorResume, { workspaceId: wsId, widgetId: other.widgetId, tokenHash: token }),
      'rule_violation',
      'chat_not_found',
    );
    await expectHfos(
      () => sys(chatVisitorStart, { workspaceId: wsId, widgetId, tokenHash: 'not-a-hash' }),
      'validation',
    );
    // Visits are the worker's; nobody signed in starts one.
    await expectHfos(
      () => run(chatVisitorStart, { workspaceId: wsId, widgetId, tokenHash: hash() }, owner),
      'forbidden',
    );
    await sys(chatVisitorRecordSeen, {
      workspaceId: wsId,
      visitorId,
      pagePath: '/book',
      turnstilePassed: true,
    });
    const later = await sys(chatVisitorResume, { workspaceId: wsId, widgetId, tokenHash: token });
    expect(later.turnstilePassedAt).not.toBeNull();
    expect((await visitorRow(visitorId)).lastPagePath).toBe('/book');
  });

  it('keeps the previous token working for 10 minutes after a new one, then stops', async () => {
    const { visitorId, token: first } = await visit();
    const second = hash();
    const rotated = await sys(chatVisitorRotateToken, {
      workspaceId: wsId,
      visitorId,
      tokenHash: second,
    });
    const grace = Date.parse(rotated.previousExpiresAt) - Date.now();
    expect(grace).toBeGreaterThan(9 * 60_000);
    expect(grace).toBeLessThan(11 * 60_000);
    const resume = (tokenHash: string) =>
      sys(chatVisitorResume, { workspaceId: wsId, widgetId, tokenHash });
    expect(await resume(first)).toMatchObject({ visitorId, viaPreviousToken: true });
    expect(await resume(second)).toMatchObject({ visitorId, viaPreviousToken: false });
    await rows(
      admin(),
      sql`update app.chat_visitors set prev_token_expires_at = now() - interval '1 second' where id = ${visitorId}`,
    );
    await expectHfos(() => resume(first), 'rule_violation', 'chat_not_found');
    expect((await resume(second)).visitorId).toBe(visitorId);
    // A week-old token is due for a new one.
    await rows(
      admin(),
      sql`update app.chat_visitors set token_issued_at = now() - interval '8 days' where id = ${visitorId}`,
    );
    expect((await resume(second)).rotateDue).toBe(true);
  });
});

describe('chat.receive', () => {
  it('makes one conversation per visitor, files a repeated message once, and says it arrived on chat', async () => {
    const { visitorId } = await visit();
    const first = await sysFull(chatReceive, {
      workspaceId: wsId,
      visitorId,
      body: '  Do you service Lennox units?  ',
      clientId: 'c-1',
      reminderAfterMs: 86_400_000,
    });
    expect(first.output).toMatchObject({ duplicate: false, newChat: true });
    const c = await conv(first.output.conversationId);
    expect(c).toMatchObject({
      channel: 'chat',
      counterpart: `chat:${visitorId}`,
      status: 'open',
      unreadCount: 1,
      personId: null,
      lastDirection: 'inbound',
      lastPreview: 'Do you service Lennox units?',
    });
    expect(c.awaitingReplySince).not.toBeNull();
    expect((await visitorRow(visitorId)).conversationId).toBe(c.id);
    expect(await eventsOf(first.eventIds)).toEqual([
      {
        type: 'message.received',
        entityId: first.output.messageId,
        payload: expect.objectContaining({
          conversationId: c.id,
          channel: 'chat',
          visitorId,
          widgetId,
          newChat: true,
        }),
      },
    ]);
    const again = await sysFull(chatReceive, {
      workspaceId: wsId,
      visitorId,
      body: 'Do you service Lennox units?',
      clientId: 'c-1',
    });
    expect(again.output).toEqual({
      messageId: first.output.messageId,
      conversationId: c.id,
      duplicate: true,
      newChat: false,
    });
    expect(again.eventIds).toEqual([]);
    expect(await say(visitorId, 'And heat pumps?')).toMatchObject({
      conversationId: c.id,
      duplicate: false,
      newChat: false,
    });
    const filed = await admin()
      .select({ direction: messages.direction, activityId: messages.activityId })
      .from(messages)
      .where(eq(messages.conversationId, c.id));
    expect(filed).toEqual([
      { direction: 'inbound', activityId: null },
      { direction: 'inbound', activityId: null },
    ]);
    expect((await conv(c.id)).unreadCount).toBe(2);
    // A closed chat opens again when the visitor writes.
    await run(conversationClose, { workspaceId: wsId, conversationId: c.id }, member);
    await say(visitorId, 'Hello?');
    expect((await conv(c.id)).status).toBe('open');
    await expectHfos(() => say(visitorId, 'x'.repeat(1001)), 'validation');
    // Chats come from the worker only.
    await expectHfos(
      () => run(chatReceive, { workspaceId: wsId, visitorId, body: 'Hi', clientId: 'c-9' }, owner),
      'forbidden',
    );
  });

  it('refuses blocked visitors and networks, a paused widget, and new chats past the daily cap', async () => {
    const ip = hash();
    const a1 = await visit({ ip });
    const a2 = await visit({ ip });
    const elsewhere = await visit({ ip: hash() });
    await say(a1.visitorId, 'Hi');
    await run(chatBlockVisitor, { workspaceId: wsId, visitorId: a1.visitorId }, member);
    await expectHfos(() => say(a1.visitorId, 'Still there?'), 'forbidden', 'visitor_blocked');
    // Only that visitor, until their network is blocked too.
    await say(a2.visitorId, 'Hello from the same office');
    await run(
      chatBlockVisitor,
      { workspaceId: wsId, visitorId: a1.visitorId, network: true },
      member,
    );
    await expectHfos(() => say(a2.visitorId, 'Me again'), 'forbidden', 'network_blocked');
    expect(
      await sys(chatVisitorStart, { workspaceId: wsId, widgetId, tokenHash: hash(), ipHmac: ip }),
    ).toMatchObject({ blocked: true });
    await say(elsewhere.visitorId, 'A different network');
    await run(chatUnblockVisitor, { workspaceId: wsId, visitorId: a1.visitorId }, member);
    await say(a2.visitorId, 'Me again');
    await say(a1.visitorId, 'Back');

    await run(chatWidgetPause, { workspaceId: wsId, widgetId }, manager);
    await expectHfos(() => say(a1.visitorId, 'Paused?'), 'rule_violation', 'widget_paused');
    await expectHfos(
      async () => say((await visit()).visitorId, 'New?'),
      'rule_violation',
      'widget_paused',
    );
    await run(chatWidgetResume, { workspaceId: wsId, widgetId }, manager);

    // A widget that takes one new chat a day: the second new visitor waits, the first keeps chatting.
    const capped = await run(
      chatWidgetCreate,
      { workspaceId: wsId, allowedOrigins: ['capped-site.com'], dailyCap: 1 },
      manager,
    );
    const v1 = await visit({ widget: capped.widgetId });
    const v2 = await visit({ widget: capped.widgetId });
    expect((await say(v1.visitorId, 'First chat today')).newChat).toBe(true);
    await expectHfos(() => say(v2.visitorId, 'Second chat today'), 'rule_violation', 'daily_cap');
    expect((await say(v1.visitorId, 'Still chatting')).newChat).toBe(false);
  });
});

describe('the chat worker’s marks', () => {
  it('flags a message the human check couldn’t verify, so the AI teammate leaves it to people', async () => {
    const { visitorId } = await visit();
    const unverified = await sysFull(chatReceive, {
      workspaceId: wsId,
      visitorId,
      body: 'Is anyone there?',
      clientId: randomUUID(),
      reminderAfterMs: 86_400_000,
      aiReply: false,
    });
    const checked = await sysFull(chatReceive, {
      workspaceId: wsId,
      visitorId,
      body: 'Our AC is leaking.',
      clientId: randomUUID(),
      reminderAfterMs: 86_400_000,
    });
    const received = await eventsOf([...unverified.eventIds, ...checked.eventIds]);
    const aiReplyOf = (messageId: string) =>
      (received.find((e) => e.entityId === messageId)?.payload as { aiReply?: unknown }).aiReply;
    expect(aiReplyOf(unverified.output.messageId)).toBe(false);
    expect(aiReplyOf(checked.output.messageId)).toBe(true);
  });

  it('marks a person’s reply sent, and the replies the visitor’s window showed as seen, in their own chat only', async () => {
    const { visitorId } = await visit();
    const { conversationId, messageId: inbound } = await say(visitorId, 'Can someone call me?');
    const reply = (body: string) =>
      run(messageSend, { workspaceId: wsId, conversationId, channel: 'chat', body }, member);
    const first = await reply('Sure, what number works?');
    expect(first.status).toBe('queued');
    expect(await sys(chatMarkSent, { workspaceId: wsId, messageId: first.messageId })).toEqual({
      messageId: first.messageId,
      marked: true,
    });
    // Once, and only a queued chat reply: never the visitor's own message.
    expect(
      await sys(chatMarkSent, { workspaceId: wsId, messageId: first.messageId }),
    ).toMatchObject({ marked: false });
    expect(await sys(chatMarkSent, { workspaceId: wsId, messageId: inbound })).toMatchObject({
      marked: false,
    });
    const second = await reply('Or an email is fine too.');
    const statusOf = async (id: string) => {
      const [m] = await admin()
        .select({
          status: messages.status,
          sentAt: messages.sentAt,
          deliveredAt: messages.deliveredAt,
        })
        .from(messages)
        .where(eq(messages.id, id));
      return m!;
    };
    expect(await statusOf(first.messageId)).toMatchObject({ status: 'sent', deliveredAt: null });

    // Another visitor can't mark this chat's replies as seen.
    const other = await visit();
    await say(other.visitorId, 'Hello');
    await expectHfos(
      () =>
        sys(chatMarkRead, {
          workspaceId: wsId,
          visitorId: other.visitorId,
          throughMessageId: first.messageId,
        }),
      'not_found',
    );
    expect(
      await sys(chatMarkRead, { workspaceId: wsId, visitorId, throughMessageId: first.messageId }),
    ).toEqual({ marked: 1 });
    expect(await statusOf(first.messageId)).toMatchObject({ status: 'delivered' });
    expect((await statusOf(first.messageId)).deliveredAt).not.toBeNull();
    expect(await statusOf(second.messageId)).toMatchObject({ status: 'queued', deliveredAt: null });
    expect(
      await sys(chatMarkRead, { workspaceId: wsId, visitorId, throughMessageId: second.messageId }),
    ).toEqual({ marked: 1 });
    const seen = await statusOf(second.messageId);
    expect(seen.status).toBe('delivered');
    expect(seen.sentAt).not.toBeNull();
    // The worker's alone.
    await expectHfos(
      () =>
        run(
          chatMarkRead,
          { workspaceId: wsId, visitorId, throughMessageId: second.messageId },
          owner,
        ),
      'forbidden',
    );
    await expectHfos(
      () => run(chatMarkSent, { workspaceId: wsId, messageId: second.messageId }, owner),
      'forbidden',
    );
  });
});

describe('chat.identify', () => {
  it('links the customer with that phone, then that email, and never changes them', async () => {
    const phone = nextPhone();
    const { personId: linda } = await run(
      personCreate,
      {
        workspaceId: wsId,
        firstName: 'Linda',
        lastName: 'Park',
        phone,
        notes: 'Gate code 1234',
        ignoreDuplicates: true,
      },
      owner,
    );
    const before = await personRow(linda);
    const { visitorId } = await visit();
    const { conversationId } = await say(visitorId, 'Can you come Thursday?');
    const out = await sysFull(chatIdentify, {
      workspaceId: wsId,
      visitorId,
      name: 'Not Linda',
      phone: formatPhone(phone),
      email: 'someone@else.example',
      smsConsent: true,
    });
    // Ids and flags only.
    expect(out.output).toEqual({
      visitorId,
      personId: linda,
      conversationId,
      personCreated: false,
      linkedNow: true,
      smsOptedIn: false,
    });
    // Every field as it was, down to updated_at: the typed name, email and consent never reach her.
    expect(await personRow(linda)).toEqual(before);
    expect(await visitorRow(visitorId)).toMatchObject({
      name: 'Not Linda',
      phoneE164: phone,
      email: 'someone@else.example',
      personId: linda,
    });
    expect((await conv(conversationId)).personId).toBe(linda);
    expect((await eventsOf(out.eventIds)).map((e) => e.type).sort()).toEqual([
      'chat.visitor_identified',
      'conversation.linked',
    ]);
    // It stays with the customer it first matched.
    const otherPhone = nextPhone();
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Omar', phone: otherPhone, ignoreDuplicates: true },
      owner,
    );
    expect(
      await sys(chatIdentify, { workspaceId: wsId, visitorId, phone: otherPhone }),
    ).toMatchObject({ personId: linda, linkedNow: false, personCreated: false });
    expect((await conv(conversationId)).personId).toBe(linda);

    // By email when the phone matches nobody, and never changing her either.
    const eveEmail = `eve-${randomUUID().slice(0, 6)}@example.com`;
    const eve = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Eve', email: eveEmail, ignoreDuplicates: true },
      owner,
    );
    const eveBefore = await personRow(eve.personId);
    const v2 = await visit();
    expect(
      await sys(chatIdentify, {
        workspaceId: wsId,
        visitorId: v2.visitorId,
        phone: nextPhone(),
        email: eveEmail.toUpperCase(),
        name: 'Eve Somebody',
      }),
    ).toMatchObject({ personId: eve.personId, personCreated: false, linkedNow: true });
    expect(await personRow(eve.personId)).toEqual(eveBefore);
    // The phone wins when both match someone.
    const v3 = await visit();
    expect(
      await sys(chatIdentify, {
        workspaceId: wsId,
        visitorId: v3.visitorId,
        phone,
        email: eveEmail,
      }),
    ).toMatchObject({ personId: linda });
  });

  it('adds a customer when nobody matches, and ticking the texts box never overrides STOP', async () => {
    const phone = nextPhone();
    const { visitorId } = await visit();
    const made = await sysFull(chatIdentify, {
      workspaceId: wsId,
      visitorId,
      name: 'Mary Ann Smith',
      phone,
      smsConsent: true,
    });
    expect(made.output).toMatchObject({
      conversationId: null,
      personCreated: true,
      linkedNow: true,
      smsOptedIn: true,
    });
    expect(await personRow(made.output.personId!)).toMatchObject({
      firstName: 'Mary Ann',
      lastName: 'Smith',
      phoneE164: phone,
      source: 'Website chat',
      smsConsent: 'opted_in',
      smsConsentSource: 'chat_widget',
    });
    expect((await eventsOf(made.eventIds)).map((e) => e.type).sort()).toEqual([
      'chat.visitor_identified',
      'person.created',
    ]);
    // Her first message opens a chat already linked to her, with a timeline entry.
    const said = await say(visitorId, 'Hi, it’s Mary Ann');
    expect((await conv(said.conversationId)).personId).toBe(made.output.personId);
    const entries = await admin()
      .select({ kind: activities.kind, subtype: activities.subtype, body: activities.body })
      .from(activities)
      .where(and(eq(activities.personId, made.output.personId!), eq(activities.kind, 'chat')));
    expect(entries).toEqual([{ kind: 'chat', subtype: 'inbound', body: 'Hi, it’s Mary Ann' }]);

    // A number that texted STOP isn't opted in by a ticked box.
    const stopped = nextPhone();
    await admin().insert(optOuts).values({
      workspaceId: wsId,
      counterpartE164: stopped,
      optedOut: true,
      source: 'keyword',
      optedOutAt: new Date(),
    });
    const v2 = await visit();
    const stan = await sys(chatIdentify, {
      workspaceId: wsId,
      visitorId: v2.visitorId,
      name: 'Stan',
      phone: stopped,
      smsConsent: true,
    });
    expect(stan).toMatchObject({ personCreated: true, smsOptedIn: false });
    expect((await personRow(stan.personId!)).smsConsent).toBe('unknown');
    // A customer who opted out stays opted out.
    const olgaPhone = nextPhone();
    const olga = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Olga', phone: olgaPhone, ignoreDuplicates: true },
      owner,
    );
    await admin()
      .update(people)
      .set({ smsConsent: 'opted_out', smsConsentSource: 'keyword', smsConsentAt: new Date() })
      .where(eq(people.id, olga.personId));
    const olgaBefore = await personRow(olga.personId);
    const v3 = await visit();
    expect(
      await sys(chatIdentify, {
        workspaceId: wsId,
        visitorId: v3.visitorId,
        phone: olgaPhone,
        smsConsent: true,
      }),
    ).toMatchObject({ personId: olga.personId, personCreated: false, smsOptedIn: false });
    expect(await personRow(olga.personId)).toEqual(olgaBefore);

    // A name alone is kept on the visitor, with no customer yet; a contact with no name gets a stand-in.
    const v4 = await visit();
    expect(
      await sys(chatIdentify, {
        workspaceId: wsId,
        visitorId: v4.visitorId,
        name: 'Just Browsing',
      }),
    ).toMatchObject({ personId: null, personCreated: false, linkedNow: false });
    expect((await visitorRow(v4.visitorId)).name).toBe('Just Browsing');
    const v5 = await visit();
    const anon = await sys(chatIdentify, {
      workspaceId: wsId,
      visitorId: v5.visitorId,
      email: `anon-${randomUUID().slice(0, 6)}@example.com`,
    });
    expect(await personRow(anon.personId!)).toMatchObject({
      firstName: 'Website visitor',
      lastName: '',
    });
    // A blocked visitor can't say who they are.
    await run(chatBlockVisitor, { workspaceId: wsId, visitorId: v5.visitorId }, member);
    await expectHfos(
      () => sys(chatIdentify, { workspaceId: wsId, visitorId: v5.visitorId, name: 'Again' }),
      'forbidden',
      'visitor_blocked',
    );
  });
});

describe('chats in the inbox', () => {
  it('shows what the visitor typed, where they are and whether they’re here, and never a token hash', async () => {
    const phone = nextPhone();
    const { personId: tom } = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Tom', lastName: 'Reyes', phone, ignoreDuplicates: true },
      owner,
    );
    const { visitorId } = await visit({ page: '/services/ac-tune-up' });
    const { conversationId } = await say(visitorId, 'Is anyone there?');
    await sys(chatIdentify, { workspaceId: wsId, visitorId, name: 'Tommy', phone });
    const got = await ask(conversationGet, { workspaceId: wsId, conversationId }, member);
    expect(got.conversation).toMatchObject({
      channel: 'chat',
      counterpartDisplay: 'Tommy',
      person: { id: tom, fullName: 'Tom Reyes' },
    });
    expect(got.canText).toEqual({ ok: false, reason: 'chat_channel' });
    // Exactly these fields: what they typed ("Said their name is …"), never a token hash or hashed IP.
    expect(got.chat).toEqual({
      visitorId,
      widgetId,
      site: 'lonestarhvac.com',
      name: 'Tommy',
      phone: formatPhone(phone),
      phoneE164: phone,
      email: null,
      matchedOn: 'phone',
      pagePath: '/services/ac-tune-up',
      lastSeenAt: expect.any(String),
      onSiteNow: true,
      blocked: false,
      networkBlockedUntil: null,
    });
    await rows(
      admin(),
      sql`update app.chat_visitors set last_seen_at = now() - interval '3 minutes' where id = ${visitorId}`,
    );
    expect(
      (await ask(conversationGet, { workspaceId: wsId, conversationId }, member)).chat!.onSiteNow,
    ).toBe(false);

    // The chat filter, and search by the name a visitor typed.
    const chats = await ask(inboxList, { workspaceId: wsId, channel: 'chat' }, member);
    expect(chats.items.every((i) => i.channel === 'chat')).toBe(true);
    expect(chats.items.map((i) => i.id)).toContain(conversationId);
    const texts = await ask(inboxList, { workspaceId: wsId, channel: 'sms' }, member);
    expect(texts.items.map((i) => i.id)).not.toContain(conversationId);
    const shy = await visit();
    await sys(chatIdentify, { workspaceId: wsId, visitorId: shy.visitorId, name: 'Priscilla Q' });
    const shyChat = await say(shy.visitorId, 'Hello');
    const found = await ask(inboxList, { workspaceId: wsId, q: 'priscilla' }, member);
    expect(found.items.map((i) => [i.id, i.counterpartDisplay])).toContainEqual([
      shyChat.conversationId,
      'Priscilla Q',
    ]);
    const nameless = await say((await visit()).visitorId, 'hi');
    expect(
      (
        await ask(
          conversationGet,
          { workspaceId: wsId, conversationId: nameless.conversationId },
          member,
        )
      ).conversation.counterpartDisplay,
    ).toBe('Website visitor');

    // The thread shows chat messages, and a person replies in the chat.
    const reply = await run(
      messageSend,
      {
        workspaceId: wsId,
        conversationId,
        channel: 'chat',
        body: 'Hi Tom, Marco here.',
        clientId: randomUUID(),
      },
      member,
    );
    expect(reply.status).toBe('queued');
    const thread = await ask(conversationThread, { workspaceId: wsId, conversationId }, member);
    expect(thread.items.map((i) => [i.direction, i.channel, i.body])).toEqual([
      ['outbound', 'chat', 'Hi Tom, Marco here.'],
      ['inbound', 'chat', 'Is anyone there?'],
    ]);
  });

  it('lets people who work the inbox block and unblock a visitor, and their network for 7 days', async () => {
    const ip = hash();
    const { visitorId } = await visit({ ip });
    const { conversationId } = await say(visitorId, 'spam spam spam');
    const blocked = await runFull(
      chatBlockVisitor,
      { workspaceId: wsId, visitorId, network: true },
      member,
    );
    expect(blocked.output).toMatchObject({
      visitorId,
      blockedAt: expect.any(String),
      networkBlockedUntil: expect.any(String),
    });
    const days = (Date.parse(blocked.output.networkBlockedUntil!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    expect(await eventsOf(blocked.eventIds)).toEqual([
      {
        type: 'chat.visitor_blocked',
        entityId: visitorId,
        payload: expect.objectContaining({ visitorId, conversationId, network: true }),
      },
    ]);
    const chatOf = async () =>
      (await ask(conversationGet, { workspaceId: wsId, conversationId }, member)).chat;
    expect(await chatOf()).toMatchObject({
      blocked: true,
      networkBlockedUntil: blocked.output.networkBlockedUntil,
    });
    // Blocking again changes nothing.
    expect(
      (await runFull(chatBlockVisitor, { workspaceId: wsId, visitorId, network: true }, member))
        .eventIds,
    ).toEqual([]);
    const unblocked = await runFull(chatUnblockVisitor, { workspaceId: wsId, visitorId }, member);
    expect((await eventsOf(unblocked.eventIds)).map((e) => e.type)).toEqual([
      'chat.visitor_unblocked',
    ]);
    expect(await chatOf()).toMatchObject({ blocked: false, networkBlockedUntil: null });
    // With no hashed IP on file, only the visitor is blocked.
    const noIp = await visit();
    expect(
      (
        await run(
          chatBlockVisitor,
          { workspaceId: wsId, visitorId: noIp.visitorId, network: true },
          member,
        )
      ).networkBlockedUntil,
    ).toBeNull();
    expect((await visitorRow(noIp.visitorId)).blockedAt).not.toBeNull();
    // Only this business's team.
    await expectHfos(
      () => run(chatBlockVisitor, { workspaceId: wsId, visitorId }, outsider),
      'not_found',
    );
  });
});
