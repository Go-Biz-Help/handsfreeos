/**
 * Facebook Messenger and Instagram direct messages (20261025000200), through the worker's own routes, processors,
 * handlers and jobs, on the real database, against the stand-in Meta.
 *
 * What's worth holding:
 *   - a sign-in that manages several Pages asks which, and connects only those; one Page connects straight away;
 *   - Meta's webhooks are taken only when Meta signed them, and an event Meta sends twice is kept once;
 *   - a stranger who writes becomes a customer and a lead, named as Facebook names them;
 *   - an ad that brought somebody is a touch of its own, every time, and its campaign is looked up at Meta;
 *   - photos are copied off Meta, and go when the customer takes the message back;
 *   - a reply goes out through the Page and comes back as an echo that isn't kept twice; receipts move it on;
 *   - a reply that only partly went sends the rest when it's tried again, never the part that went;
 *   - a Page whose sign-in stops working says so, and connecting again mends it;
 *   - removing the app on Facebook, or asking for deletion, stops the sign-in; letting a Page go stops Meta sending.
 */
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import {
  attributionList,
  executeCommand,
  executeQuery,
  messageRetry,
  messageSend,
  metaAccountDisconnect,
  metaConnectionConnect,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { conversationContact } from '../src/chat/store';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { FAKE_META_APP_ID, FAKE_META_APP_SECRET } from '../src/social/fake';
import { MetaError } from '../src/social/graph';
import { finishSignIn, pickAccounts, testTokenVerifier, type Finished } from './finish-sign-in';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let workspaceId: string;
let s: TestServices;
let app: FastifyInstance;

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actor(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actor(owner), meta()) as Promise<T>;
const get = (url: string) => app.inject({ method: 'GET', url });
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> =>
  (await rows<T>(admin(), q))[0]!;

/** A Meta id: digits, never starting with 0. Fresh each run, since every run shares one database. */
const digits = (n: number) =>
  String(randomInt(1, 10)) + Array.from({ length: n - 1 }, () => randomInt(0, 10)).join('');
const fbUser = digits(15);
const pageA = digits(15);
const igA = digits(17);
const pageB = digits(15);
const maria = digits(16);
const igCustomer = digits(17);

const runner = `vitest-social-${process.pid}`;

/** Everything this business has waiting (events, Meta’s stored webhooks and its jobs), until it’s quiet. */
async function drain(limit = 40): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await admin().execute(
      sql`update app.webhook_deliveries set locked_at = now(), locked_by = ${runner}, next_attempt_at = now()
          where workspace_id = ${workspaceId}::uuid and status = 'pending'`,
    );
    const delivered = await processDeliveries({
      ...s,
      processors,
      workerId: runner,
      batchSize: 50,
      reservedOnly: true,
    });
    await admin().execute(
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}, next_attempt_at = now()
          where status = 'pending' and event_id in (select id from app.events
            where workspace_id = ${workspaceId}::uuid)`,
    );
    const events = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 50,
      reservedOnly: true,
    });
    await admin().execute(
      sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
          where workspace_id = ${workspaceId}::uuid and status = 'pending' and kind like 'meta.%'`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 50,
      reservedOnly: true,
    });
    if (done.claimed === 0 && events.claimed === 0 && delivered.claimed === 0) return;
  }
}

/** The whole Facebook sign-in, through the stand-in's pages and the app finishing it, as a browser walks it. */
async function connect(
  opts: { user?: string; instagram?: boolean; ads?: boolean; messaging?: boolean } = {},
): Promise<Finished> {
  const { state } = await run<{ connectionId: string; state: string }>(metaConnectionConnect, {
    workspaceId,
  });
  const start = await get(`/oauth/facebook/start?state=${encodeURIComponent(state)}`);
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  expect(authorize.pathname).toBe('/oauth/fake/meta/authorize');
  const page = await get(`${authorize.pathname}${authorize.search}`);
  expect(page.statusCode).toBe(200);
  const approve = await get(
    `/oauth/fake/meta/approve?${new URLSearchParams({
      state,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      user: opts.user ?? fbUser,
      decision: 'allow',
      ...(opts.instagram === false ? {} : { instagram: '1' }),
      ...(opts.ads === false ? {} : { ads: '1' }),
      ...(opts.messaging === false ? {} : { messaging: '1' }),
    })}`,
  );
  const callback = new URL(String(approve.headers.location));
  expect(callback.pathname).toBe('/oauth/facebook/callback');
  return finishSignIn(
    app,
    await get(`${callback.pathname}${callback.search}`),
    await signInTestUser(owner),
  );
}

