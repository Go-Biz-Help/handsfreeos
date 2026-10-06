/**
 * Facebook Messenger and Instagram direct messages on the local database (20261025000200): connecting a business's
 * Pages and Instagram accounts (no token ever reaches a person), what comes in from them (a stranger becomes a
 * customer and a lead, Meta sending something twice records it once), replies within Meta's window, receipts,
 * edits and messages taken back, and where each customer came from: every ad or link a touch of its own, never
 * written over their source.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  activities,
  ads,
  attributionTouches,
  conversations,
  leads,
  messages,
  metaAccounts,
  people,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
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
  adResolve,
  attributionList,
  conversationGet,
  conversationThread,
  messageSend,
  messageUpdateStatus,
  metaAccountConnect,
  metaAccountDisconnect,
  metaAccountList,
  metaConnectionActivate,
  metaConnectionConnect,
  metaMessageEdit,
  metaMessageReceipt,
  metaMessageReceive,
  organizationCreate,
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
let member: TestUser;
let otherOwner: TestUser;
let wsId: string;
let orgId: string;
let otherWsId: string;
let otherOrgId: string;
let connectionId: string;
/** Lone Star HVAC's Facebook Page and its Instagram account, as Meta numbers them: new each run, since a Page is
 * answered by one business at a time and the database outlives a run. */