/** A webhook, signed the way Meta signs it (or not). */
function webhook(body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature ?? s.social.fake.sign(raw),
    },
    payload: raw,
  });
}

/** Meta's batch for one Page or Instagram account. */
const batch = (platform: 'facebook' | 'instagram', account: string, events: unknown[]) => ({
  object: platform === 'instagram' ? 'instagram' : 'page',
  entry: [{ id: account, time: Date.now(), messaging: events }],
});
const fromCustomer = (
  from: string,
  to: string,
  message: Record<string, unknown>,
  at = Date.now(),
) => ({
  sender: { id: from },
  recipient: { id: to },
  timestamp: at,
  message: { mid: `m_${randomUUID()}`, ...message },
});

const conversationOf = (counterpart: string) =>
  one<{ id: string; person_id: string | null; meta_account_id: string; unread_count: number }>(
    sql`select id, person_id, meta_account_id, unread_count from app.conversations
        where workspace_id = ${workspaceId}::uuid and counterpart = ${counterpart}`,
  );
const messagesIn = (conversationId: string) =>
  rows<{
    id: string;
    direction: string;
    status: string;
    body_text: string | null;
    provider_message_id: string | null;
    provider_part_ids: string[];
    error_code: string | null;
    media: { objectPath: string; contentType: string; bucket: string }[];
    social: Record<string, unknown>;
    unsent_at: string | null;
  }>(
    admin(),
    sql`select id, direction::text, status::text, body_text, provider_message_id, provider_part_ids, error_code,
          media, social, unsent_at
        from app.messages where conversation_id = ${conversationId}::uuid order by occurred_at, id`,
  );
const account = (platform: 'facebook' | 'instagram', externalId: string) =>
  one<{
    id: string;
    status: string;
    problem: string | null;
    token_enc: string | null;
    human_agent: boolean;
    subscribed_at: string | null;
  }>(
    sql`select id, status, problem, token_enc, human_agent, subscribed_at from app.meta_accounts
        where workspace_id = ${workspaceId}::uuid and platform = ${platform} and external_id = ${externalId}`,
  );

beforeAll(async () => {
  owner = await createTestUser('social-dana', { fullName: 'Dana Owner' });
  const org = await run<{ workspaceId: string }>(organizationCreate, {
    businessName: 'Bright Plumbing',
    timezone: 'America/Chicago',
  });
  workspaceId = org.workspaceId;
  s = testServices();
  s.social.fake.addUser({
    id: fbUser,
    name: 'Dana Owner',
    pages: [
      {
        id: pageA,
        name: 'Bright Plumbing',
        instagram: { id: igA, username: 'brightplumbing', name: 'Bright Plumbing' },
      },
      { id: pageB, name: 'Bright Plumbing North' },
    ],
  });
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('connecting Facebook', () => {
  it('asks which Pages when the sign-in manages several, and connects only the ones picked', async () => {
    const asked = await connect();
    expect(asked.pick?.title).toBe('Which Pages should answer here?');
    expect(asked.pick?.options.map((o) => [o.id, o.checked, o.disabled])).toEqual([
      [`facebook:${pageA}`, false, false],
      [`instagram:${igA}`, false, false],
      [`facebook:${pageB}`, false, false],
    ]);
    expect(asked.pick?.options[1]).toMatchObject({
      name: '@brightplumbing',
      parent: `facebook:${pageA}`,
    });

    const done = await pickAccounts(
      app,
      asked.pick!.answer,
      asked.handoff!,
      [`facebook:${pageA}`, `instagram:${igA}`],
      await signInTestUser(owner),
    );
    expect(done.status).toBe(302);
    const next = new URL(done.location!);
    expect(next.pathname).toBe(`/app/w/${workspaceId}/settings/facebook-instagram`);
    expect(Object.fromEntries(next.searchParams)).toEqual({
      meta: 'connected',
      facebook: '1',
      instagram: '1',
    });

    const page = await account('facebook', pageA);
    expect(page).toMatchObject({ status: 'active', human_agent: true });
    expect(page.token_enc).toBeTruthy();
    expect(page.subscribed_at).toBeTruthy();
    expect((await account('instagram', igA)).status).toBe('active');
    expect(
      await rows(
        admin(),
        sql`select 1 from app.meta_accounts where external_id = ${pageB} and workspace_id = ${workspaceId}::uuid`,
      ),
    ).toHaveLength(0);
    // Meta sends the Page's messages here, and the Instagram account's with them; not the Page left unpicked.
    expect(s.social.fake.subscribed()).toContain(pageA);
    expect(s.social.fake.subscribed()).not.toContain(pageB);
    const c = await one<{ status: string; facebook_user_name: string; scopes: string[] }>(
      sql`select status, facebook_user_name, scopes from app.meta_connections
          where workspace_id = ${workspaceId}::uuid and status = 'connected'`,
    );
    expect(c).toMatchObject({ status: 'connected', facebook_user_name: 'Dana Owner' });
    expect(c.scopes).toContain('ads_read');
  });

  it('turns away a sign-in that left the messaging permission unticked', async () => {
    const back = await connect({ messaging: false });
    expect(back.body).toContain('Some permissions were left unticked');
  });
});

describe('Meta’s webhooks', () => {
  it('answers Meta’s check with the verify token, and only with it', async () => {
    const ok = await get(
      `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${s.social.verifyToken}&hub.challenge=8675309`,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('8675309');
    const wrong = await get(
      '/webhooks/meta?hub.mode=subscribe&hub.verify_token=not-it&hub.challenge=8675309',
    );
    expect(wrong.statusCode).toBe(403);
  });

  it('refuses one Meta didn’t sign, and keeps one it sent twice once', async () => {
    const body = batch('facebook', pageA, [fromCustomer(maria, pageA, { text: 'Hello?' })]);
    const forged = await webhook(body, `sha256=${'0'.repeat(64)}`);
    expect(forged.statusCode).toBe(403);
    const first = await webhook(body);
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('EVENT_RECEIVED');
    await webhook(body);
    const kept = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.webhook_deliveries
          where workspace_id = ${workspaceId}::uuid and provider = 'meta'`,
    );
    expect(kept[0]!.n).toBe(1);
    // Nothing comes of a forged batch; the real one waits to be read, below.
    await admin().execute(
      sql`delete from app.webhook_deliveries where workspace_id = ${workspaceId}::uuid and provider = 'meta'`,
    );
  });
});

describe('a customer writes', () => {
  let conversationId: string;
  let firstTouch: string;

  it('makes a stranger from an ad a customer and a lead, and keeps the ad as a touch', async () => {
    s.social.fake.setProfile(maria, { name: 'Maria Lopez', username: null });
    const adId = digits(17);
    s.social.fake.setAd(adId, {
      name: 'Water heater flush · Messenger',
      adAccountId: '555',
      adsetId: `${adId}1`,
      adsetName: 'Homeowners nearby',
      campaignId: `${adId}2`,
      campaignName: 'Fall water heaters',
      campaignObjective: 'OUTCOME_ENGAGEMENT',
      creativeId: `${adId}3`,
      creativeName: 'Flush creative',
      creativeTitle: 'Is your water heater ready for winter?',
      creativeBody: 'Book a flush this week.',
      creativeThumbnailUrl: null,
      creativeLink: null,
      callToAction: 'MESSAGE_PAGE',
      effectiveStatus: 'ACTIVE',
      platforms: ['facebook', 'messenger'],
      raw: { id: adId },
    });
    const res = await webhook(
      batch('facebook', pageA, [
        fromCustomer(maria, pageA, {
          text: 'Hi, can you flush my water heater this week?',
          referral: {
            source: 'ADS',
            type: 'OPEN_THREAD',
            ad_id: adId,
            ads_context_data: { ad_title: 'Is your water heater ready?', photo_url: null },
          },
        }),
      ]),
    );
    expect(res.statusCode).toBe(200);
    await drain();

    const conv = await conversationOf(`messenger:${pageA}:${maria}`);
    conversationId = conv.id;
    expect(conv.person_id).toBeTruthy();
    const person = await one<{ first_name: string; last_name: string }>(
      sql`select first_name, last_name from app.people where id = ${conv.person_id}::uuid`,
    );
    expect(person).toEqual({ first_name: 'Maria', last_name: 'Lopez' });
    const leads = await rows<{ id: string }>(
      admin(),
      sql`select id from app.leads where person_id = ${conv.person_id}::uuid`,
    );
    expect(leads).toHaveLength(1);
    const [m] = await messagesIn(conv.id);
    expect(m).toMatchObject({
      direction: 'inbound',
      status: 'received',
      body_text: 'Hi, can you flush my water heater this week?',
    });

    const touches = await ask<{
      touches: {
        id: string;
        kind: string;
        platform: string;
        adId: string;
        ad: { status: string; campaignName: string; adsetName: string; name: string } | null;
      }[];
      first: string;
      total: number;
    }>(attributionList, { workspaceId, personId: conv.person_id });
    expect(touches.total).toBe(1);
    expect(touches.touches[0]).toMatchObject({
      kind: 'started',
      platform: 'facebook',
      adId,
      ad: {
        status: 'resolved',
        name: 'Water heater flush · Messenger',
        campaignName: 'Fall water heaters',
        adsetName: 'Homeowners nearby',
      },
    });
    firstTouch = touches.first;
  });

  it('keeps a second ad as a touch of its own, without touching the first', async () => {
    const second = digits(17);
    // Coming back from another ad, without writing yet: Meta's referral on its own.
    await webhook(
      batch('facebook', pageA, [
        {
          sender: { id: maria },
          recipient: { id: pageA },
          timestamp: Date.now(),
          referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: second },
        },
      ]),
    );
    await drain();
    const conv = await conversationOf(`messenger:${pageA}:${maria}`);
    const touches = await ask<{
      touches: { id: string; kind: string; adId: string; ad: { campaignName: string } | null }[];
      first: string;
      latest: string;
      total: number;
    }>(attributionList, { workspaceId, personId: conv.person_id });
    expect(touches.total).toBe(2);
    expect(touches.first).toBe(firstTouch);
    expect(touches.touches[0]).toMatchObject({ kind: 'returned', adId: second });
    // The stand-in's own campaign for an ad nobody set.
    expect(touches.touches[0]!.ad?.campaignName).toBe('Spring tune-ups');
    // Nothing to answer: no message came with it.
    expect(await messagesIn(conversationId)).toHaveLength(1);
  });

  it('copies a photo off Meta, and lets it go when the customer takes the message back', async () => {
    const url = 'https://lookaside.fbsbx.com/ig_messaging_cdn/photo-1';
    const photo = fromCustomer(maria, pageA, {
      attachments: [{ type: 'image', payload: { url } }],
    });
    await webhook(batch('facebook', pageA, [photo]));
    await drain();
    const withPhoto = (await messagesIn(conversationId)).at(-1)!;
    expect(withPhoto.media).toHaveLength(1);
    expect(withPhoto.media[0]).toMatchObject({ contentType: 'image/png', bucket: 'telephony' });
    const path = withPhoto.media[0]!.objectPath;
    expect(await s.store.exists('telephony', path)).toBe(true);

    await webhook(
      batch('facebook', pageA, [
        {
          sender: { id: maria },
          recipient: { id: pageA },
          timestamp: Date.now(),
          message: { mid: photo.message.mid, is_deleted: true },
        },
      ]),
    );
    await drain();
    const taken = (await messagesIn(conversationId)).at(-1)!;
    expect(taken).toMatchObject({ id: withPhoto.id, body_text: null, media: [] });
    expect(taken.unsent_at).toBeTruthy();
    expect(await s.store.exists('telephony', path)).toBe(false);
  });

  it('keeps an edit’s newest words', async () => {
    const said = fromCustomer(maria, pageA, { text: 'Tuesday works' });
    await webhook(batch('facebook', pageA, [said]));
    await drain();
    await webhook(
      batch('facebook', pageA, [
        {
          sender: { id: maria },
          recipient: { id: pageA },
          timestamp: Date.now(),
          message_edit: { mid: said.message.mid, text: 'Wednesday works better', num_edit: 1 },
        },
      ]),
    );
    await drain();
    expect((await messagesIn(conversationId)).at(-1)!.body_text).toBe('Wednesday works better');
  });

  it('files an Instagram message under the Instagram account, with their @handle', async () => {
    s.social.fake.setProfile(igCustomer, { name: null, username: 'sam.builds' });
    await webhook(
      batch('instagram', igA, [
        fromCustomer(igCustomer, igA, { text: 'Do you do tankless installs?' }),
      ]),
    );
    await drain();
    const conv = await conversationOf(`instagram:${igA}:${igCustomer}`);
    expect(conv.meta_account_id).toBe((await account('instagram', igA)).id);
    const contact = await one<{ username: string }>(
      sql`select username from app.meta_contacts where scoped_id = ${igCustomer} and workspace_id = ${workspaceId}::uuid`,
    );
    expect(contact.username).toBe('sam.builds');
    // Notifications and the team's emails name them by their @handle, never by the thread's key.
    const { organization_id } = await one<{ organization_id: string }>(
      sql`select organization_id from app.workspaces where id = ${workspaceId}::uuid`,
    );
    const named = await asWorker(s.db, { workspaceId, organizationId: organization_id }, (tx) =>
      conversationContact(tx, {
        id: conv.id,
        channel: 'instagram',
        counterpart: `instagram:${igA}:${igCustomer}`,
      }),
    );
    expect(named).toBe('@sam.builds');
  });
});

describe('answering', () => {
  let conversationId: string;

  it('sends a reply through the Page, and doesn’t keep Meta’s echo of it twice', async () => {
    conversationId = (await conversationOf(`messenger:${pageA}:${maria}`)).id;
    const { messageId } = await run<{ messageId: string }>(messageSend, {
      workspaceId,
      channel: 'messenger',
      conversationId,
      body: 'Yes! We have Wednesday at 10. Does that work?',
    });
    await drain();
    const sent = s.social.fake.sent().at(-1)!;
    expect(sent).toMatchObject({
      pageId: pageA,
      platform: 'facebook',
      recipientId: maria,
      tag: null,
      message: { text: 'Yes! We have Wednesday at 10. Does that work?' },
    });
    const before = await messagesIn(conversationId);
    const reply = before.find((m) => m.id === messageId)!;
    expect(reply).toMatchObject({
      status: 'sent',
      provider_message_id: sent.messageId,
      provider_part_ids: [sent.messageId],
    });

    // The echo, with our app's id; and Instagram's way, without one.
    const echo = (appId?: string) => ({
      sender: { id: pageA },
      recipient: { id: maria },
      timestamp: Date.now(),
      message: {
        mid: sent.messageId,
        is_echo: true,
        text: 'Yes! We have Wednesday at 10. Does that work?',
        ...(appId ? { app_id: appId } : {}),
      },
    });
    // Instagram's way first, without an app id: core knows the id as one of ours. Meta's own retry of it, with
    // ours on it, is the same event, and is stored once.
    await webhook(batch('facebook', pageA, [echo()]));
    await webhook(batch('facebook', pageA, [echo(FAKE_META_APP_ID)]));
    await drain();
    expect(await messagesIn(conversationId)).toHaveLength(before.length);
    // One sent here, said back with our app's id: set aside without a look.
    const other = s.social.fake.sent().at(-1)!;
    await webhook(
      batch('facebook', pageA, [
        {
          ...echo(FAKE_META_APP_ID),
          message: { ...echo(FAKE_META_APP_ID).message, mid: `${other.messageId}x` },
        },
      ]),
    );
    await drain();
    expect(await messagesIn(conversationId)).toHaveLength(before.length);

    // Delivered, then read: Messenger says so up to a moment.
    await webhook(
      batch('facebook', pageA, [
        {
          sender: { id: maria },
          recipient: { id: pageA },
          timestamp: Date.now(),
          delivery: { watermark: Date.now() },
        },
      ]),
    );
    await drain();
    expect((await messagesIn(conversationId)).find((m) => m.id === messageId)!.status).toBe(
      'delivered',
    );
    await webhook(
      batch('facebook', pageA, [
        {
          sender: { id: maria },
          recipient: { id: pageA },
          timestamp: Date.now(),
          read: { watermark: Date.now() },
        },
      ]),
    );
    await drain();
    expect((await messagesIn(conversationId)).find((m) => m.id === messageId)!.status).toBe('read');
  });

  it('keeps a reply the business wrote on Facebook itself, as theirs', async () => {
    const before = await messagesIn(conversationId);
    await webhook(
      batch('facebook', pageA, [
        {
          sender: { id: pageA },
          recipient: { id: maria },
          timestamp: Date.now(),
          message: {
            mid: `m_${randomUUID()}`,
            is_echo: true,
            app_id: '263902037430900',
            text: 'See you then!',
          },
        },
      ]),
    );
    await drain();
    const after = await messagesIn(conversationId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      direction: 'outbound',
      status: 'sent',
      body_text: 'See you then!',
      social: { elsewhere: true },
    });
  });

  it('sends the rest of a reply that only partly went, and never the part that did', async () => {
    const conv = await conversationOf(`messenger:${pageA}:${maria}`);
    const path = `${workspaceId}/${randomUUID()}.png`;
    await s.store.upload(
      'attachments',
      path,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
      'image/png',
    );
    const file = await one<{ id: string }>(
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes,
            status, created_by)
          values (${workspaceId}::uuid, 'person', ${conv.person_id}::uuid, ${path}, 'Quote.png', 'image/png', 68,
            'ready', ${owner.id}::uuid)
          returning id`,
    );
    const sentBefore = s.social.fake.sent().length;
    const { messageId } = await run<{ messageId: string }>(messageSend, {
      workspaceId,
      channel: 'messenger',
      conversationId,
      body: 'Here’s the quote we talked about.',
      attachmentFileIds: [file.id],
    });
    // The photo goes; the words are refused.
    const realSend = s.social.graph.send.bind(s.social.graph);
    let calls = 0;
    s.social.graph.send = async (input) => {
      calls++;
      if (calls === 2) throw new MetaError('(#100) Something went wrong', 'bad_request', 100);
      return realSend(input);
    };
    try {
      await drain();
    } finally {
      s.social.graph.send = realSend;
    }
    const failed = (await messagesIn(conversationId)).find((m) => m.id === messageId)!;
    expect(failed).toMatchObject({ status: 'failed', error_code: 'partial' });
    expect(failed.provider_part_ids).toHaveLength(1);
    expect(
      s.social.fake
        .sent()
        .slice(sentBefore)
        .map((x) => Object.keys(x.message)[0]),
    ).toEqual(['attachment']);

    await run(messageRetry, { workspaceId, messageId });
    await drain();
    const went = (await messagesIn(conversationId)).find((m) => m.id === messageId)!;
    expect(went.status).toBe('sent');
    expect(went.error_code).toBeNull();
    expect(went.provider_part_ids).toHaveLength(2);
    expect(went.provider_part_ids[0]).toBe(failed.provider_part_ids[0]);
    // The photo once, the words once.
    expect(
      s.social.fake
        .sent()
        .slice(sentBefore)
        .map((x) => Object.keys(x.message)[0]),
    ).toEqual(['attachment', 'text']);
  });

  it('answers late with the Human Agent tag, when a person writes it', async () => {
    await admin().execute(
      sql`update app.conversations set last_inbound_at = now() - interval '2 days'
          where id = ${conversationId}::uuid`,
    );
    await run(messageSend, {
      workspaceId,
      channel: 'messenger',
      conversationId,
      body: 'Just checking in about Wednesday.',
    });
    await drain();
    expect(s.social.fake.sent().at(-1)).toMatchObject({
      tag: 'HUMAN_AGENT',
      message: { text: 'Just checking in about Wednesday.' },
    });
    await admin().execute(
      sql`update app.conversations set last_inbound_at = now() where id = ${conversationId}::uuid`,
    );
  });

  it('marks the Page when its sign-in stops working, and connecting again mends it', async () => {
    s.social.fake.failNextSend(
      new MetaError(
        'Error validating access token: the session has been invalidated.',
        'auth',
        190,
        460,
      ),
    );
    const { messageId } = await run<{ messageId: string }>(messageSend, {
      workspaceId,
      channel: 'messenger',
      conversationId,
      body: 'Are you still there?',
    });
    await drain();
    expect((await messagesIn(conversationId)).find((m) => m.id === messageId)).toMatchObject({
      status: 'failed',
      error_code: 'account',
    });
    expect(await account('facebook', pageA)).toMatchObject({
      status: 'needs_attention',
      problem: 'reauth',
    });
    // Connecting again: the Page answers again, in the same thread.
    const asked = await connect();
    const done = await pickAccounts(
      app,
      asked.pick!.answer,
      asked.handoff!,
      [`facebook:${pageA}`],
      await signInTestUser(owner),
    );
    expect(new URL(done.location!).searchParams.get('meta')).toBe('connected');
    expect(await account('facebook', pageA)).toMatchObject({ status: 'active', problem: null });
    await run(messageRetry, { workspaceId, messageId });
    await drain();
    expect((await messagesIn(conversationId)).find((m) => m.id === messageId)!.status).toBe('sent');
    expect((await conversationOf(`messenger:${pageA}:${maria}`)).id).toBe(conversationId);
  });

  it('notices a Page whose sign-in stopped working on the daily check', async () => {
    s.social.fake.revokePage(pageA);
    await admin().execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select w.organization_id, w.id, 'meta.check', ${`meta.check:${workspaceId}`}, now(), '{}'::jsonb
          from app.workspaces w where w.id = ${workspaceId}::uuid
          on conflict do nothing`,
    );
    await drain();
    expect(await account('facebook', pageA)).toMatchObject({
      status: 'needs_attention',
      problem: 'reauth',
    });
  });
});

describe('letting go', () => {
  it('stops Meta sending a Page’s messages once nothing here answers through it', async () => {
    // Mended first: the daily check found the Page's sign-in gone.
    const asked = await connect();
    await pickAccounts(
      app,
      asked.pick!.answer,
      asked.handoff!,
      [`facebook:${pageA}`],
      await signInTestUser(owner),
    );
    const page = await account('facebook', pageA);
    const ig = await account('instagram', igA);
    expect([page.status, ig.status]).toEqual(['active', 'active']);
    expect(s.social.fake.subscribed()).toContain(pageA);
    // The Instagram account still answers through the Page: Meta keeps sending.
    await run(metaAccountDisconnect, { workspaceId, accountId: page.id });
    await drain();
    expect((await account('facebook', pageA)).token_enc).toBeNull();
    expect(s.social.fake.subscribed()).toContain(pageA);
    await run(metaAccountDisconnect, { workspaceId, accountId: ig.id });
    await drain();
    expect((await account('instagram', igA)).token_enc).toBeNull();
    expect(s.social.fake.subscribed()).not.toContain(pageA);
    // A message Meta still sends for a while is set aside.
    await webhook(batch('facebook', pageA, [fromCustomer(maria, pageA, { text: 'Hello again' })]));
    const stored = await rows(
      admin(),
      sql`select 1 from app.webhook_deliveries where workspace_id = ${workspaceId}::uuid and status = 'pending'`,
    );
    expect(stored).toHaveLength(0);
  });

  it('stops every sign-in of somebody who removed the app on Facebook, and forgets them when asked', async () => {
    const asked = await connect();
    await pickAccounts(
      app,
      asked.pick!.answer,
      asked.handoff!,
      [`facebook:${pageB}`],
      await signInTestUser(owner),
    );
    expect((await account('facebook', pageB)).status).toBe('active');
    const signed = (payload: Record<string, unknown>) => {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = createHmac('sha256', FAKE_META_APP_SECRET).update(body).digest('base64url');
      return `${sig}.${body}`;
    };
    const forged = await app.inject({
      method: 'POST',
      url: '/meta/deauthorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(`AAAA.${Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: fbUser })).toString('base64url')}`)}`,
    });
    expect(forged.statusCode).toBe(400);
    const removed = await app.inject({
      method: 'POST',
      url: '/meta/deauthorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(signed({ algorithm: 'HMAC-SHA256', user_id: fbUser }))}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(await account('facebook', pageB)).toMatchObject({
      status: 'needs_attention',
      problem: 'revoked',
    });

    const deletion = await app.inject({
      method: 'POST',
      url: '/meta/data-deletion',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(signed({ algorithm: 'HMAC-SHA256', user_id: fbUser }))}`,
    });
    expect(deletion.statusCode).toBe(200);
    const said = deletion.json() as { url: string; confirmation_code: string };
    expect(said.url).toBe(`${s.publicUrl}/meta/data-deletion/${said.confirmation_code}`);
    expect((await get(new URL(said.url).pathname)).body).toContain(said.confirmation_code);
    const left = await rows<{ facebook_user_id: string | null; facebook_user_name: string | null }>(
      admin(),
      sql`select facebook_user_id, facebook_user_name from app.meta_connections
          where workspace_id = ${workspaceId}::uuid and connected_at is not null`,
    );
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((c) => c.facebook_user_id === null && c.facebook_user_name === null)).toBe(
      true,
    );
  });
});