const PAGE = String(2_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
const INSTAGRAM = String(3_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
let pageId: string;
let instagramId: string;

const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const systemOf = (workspaceId: string, organizationId: string): SystemActor => ({
  type: 'system',
  workspaceId,
  organizationId,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  actor: SystemActor = systemOf(wsId, orgId),
) => executeCommand(worker(), cmd, input, actor, meta('worker')).then((r) => r.output);

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

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
let seq = 0;
const nextMid = () => `m_test_${Date.now()}_${seq++}`;

/** A message from somebody to the Page, as the worker hands it over. */
const write = (
  scopedId: string,
  over: Record<string, unknown> = {},
  accountId: string = pageId,
) => {
  const mid = (over['mid'] as string | undefined) ?? nextMid();
  return sys(metaMessageReceive, {
    workspaceId: wsId,
    accountId,
    kind: 'message',
    scopedId,
    mid,
    eventKey: `evt:${mid}`,
    text: 'Hi there',
    occurredAt: new Date().toISOString(),
    ...over,
  });
};

const adReferral = (adId: string, adTitle = 'Spring tune-up special') => ({
  source: 'ADS',
  type: 'OPEN_THREAD',
  ref: null,
  adId,
  adTitle,
  photoUrl: 'https://scontent.example/ad.jpg',
  raw: { source: 'ADS', type: 'OPEN_THREAD', ad_id: adId },
});

async function conv(id: string) {
  const [c] = await admin().select().from(conversations).where(eq(conversations.id, id));
  return c!;
}
async function message(id: string) {
  const [m] = await admin().select().from(messages).where(eq(messages.id, id));
  return m!;
}

beforeAll(async () => {
  [owner, member, otherOwner] = await Promise.all([
    createTestUser('social-owner', { fullName: 'Dale Owner' }),
    createTestUser('social-member', { fullName: 'Marco Member' }),
    createTestUser('social-other-owner', { fullName: 'Rita Elsewhere' }),
  ]);
  const org = await run(organizationCreate, { businessName: 'Lone Star HVAC' }, owner);
  wsId = org.workspaceId;
  orgId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${member.id}, 'member')`,
  );
  const other = await run(organizationCreate, { businessName: 'Gulf Coast Cooling' }, otherOwner);
  otherWsId = other.workspaceId;
  otherOrgId = other.organizationId;

  // The owner presses Connect; the worker finishes the sign-in and connects what they picked.
  const started = await run(metaConnectionConnect, { workspaceId: wsId }, owner);
  connectionId = started.connectionId;
  await sys(metaConnectionActivate, {
    workspaceId: wsId,
    connectionId,
    facebookUserId: '1001',
    facebookUserName: 'Dale Owner',
    scopes: ['pages_messaging', 'instagram_manage_messages', 'ads_read'],
    tokenEnc: 'sealed:user-token-for-tests',
    tokenKeyId: 'test',
    tokenExpiresAt: null,
  });
  pageId = (
    await sys(metaAccountConnect, {
      workspaceId: wsId,
      connectionId,
      platform: 'facebook',
      externalId: PAGE,
      pageId: PAGE,
      name: 'Lone Star HVAC',
      tokenEnc: 'sealed:page-token-for-tests',
      tokenKeyId: 'test',
      subscribed: true,
    })
  ).accountId;
  instagramId = (
    await sys(metaAccountConnect, {
      workspaceId: wsId,
      connectionId,
      platform: 'instagram',
      externalId: INSTAGRAM,
      pageId: PAGE,
      name: 'Lone Star HVAC',
      username: 'lonestarhvac',
      tokenEnc: 'sealed:page-token-for-tests',
      tokenKeyId: 'test',
      subscribed: true,
    })
  ).accountId;
});
afterAll(closeTestDbs);

describe('connecting Pages and Instagram accounts', () => {
  it('lists what is connected to owners, without a token anywhere', async () => {
    const out = await ask(metaAccountList, { workspaceId: wsId }, owner);
    expect(out.accounts.map((a) => [a.platform, a.name, a.username, a.status])).toEqual([
      ['facebook', 'Lone Star HVAC', null, 'active'],
      ['instagram', 'Lone Star HVAC', 'lonestarhvac', 'active'],
    ]);
    expect(out.connections).toEqual([
      expect.objectContaining({
        id: connectionId,
        status: 'connected',
        facebookUserName: 'Dale Owner',
        connectedBy: { id: owner.id, fullName: 'Dale Owner' },
        readsAds: true,
      }),
    ]);
    expect(JSON.stringify(out)).not.toContain('sealed:');
  });

  it('keeps tokens away from people even when they ask the database directly', async () => {
    await expect(
      rows(api(), sql`select token_enc from app.meta_accounts where id = ${pageId}`),
    ).rejects.toThrow();
  });

  it('lets only people who manage channels see the list', async () => {
    await expectHfos(() => ask(metaAccountList, { workspaceId: wsId }, member), 'forbidden');
  });

  it('refuses a Page another business already answers, and says how to fix it', async () => {
    const started = await run(metaConnectionConnect, { workspaceId: otherWsId }, otherOwner);
    const elsewhere = systemOf(otherWsId, otherOrgId);
    await sys(
      metaConnectionActivate,
      {
        workspaceId: otherWsId,
        connectionId: started.connectionId,
        facebookUserId: '1002',
        facebookUserName: 'Rita Elsewhere',
        scopes: ['pages_messaging'],
        tokenEnc: 'sealed:other-user-token',
        tokenKeyId: 'test',
        tokenExpiresAt: null,
      },
      elsewhere,
    );
    const err = await expectHfos(
      () =>
        sys(
          metaAccountConnect,
          {
            workspaceId: otherWsId,
            connectionId: started.connectionId,
            platform: 'facebook',
            externalId: PAGE,
            pageId: PAGE,
            name: 'Lone Star HVAC',
            tokenEnc: 'sealed:other-page-token',
            tokenKeyId: 'test',
            subscribed: true,
          },
          elsewhere,
        ),
      'rule_violation',
      'meta_account_elsewhere',
    );
    expect(err.message).toContain('Disconnect it there first');
  });
});

describe('a stranger writing from an ad', () => {
  let first: Awaited<ReturnType<typeof write>>;
  const scoped = 'PSID100';

  beforeAll(async () => {
    first = await write(scoped, {
      text: 'Do you service Trane units?',
      referral: adReferral('120200000001'),
      profile: { name: 'Maria Lopez', username: null },
    });
  });

  it('becomes a customer and a lead, in a Messenger conversation on the Page', async () => {
    expect(first.outcome).toBe('recorded');
    const c = await conv(first.conversationId!);
    expect(c).toMatchObject({
      channel: 'messenger',
      counterpart: `messenger:${PAGE}:${scoped}`,
      metaAccountId: pageId,
      personId: first.personId,
      unreadCount: 1,
      lastPreview: 'Do you service Trane units?',
    });
    const [p] = await admin().select().from(people).where(eq(people.id, first.personId!));
    expect(p).toMatchObject({
      firstName: 'Maria',
      lastName: 'Lopez',
      source: 'Facebook Messenger',
    });
    const [lead] = await admin().select().from(leads).where(eq(leads.personId, first.personId!));
    expect(lead?.title).toBe('Maria Lopez (Facebook ad)');
  });

  it('keeps the ad as a touch that started the conversation, and asks Meta about the ad once', async () => {
    const [t] = await admin()
      .select()
      .from(attributionTouches)
      .where(eq(attributionTouches.id, first.touchId!));
    expect(t).toMatchObject({
      kind: 'started',
      platform: 'facebook',
      channel: 'messenger',
      source: 'ADS',
      adId: '120200000001',
      adTitle: 'Spring tune-up special',
      personId: first.personId,
      conversationId: first.conversationId,
      messageId: first.messageId,
    });
    expect(t!.leadId).not.toBeNull();
    const [ad] = await admin().select().from(ads).where(eq(ads.id, t!.adRefId!));
    expect(ad).toMatchObject({ externalId: '120200000001', status: 'pending' });
    const jobs = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs where kind = 'meta.resolve_ad'
            and payload ->> 'adId' = ${ad!.id}`,
    );
    expect(jobs[0]!.n).toBe(1);
    expect((await message(first.messageId!)).social).toMatchObject({ touchId: first.touchId });
  });

  it('records a message Meta sends twice once', async () => {
    const again = await write(scoped, {
      mid: (await message(first.messageId!)).providerMessageId,
      text: 'Do you service Trane units?',
    });
    expect(again).toMatchObject({ outcome: 'duplicate', messageId: first.messageId });
  });

  it('keeps a later ad as a touch of its own, and never writes over where they came from', async () => {
    const back = await sys(metaMessageReceive, {
      workspaceId: wsId,
      accountId: pageId,
      kind: 'referral',
      scopedId: scoped,
      eventKey: `ref:${randomUUID()}`,
      referral: adReferral('120200000002', 'Free filter with every tune-up'),
      occurredAt: new Date().toISOString(),
    });
    expect(back.outcome).toBe('recorded');
    const [t] = await admin()
      .select()
      .from(attributionTouches)
      .where(eq(attributionTouches.id, back.touchId!));
    expect(t).toMatchObject({ kind: 'returned', adId: '120200000002', messageId: null });
    const [p] = await admin().select().from(people).where(eq(people.id, first.personId!));
    expect(p!.source).toBe('Facebook Messenger');

    // What they write next, from the same visit, joins that touch rather than making another.
    const said = await write(scoped, {
      text: 'Is the filter deal still on?',
      referral: adReferral('120200000002', 'Free filter with every tune-up'),
    });
    expect(said.touchId).toBe(back.touchId);
    expect((await message(said.messageId!)).social).toMatchObject({ touchId: back.touchId });
    const [joined] = await admin()
      .select()
      .from(attributionTouches)
      .where(eq(attributionTouches.id, back.touchId!));
    expect(joined!.messageId).toBe(said.messageId);

    const list = await ask(attributionList, { workspaceId: wsId, personId: first.personId }, owner);
    expect(list.total).toBe(2);
    expect(list.first).toBe(first.touchId);
    expect(list.latest).toBe(back.touchId);
    expect(list.touches.map((x) => x.adId)).toEqual(['120200000002', '120200000001']);
  });

  it('shows the campaign, ad set and creative once Meta says what the ad is', async () => {
    const [t] = await admin()
      .select({ adRefId: attributionTouches.adRefId })
      .from(attributionTouches)
      .where(eq(attributionTouches.id, first.touchId!));
    await sys(adResolve, {
      workspaceId: wsId,
      adId: t!.adRefId,
      outcome: 'resolved',
      details: {
        name: 'Spring tune-up · carousel',
        adAccountId: 'act_555',
        adsetId: '23850000000001',
        adsetName: 'Austin homeowners',
        campaignId: '23850000000002',
        campaignName: 'Spring 2026',
        campaignObjective: 'OUTCOME_ENGAGEMENT',
        creativeId: '23850000000003',
        creativeName: 'Tune-up creative',
        creativeTitle: '$79 spring tune-up',
        creativeBody: 'Book before the heat hits.',
        creativeThumbnailUrl: null,
        creativeLink: null,
        callToAction: 'MESSAGE_PAGE',
        effectiveStatus: 'ACTIVE',
        platforms: ['facebook', 'instagram'],
        raw: { id: '120200000001' },
      },
    });
    const list = await ask(
      attributionList,
      { workspaceId: wsId, conversationId: first.conversationId },
      owner,
    );
    const firstTouch = list.touches.find((x) => x.id === first.touchId);
    expect(firstTouch?.ad).toMatchObject({
      status: 'resolved',
      name: 'Spring tune-up · carousel',
      campaignName: 'Spring 2026',
      adsetName: 'Austin homeowners',
      creativeTitle: '$79 spring tune-up',
    });
    expect(firstTouch?.accountName).toBe('Lone Star HVAC');
  });

  it('says who they are and how long a reply can go, on the conversation', async () => {
    const out = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: first.conversationId },
      owner,
    );
    expect(out.social).toMatchObject({
      account: { id: pageId, platform: 'facebook', label: 'Lone Star HVAC', status: 'active' },
      contact: { name: 'Maria Lopez' },
      everWrote: true,
      window: { open: true, peopleOnly: false },
      textLimit: 2000,
    });
  });
});

describe('answering', () => {
  const scoped = 'PSID200';
  let conversationId: string;

  beforeAll(async () => {
    const r = await write(scoped, {
      text: 'My AC is blowing warm air',
      profile: { name: 'Sam Patel', username: null },
    });
    conversationId = r.conversationId!;
  });

  it('queues a reply on the Page while the customer wrote within a day', async () => {
    const sent = await run(
      messageSend,
      { workspaceId: wsId, conversationId, channel: 'messenger', body: 'We can come by at 3.' },
      member,
    );
    const m = await message(sent.messageId);
    expect(m).toMatchObject({
      channel: 'messenger',
      direction: 'outbound',
      status: 'queued',
      provider: 'meta',
      fromAddress: PAGE,
      toAddresses: [`messenger:${PAGE}:${scoped}`],
    });
  });

  it('refuses a reply on the wrong channel for the conversation', async () => {
    await expectHfos(
      () =>
        run(
          messageSend,
          { workspaceId: wsId, conversationId, channel: 'instagram', body: 'Hello' },
          member,
        ),
      'rule_violation',
      'channel_mismatch',
    );
  });

  it('refuses a reply more than a day after they last wrote, and says when it can go', async () => {
    await admin()
      .update(conversations)
      .set({ lastInboundAt: new Date(ago(30 * HOUR)) })
      .where(eq(conversations.id, conversationId));
    const err = await expectHfos(
      () =>
        run(
          messageSend,
          { workspaceId: wsId, conversationId, channel: 'messenger', body: 'Still need help?' },
          member,
        ),
      'rule_violation',
      'social_window_closed',
    );
    expect(err.message).toContain('Sam Patel');
    // With Meta's Human Agent tag a person may still answer for a week.
    await admin().update(metaAccounts).set({ humanAgent: true }).where(eq(metaAccounts.id, pageId));
    const sent = await run(
      messageSend,
      { workspaceId: wsId, conversationId, channel: 'messenger', body: 'Still need help?' },
      member,
    );
    expect((await message(sent.messageId)).status).toBe('queued');
    await admin()
      .update(metaAccounts)
      .set({ humanAgent: false })
      .where(eq(metaAccounts.id, pageId));
    await admin()
      .update(conversations)
      .set({ lastInboundAt: new Date() })
      .where(eq(conversations.id, conversationId));
  });

  it('marks a sent reply delivered and then read, from Messenger’s receipts', async () => {
    const sent = await run(
      messageSend,
      { workspaceId: wsId, conversationId, channel: 'messenger', body: 'On our way.' },
      member,
    );
    const mid = nextMid();
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      providerMessageId: mid,
      providerPartIds: [mid],
      status: 'sent',
    });
    // Meta echoes the reply back: it's ours, already in the thread.
    const echo = await sys(metaMessageReceive, {
      workspaceId: wsId,
      accountId: pageId,
      kind: 'echo',
      scopedId: scoped,
      mid,
      eventKey: `evt:${mid}`,
      text: 'On our way.',
      occurredAt: new Date().toISOString(),
    });
    expect(echo).toMatchObject({ outcome: 'duplicate', messageId: sent.messageId });

    await sys(metaMessageReceipt, {
      workspaceId: wsId,
      accountId: pageId,
      scopedId: scoped,
      kind: 'delivered',
      watermark: new Date(Date.now() + 1000).toISOString(),
    });
    expect((await message(sent.messageId)).status).toBe('delivered');
    await sys(metaMessageReceipt, {
      workspaceId: wsId,
      accountId: pageId,
      scopedId: scoped,
      kind: 'read',
      watermark: new Date(Date.now() + 1000).toISOString(),
    });
    expect((await message(sent.messageId)).status).toBe('read');
  });

  it('keeps a reply somebody wrote in Facebook’s own inbox, marked as written there', async () => {
    const mid = nextMid();
    const echo = await sys(metaMessageReceive, {
      workspaceId: wsId,
      accountId: pageId,
      kind: 'echo',
      scopedId: scoped,
      mid,
      eventKey: `evt:${mid}`,
      text: 'Answered from the Facebook app',
      occurredAt: new Date().toISOString(),
    });
    expect(echo.outcome).toBe('recorded');
    const m = await message(echo.messageId!);
    expect(m).toMatchObject({ direction: 'outbound', status: 'sent', social: { elsewhere: true } });
    expect((await conv(conversationId)).awaitingReplySince).toBeNull();
  });

  it('keeps the newest words of an edit, and nothing of a message taken back', async () => {
    const mid = nextMid();
    const said = await write(scoped, { mid, text: 'Tuesday works' });
    await sys(metaMessageEdit, {
      workspaceId: wsId,
      accountId: pageId,
      mid,
      text: 'Wednesday works',
      occurredAt: new Date().toISOString(),
    });
    let m = await message(said.messageId!);
    expect(m.bodyText).toBe('Wednesday works');
    expect(m.editedAt).not.toBeNull();

    await sys(metaMessageEdit, {
      workspaceId: wsId,
      accountId: pageId,
      mid,
      unsent: true,
      occurredAt: new Date().toISOString(),
    });
    m = await message(said.messageId!);
    expect(m).toMatchObject({ bodyText: null, media: [] });
    expect(m.unsentAt).not.toBeNull();
    const [a] = await admin().select().from(activities).where(eq(activities.id, m.activityId!));
    expect(a!.body).toBeNull();

    const thread = await ask(conversationThread, { workspaceId: wsId, conversationId }, owner);
    const item = thread.items.find((i) => i.id === said.messageId);
    expect(item).toMatchObject({ body: null, unsentAt: expect.any(String) });
  });

  it('files an Instagram message in its own Instagram conversation', async () => {
    const r = await write(
      'IGSID300',
      { text: 'Saw your reel!', profile: { name: null, username: 'jordan.builds' } },
      instagramId,
    );
    const c = await conv(r.conversationId!);
    expect(c).toMatchObject({
      channel: 'instagram',
      counterpart: `instagram:${INSTAGRAM}:IGSID300`,
    });
    const out = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: r.conversationId },
      owner,
    );
    expect(out.social).toMatchObject({
      account: { platform: 'instagram', label: '@lonestarhvac' },
      contact: { name: '@jordan.builds', username: 'jordan.builds' },
      textLimit: 1000,
    });
  });
});

describe('a Page that stops answering here', () => {
  it('refuses replies and ignores new messages once it is disconnected', async () => {
    const r = await write('PSID400', {
      text: 'Hello?',
      profile: { name: 'Lee Chen', username: null },
    });
    await run(metaAccountDisconnect, { workspaceId: wsId, accountId: pageId }, owner);
    const err = await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            conversationId: r.conversationId,
            channel: 'messenger',
            body: 'Hi Lee',
          },
          owner,
        ),
      'rule_violation',
      'social_account_unavailable',
    );
    expect(err.message).toContain('Settings → Facebook & Instagram');
    const later = await write('PSID400', { text: 'Anyone there?' });
    expect(later.outcome).toBe('ignored');

    // Connecting it again picks its threads up where they were.
    const again = await sys(metaAccountConnect, {
      workspaceId: wsId,
      connectionId,
      platform: 'facebook',
      externalId: PAGE,
      pageId: PAGE,
      name: 'Lone Star HVAC',
      tokenEnc: 'sealed:page-token-for-tests',
      tokenKeyId: 'test',
      subscribed: true,
    });
    expect(again).toEqual({ accountId: pageId, reconnected: true });
    const back = await write('PSID400', { text: 'Anyone there?' });
    expect(back).toMatchObject({ outcome: 'recorded', conversationId: r.conversationId });
    const [m] = await admin()
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.conversationId, r.conversationId!)));
    expect(m!.n).toBe(2);
  });
});
