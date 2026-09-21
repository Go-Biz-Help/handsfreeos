/**
 * The website chat's public routes on the real database (M7 step 8): the widget's settings, starting and
 * picking up a visit, the token's weekly swap and its 10-minute grace, messages (a resend lands once), the
 * honeypot, the invisible human check (first message, every 50th, after a new token, Cloudflare down), every
 * limit, long and repeated messages, blocked visitors and networks, a wrong or paused widget, unlisted sites,
 * read receipts, and a matched customer's details never reaching the visitor.
 */
import { randomUUID } from 'node:crypto';
import {
  chatBlockVisitor,
  chatUnblockVisitor,
  chatWidgetCreate,
  chatWidgetPause,
  chatWidgetResume,
  localDateOf,
  personCreate,
  weekdayOf,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeBotCheck, type BotCheck } from '../src/booking/bot-check';
import { tokenHashOf } from '../src/chat/store';
import { chatSmsConsent } from '../src/http/chat';
import {
  admin,
  AWAY,
  chatServer,
  chatWorld,
  CHI,
  closeServers,
  conversationOf,
  errorOfChat,
  GREETING,
  MIN,
  nextPhone,
  PAGE,
  receivedPayload,
  run,
  setTeammateStatus,
  SITE,
  staffReply,
  startedVisitor,
  Visitor,
  visitorRow,
  type ChatWorld,
} from './chat-world';

const HOUR = 60 * MIN;

let w: ChatWorld;
let app: FastifyInstance;

beforeAll(async () => {
  w = await chatWorld('chat-routes');
  app = await chatServer(w);
});
afterAll(async () => {
  await closeServers();
  await closeTestDbs();
});

const configOf = (key: string, origin?: string) =>
  app.inject({
    method: 'GET',
    url: `/public/chat/${key}/config${origin ? `?origin=${encodeURIComponent(origin)}` : ''}`,
    headers: { 'x-forwarded-for': '198.51.100.1' },
  });

describe('the widget’s settings', () => {
  it('gives the chat window what it shows, Ava’s name and nothing else about her, and whether anyone is answering', async () => {
    const res = await configOf(w.key);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      business: { name: 'chat-routes Booking HVAC' },
      teammate: { name: 'Ava' },
      greeting: GREETING,
      awayMessage: AWAY,
      away: false,
      look: {
        launcherLabel: 'Chat with us',
        accentColor: '#2d69d8',
        textColor: '#ffffff',
        position: 'right',
      },
      askFor: { name: 'when_needed', phone: 'when_needed', email: 'when_needed' },
      // The widget says the same six things the public form and the booking page say, and names the
      // business while doing it: a visitor who agreed to hear from nobody in particular agreed to nothing.
      // The path is spelled out rather than built with core's helper, so that changing where policies live
      // fails here instead of agreeing with itself.
      smsConsent: {
        ...chatSmsConsent('chat-routes Booking HVAC', `/legal/${w.site}/privacy`),
        text: chatSmsConsent('chat-routes Booking HVAC', null).detail,
      },
      humanCheck: null,
      paused: false,
      maxMessageLength: 1000,
    });
    for (const secret of [w.teammateId, w.widgetId, w.workspaceId, w.organizationId])
      expect(res.body).not.toContain(secret);
    // A site on the list is fine; anywhere else is refused; a key nobody has is missing.
    expect((await configOf(w.key, 'https://www.lonestarhvac.com')).statusCode).toBe(200);
    expect(errorOfChat(await configOf(w.key, 'https://evil.example')).rule).toBe(
      'origin_not_allowed',
    );
    for (const key of [`wk_${'A'.repeat(20)}`, 'not-a-key'])
      expect(errorOfChat(await configOf(key))).toMatchObject({ rule: 'widget_not_found' });

    // Ava off and the business closed: nobody is answering, so the window shows the away message.
    const today = weekdayOf(localDateOf(Date.now(), CHI));
    await setTeammateStatus(w.teammateId, 'off');
    await rows(
      admin(),
      sql`update app.workspaces set settings = settings || jsonb_build_object('openHours',
            jsonb_build_array(jsonb_build_object('day', ${(today + 3) % 7}::int, 'start', '00:00', 'end', '00:30')))
          where id = ${w.workspaceId}`,
    );
    try {
      expect((await configOf(w.key)).json()).toMatchObject({ teammate: null, away: true });
    } finally {
      await rows(
        admin(),
        sql`update app.workspaces set settings = settings - 'openHours' where id = ${w.workspaceId}`,
      );
      await setTeammateStatus(w.teammateId, 'training');
    }
  });
});

describe('starting and picking up a visit', () => {
  it('gives a new visitor a token only its window keeps, and a returning one no new token', async () => {
    const v = new Visitor(app, w.key, '198.51.100.10');
    const first = await v.start();
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json() as { token: string };
    expect(body).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      resumed: false,
      chatStarted: false,
      gave: { name: false, phone: false, email: false },
      humanCheck: null,
      messages: [],
      cursor: null,
      typing: false,
    });
    // Only the token's hash is stored, and a keyed hash of the address, never the address.
    const [row] = await rows<{ ip: string; last_page_path: string; seen: boolean }>(
      admin(),
      sql`select encode(ip_hmac, 'hex') as ip, last_page_path, last_seen_at is not null as seen
          from app.chat_visitors where token_hash = decode(${tokenHashOf(body.token)}, 'hex')`,
    );
    expect(row).toMatchObject({
      ip: expect.stringMatching(/^[0-9a-f]{64}$/),
      last_page_path: PAGE,
    });
    expect(row!.ip).not.toContain('198.51.100.10');
    // The install check.
    const [widget] = await rows<{ last_seen_origin: string | null }>(
      admin(),
      sql`select last_seen_origin from app.chat_widgets where id = ${w.widgetId}`,
    );
    expect(widget!.last_seen_origin).toBe(SITE);

    // Back again: the same visit, no new token; the page's query string is never kept.
    const again = await v.start({ pagePath: '/contact?email=mike@example.com#form' });
    expect(again.json()).toMatchObject({ token: null, resumed: true });
    const [moved] = await rows<{ last_page_path: string }>(
      admin(),
      sql`select last_page_path from app.chat_visitors where id = ${(await visitorRow(v)).id}`,
    );
    expect(moved!.last_page_path).toBe('/contact');
    // A token nobody has starts a new visit.
    const stranger = new Visitor(app, w.key, '198.51.100.11');
    stranger.token = 'x'.repeat(43);
    expect((await stranger.start()).json()).toMatchObject({ resumed: false });
    // Without a token, the routes after start say the chat has ended.
    const noToken = new Visitor(app, w.key);
    expect(errorOfChat(await noToken.poll())).toMatchObject({ rule: 'chat_not_found' });
  });

  it('swaps a week-old token, and the old one keeps working for 10 minutes, then stops', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.12');
    expect((await v.send('Hello there')).statusCode).toBe(200);
    const old = v.token!;
    await rows(
      admin(),
      sql`update app.chat_visitors set token_issued_at = now() - interval '8 days'
          where token_hash = decode(${tokenHashOf(old)}, 'hex')`,
    );
    const swapped = await v.start();
    expect(swapped.statusCode, swapped.body).toBe(200);
    const fresh = (swapped.json() as { token: string | null }).token;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(old);
    const [grace] = await rows<{ minutes: number }>(
      admin(),
      sql`select extract(epoch from prev_token_expires_at - now()) / 60 as minutes
          from app.chat_visitors where token_hash = decode(${tokenHashOf(fresh!)}, 'hex')`,
    );
    expect(Number(grace!.minutes)).toBeGreaterThan(9.5);
    expect(Number(grace!.minutes)).toBeLessThanOrEqual(10);
    // The old token still works during its grace...
    const oldWindow = new Visitor(app, w.key, '198.51.100.12');
    oldWindow.token = old;
    expect((await oldWindow.poll()).statusCode).toBe(200);
    // ...then stops.
    await rows(
      admin(),
      sql`update app.chat_visitors set prev_token_expires_at = now() - interval '1 second'
          where token_hash = decode(${tokenHashOf(fresh!)}, 'hex')`,
    );
    const gone = await oldWindow.poll();
    expect(gone.statusCode).toBe(404);
    expect(errorOfChat(gone).rule).toBe('chat_not_found');
    expect((await v.poll()).statusCode).toBe(200);
  });
});

describe('messages', () => {
  it('files a message once however often the window resends it, and marks it for the AI teammate', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.13');
    const clientId = randomUUID();
    const first = await v.send('Do you service Lennox units?', { clientId });
    expect(first.statusCode, first.body).toBe(200);
    const sent = first.json() as { message: { id: string }; cursor: string };
    expect(sent).toMatchObject({
      duplicate: false,
      newChat: true,
      message: {
        from: 'visitor',
        name: null,
        body: 'Do you service Lennox units?',
        joined: false,
      },
      cursor: expect.stringMatching(/^\d+\.[0-9a-f-]{36}$/),
      humanCheck: null,
    });
    const again = await v.send('Do you service Lennox units?', { clientId });
    expect(again.json()).toMatchObject({ duplicate: true, message: { id: sent.message.id } });
    const conversationId = await conversationOf(v);
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.messages where conversation_id = ${conversationId}`,
    );
    expect(n!.n).toBe(1);
    // The human check didn't fail, so the AI teammate may answer it.
    expect(await receivedPayload(sent.message.id)).toMatchObject({
      channel: 'chat',
      aiReply: true,
    });
    // The chat has started: start says so and carries it.
    expect((await v.start()).json()).toMatchObject({
      chatStarted: true,
      messages: [{ id: sent.message.id, from: 'visitor' }],
      cursor: sent.cursor,
    });
  });

  it('refuses a filled honeypot with a plain 400, and saves nothing', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.14');
    const res = await v.send('Cheap pills here', { honeypot: 'https://spam.example' });
    expect(res.statusCode).toBe(400);
    expect(errorOfChat(res).code).toBe('validation');
    const bot = await v.identify({ name: 'Bot', honeypot: 'filled' });
    expect(bot.statusCode).toBe(400);
    expect(await visitorRow(v)).toMatchObject({ conversation_id: null });
  });

  it('refuses a message over 1,000 characters, and the same message a third time in 10 minutes', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.15');
    const long = await v.send('x'.repeat(1001));
    expect(long.statusCode).toBe(400);
    expect(errorOfChat(long)).toMatchObject({ code: 'validation' });
    expect((await v.send('y'.repeat(1000))).statusCode).toBe(200);
    const clientId = randomUUID();
    expect((await v.send('Hello?', { clientId })).statusCode).toBe(200);
    expect((await v.send('  hello?  ')).statusCode).toBe(200);
    const third = await v.send('HELLO?');
    expect(third.statusCode).toBe(429);
    expect(errorOfChat(third).rule).toBe('repeated_message');
    // A resend of one that landed still lands once; something new goes through.
    expect((await v.send('Hello?', { clientId })).json()).toMatchObject({ duplicate: true });
    expect((await v.send('Is anyone there?')).statusCode).toBe(200);
  });
});

describe('the invisible human check', () => {
  it('runs on the first message, every 50th and after a new token; details wait for it too', async () => {
    const check = fakeBotCheck();
    const srv = await chatServer(w, { botCheck: check });
    const v = new Visitor(srv, w.key, '198.51.100.20');
    const started = await v.start();
    expect(started.json()).toMatchObject({
      humanCheck: { siteKey: 'fake-site-key', required: true },
    });
    const bare = await v.send('Hi, is anyone there?');
    expect(bare.statusCode).toBe(400);
    expect(errorOfChat(bare).rule).toBe('bot_check_required');
    expect(errorOfChat(await v.identify({ name: 'Mike' })).rule).toBe('bot_check_required');
    const wrong = await v.send('Hi, is anyone there?', { turnstileToken: 'nope' });
    expect(errorOfChat(wrong).rule).toBe('bot_check_failed');
    const passed = await v.send('Hi, is anyone there?', { turnstileToken: 'pass' });
    expect(passed.statusCode, passed.body).toBe(200);
    expect(passed.json()).toMatchObject({
      humanCheck: { siteKey: 'fake-site-key', required: false },
    });
    // Then nothing, until the 50th.
    expect((await v.send('Our AC blows warm air.')).statusCode).toBe(200);
    expect((await v.identify({ name: 'Mike Alvarez' })).statusCode).toBe(200);
    expect(check.seen.map((s) => s.token)).toEqual(['nope', 'pass']);
    const conversationId = await conversationOf(v);
    await rows(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
          select ${w.workspaceId}, ${conversationId}, 'chat', 'inbound', 'received', 'Earlier message ' || g
          from generate_series(1, 47) as g`,
    );
    // 49 sent: the next is the 50th.
    expect((await v.start()).json()).toMatchObject({ humanCheck: { required: true } });
    expect(errorOfChat(await v.send('Message fifty')).rule).toBe('bot_check_required');
    expect((await v.send('Message fifty', { turnstileToken: 'pass' })).statusCode).toBe(200);
    expect((await v.send('Message fifty-one')).statusCode).toBe(200);
    // A new token asks again.
    await rows(
      admin(),
      sql`update app.chat_visitors set token_issued_at = now() - interval '8 days'
          where token_hash = decode(${tokenHashOf(v.token!)}, 'hex')`,
    );
    const swapped = await v.start();
    expect(swapped.json()).toMatchObject({
      token: expect.any(String),
      humanCheck: { required: true },
    });
    expect(errorOfChat(await v.send('Still me')).rule).toBe('bot_check_required');
    expect((await v.send('Still me', { turnstileToken: 'pass' })).statusCode).toBe(200);
    expect(check.seen).toHaveLength(4);
    // Cloudflare sees the caller's address; nothing stores it.
    expect(check.seen.every((s) => s.ip === '198.51.100.20')).toBe(true);
  });

  it('still files a message when Cloudflare can’t answer, marked so the AI teammate leaves it to people', async () => {
    const down: BotCheck = {
      enabled: true,
      siteKey: 'site-key',
      verify: () => Promise.resolve('unavailable'),
    };
    const srv = await chatServer(w, { botCheck: down });
    const v = await startedVisitor(srv, w.key, '198.51.100.21');
    const res = await v.send('My furnace is banging', { turnstileToken: 'anything' });
    expect(res.statusCode, res.body).toBe(200);
    const sent = res.json() as { message: { id: string } };
    // The next message tries the check again.
    expect(res.json()).toMatchObject({ humanCheck: { siteKey: 'site-key', required: true } });
    expect(await receivedPayload(sent.message.id)).toMatchObject({ aiReply: false });
    const [row] = await rows<{ passed: boolean }>(
      admin(),
      sql`select turnstile_passed_at is not null as passed from app.chat_visitors
          where id = ${(await visitorRow(v)).id}`,
    );
    expect(row!.passed).toBe(false);
  });
});

describe('limits', () => {
  it('counts each address, visitor, widget and business separately', async () => {
    // Per address: two starts a minute.
    const perIp = await chatServer(w, { limits: { ipStart: { max: 2, timeWindow: MIN } } });
    await startedVisitor(perIp, w.key, '203.0.113.1');
    await startedVisitor(perIp, w.key, '203.0.113.1');
    const third = await new Visitor(perIp, w.key, '203.0.113.1').start();
    expect(third.statusCode).toBe(429);
    expect(errorOfChat(third).rule).toBe('rate_limited');
    expect((await new Visitor(perIp, w.key, '203.0.113.2').start()).statusCode).toBe(200);

    // Per visitor: two messages a minute, from wherever.
    const perVisitor = await chatServer(w, {
      limits: { visitorSend: { max: 2, timeWindow: MIN } },
    });
    const b = await startedVisitor(perVisitor, w.key, '203.0.113.3');
    expect((await b.send('One')).statusCode).toBe(200);
    expect((await b.send('Two')).statusCode).toBe(200);
    const moved = new Visitor(perVisitor, w.key, '203.0.113.4');
    moved.token = b.token;
    const over = await moved.send('Three');
    expect(over.statusCode).toBe(429);
    expect(errorOfChat(over).rule).toBe('rate_limited');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      (await (await startedVisitor(perVisitor, w.key, '203.0.113.5')).send('Hi')).statusCode,
    ).toBe(200);

    // Per widget: three messages a minute across its visitors; the business's other widget carries on.
    const other = await run(w, chatWidgetCreate, {
      workspaceId: w.workspaceId,
      allowedOrigins: ['acme-roofing.com'],
    });
    const perWidget = await chatServer(w, { limits: { widgetSend: { max: 3, timeWindow: MIN } } });
    for (const ip of ['203.0.113.6', '203.0.113.7', '203.0.113.8'])
      expect((await (await startedVisitor(perWidget, w.key, ip)).send('Hello')).statusCode).toBe(
        200,
      );
    const fourth = await (await startedVisitor(perWidget, w.key, '203.0.113.9')).send('Hello');
    expect(errorOfChat(fourth).rule).toBe('rate_limited');
    const roofer = new Visitor(perWidget, other.publicKey, '203.0.113.10');
    expect((await roofer.start({ origin: 'https://acme-roofing.com' })).statusCode).toBe(200);
    expect((await roofer.send('Roof leak')).statusCode).toBe(200);

    // Per business: three messages a minute across all its widgets.
    const perBusiness = await chatServer(w, {
      limits: { businessSend: { max: 3, timeWindow: MIN } },
    });
    expect(
      (await (await startedVisitor(perBusiness, w.key, '203.0.113.11')).send('A')).statusCode,
    ).toBe(200);
    expect(
      (await (await startedVisitor(perBusiness, w.key, '203.0.113.12')).send('B')).statusCode,
    ).toBe(200);
    const r1 = new Visitor(perBusiness, other.publicKey, '203.0.113.13');
    await r1.start({ origin: 'https://acme-roofing.com' });
    expect((await r1.send('C')).statusCode).toBe(200);
    const r2 = new Visitor(perBusiness, other.publicKey, '203.0.113.14');
    await r2.start({ origin: 'https://acme-roofing.com' });
    expect(errorOfChat(await r2.send('D')).rule).toBe('rate_limited');
  });

  it('stops floods of new visitors from one network, and new chats past the widget’s daily cap', async () => {
    const srv = await chatServer(w, {
      limits: { networkNewVisitors: { max: 2, timeWindow: HOUR } },
    });
    const office = '203.0.113.50';
    const first = await startedVisitor(srv, w.key, office);
    await startedVisitor(srv, w.key, office);
    const flood = await new Visitor(srv, w.key, office).start();
    expect(flood.statusCode).toBe(429);
    expect(errorOfChat(flood).rule).toBe('network_flood');
    // A visitor already here carries on, and other networks are fine.
    expect((await first.start()).statusCode).toBe(200);
    expect((await new Visitor(srv, w.key, '203.0.113.51').start()).statusCode).toBe(200);

    const capped = await run(w, chatWidgetCreate, {
      workspaceId: w.workspaceId,
      allowedOrigins: ['capped-hvac.com'],
      dailyCap: 1,
    });
    const p = new Visitor(app, capped.publicKey, '203.0.113.60');
    await p.start({ origin: 'https://capped-hvac.com' });
    expect((await p.send('First chat today')).statusCode).toBe(200);
    const q = new Visitor(app, capped.publicKey, '203.0.113.61');
    await q.start({ origin: 'https://capped-hvac.com' });
    const refused = await q.send('Second chat today');
    expect(refused.statusCode).toBe(429);
    expect(errorOfChat(refused).rule).toBe('daily_cap');
    expect((await p.send('Still chatting')).statusCode).toBe(200);
  });

  it('counts the widgets’ settings per address and widget, under a ceiling for the address', async () => {
    // The web server looks up every business's widget from a few addresses: one widget's lookups can't use up
    // another's room, and the address still has a ceiling, keys that name no widget included.
    const srv = await chatServer(w, {
      limits: {
        ipWidgetConfig: { max: 2, timeWindow: MIN },
        ipConfig: { max: 4, timeWindow: MIN },
      },
    });
    const other = await run(w, chatWidgetCreate, {
      workspaceId: w.workspaceId,
      allowedOrigins: ['bayou-plumbing.com'],
    });
    const config = (key: string, ip = '192.0.2.10') =>
      srv.inject({
        method: 'GET',
        url: `/public/chat/${key}/config`,
        headers: { 'x-forwarded-for': ip },
      });
    expect((await config(w.key)).statusCode).toBe(200);
    expect((await config(w.key)).statusCode).toBe(200);
    const third = await config(w.key);
    expect(third.statusCode).toBe(429);
    expect(errorOfChat(third).rule).toBe('rate_limited');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // Another business's widget from the same address still loads, and so does this one from another address.
    expect((await config(other.publicKey)).statusCode).toBe(200);
    expect((await config(w.key, '192.0.2.11')).statusCode).toBe(200);
    // A key that names no widget counts toward the address's ceiling (the fourth), then the address is full.
    expect((await config(`wk_${'x'.repeat(20)}`)).statusCode).toBe(404);
    const full = await config(other.publicKey);
    expect(full.statusCode).toBe(429);
    expect(errorOfChat(full).rule).toBe('rate_limited');
  });
});

describe('refusals', () => {
  it('refuses a blocked visitor everywhere, and everyone on their network once that’s blocked too', async () => {
    const srv = await chatServer(w);
    const office = '203.0.113.70';
    const v = await startedVisitor(srv, w.key, office);
    const sent = await v.send('Hi');
    const neighbour = await startedVisitor(srv, w.key, office);
    const { id: visitorId } = await visitorRow(v);
    await run(w, chatBlockVisitor, { workspaceId: w.workspaceId, visitorId });
    const through = (sent.json() as { message: { id: string } }).message.id;
    for (const res of [
      await v.send('Still there?'),
      await v.poll(),
      await v.read(through),
      await v.heartbeat(),
      await v.identify({ name: 'Mike' }),
      await v.get('stream'),
      await v.start(),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(errorOfChat(res).rule).toBe('visitor_blocked');
    }
    // Only them, until their network is blocked too.
    expect((await neighbour.send('Hello from next door')).statusCode).toBe(200);
    await run(w, chatBlockVisitor, { workspaceId: w.workspaceId, visitorId, network: true });
    expect(errorOfChat(await neighbour.send('Me again')).rule).toBe('network_blocked');
    expect(errorOfChat(await new Visitor(srv, w.key, office).start()).rule).toBe('network_blocked');
    expect((await new Visitor(srv, w.key, '203.0.113.71').start()).statusCode).toBe(200);
    await run(w, chatUnblockVisitor, { workspaceId: w.workspaceId, visitorId });
    expect((await v.send('Back again')).statusCode).toBe(200);
    expect((await neighbour.send('Me too')).statusCode).toBe(200);
  });

  it('refuses a token on another widget, a paused widget, and sites that aren’t on the list', async () => {
    const other = await run(w, chatWidgetCreate, {
      workspaceId: w.workspaceId,
      allowedOrigins: ['acme-plumbing.com'],
    });
    const v = await startedVisitor(app, w.key, '203.0.113.80');
    expect((await v.send('Hello')).statusCode).toBe(200);
    const elsewhere = new Visitor(app, other.publicKey, '203.0.113.80');
    elsewhere.token = v.token;
    for (const res of [await elsewhere.poll(), await elsewhere.send('Hi')]) {
      expect(res.statusCode).toBe(404);
      expect(errorOfChat(res).rule).toBe('chat_not_found');
    }
    // Sites that aren't on the list; the local test site is.
    const outsider = new Visitor(app, w.key, '203.0.113.81');
    const refused = await outsider.start({ origin: 'https://evil.example' });
    expect(refused.statusCode).toBe(403);
    expect(errorOfChat(refused).rule).toBe('origin_not_allowed');
    expect(outsider.token).toBeNull();
    expect(errorOfChat(await v.heartbeat('https://evil.example')).rule).toBe('origin_not_allowed');
    expect((await v.heartbeat(SITE, '/pricing')).json()).toEqual({ ok: true });
    const [seen] = await rows<{ last_page_path: string }>(
      admin(),
      sql`select last_page_path from app.chat_visitors where id = ${(await visitorRow(v)).id}`,
    );
    expect(seen!.last_page_path).toBe('/pricing');
    expect(
      (await new Visitor(app, w.key, '203.0.113.82').start({ origin: 'http://localhost:4191' }))
        .statusCode,
    ).toBe(200);

    // Paused: nothing but its settings, which say so.
    await run(w, chatWidgetPause, { workspaceId: w.workspaceId, widgetId: w.widgetId });
    try {
      for (const res of [await v.send('Paused?'), await v.poll(), await v.start()]) {
        expect(res.statusCode).toBe(409);
        expect(errorOfChat(res).rule).toBe('widget_paused');
      }
      expect((await configOf(w.key)).json()).toMatchObject({ paused: true });
    } finally {
      await run(w, chatWidgetResume, { workspaceId: w.workspaceId, widgetId: w.widgetId });
    }
    expect((await v.send('Back on')).statusCode).toBe(200);
  });
});

describe('read receipts and details', () => {
  it('marks the replies the window showed as seen, in the visitor’s own chat only', async () => {
    const v = await startedVisitor(app, w.key, '203.0.113.85');
    await v.send('Can someone call me?');
    const conversationId = await conversationOf(v);
    const first = await staffReply(w, conversationId, 'Sure, what number works?');
    const second = await staffReply(w, conversationId, 'Or we can email you.');
    const other = await startedVisitor(app, w.key, '203.0.113.86');
    await other.send('Hi');
    expect((await other.read(first.messageId)).statusCode).toBe(404);
    expect((await v.read('not-a-message')).statusCode).toBe(400);
    expect((await v.read(first.messageId)).json()).toEqual({ ok: true });
    const statuses = await rows<{ id: string; status: string }>(
      admin(),
      sql`select id, status::text as status from app.messages
          where id in (${first.messageId}, ${second.messageId})`,
    );
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({
      [first.messageId]: 'delivered',
      [second.messageId]: 'queued',
    });
  });

  it('never shows a visitor anything about the customer their details matched', async () => {
    const phone = nextPhone();
    const email = `linda.parkerson-${randomUUID().slice(0, 6)}@example.com`;
    const linda = await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName: 'Linda',
      lastName: 'Parkerson',
      phone,
      email,
    });
    const v = new Visitor(app, w.key, '203.0.113.90');
    const bodies: string[] = [];
    const keep = <T extends { body: string }>(res: T): T => {
      bodies.push(res.body);
      return res;
    };
    keep(await v.start());
    keep(await v.send('Can I move my appointment to Friday?'));
    const said = keep(await v.identify({ phone, smsConsent: true }));
    expect(said.statusCode, said.body).toBe(200);
    expect(said.json()).toEqual({ gave: { name: false, phone: true, email: false } });
    // It matched Linda: the chat is hers in the inbox, and she's unchanged.
    const conversationId = await conversationOf(v);
    const [c] = await rows<{ person_id: string | null }>(
      admin(),
      sql`select person_id from app.conversations where id = ${conversationId}`,
    );
    expect(c!.person_id).toBe(linda.personId);
    const [p] = await rows<{ sms_consent: string; first_name: string }>(
      admin(),
      sql`select sms_consent::text as sms_consent, first_name from app.people where id = ${linda.personId}`,
    );
    expect(p).toEqual({ sms_consent: 'unknown', first_name: 'Linda' });
    keep(await v.send('Thanks!'));
    await staffReply(w, conversationId, 'Someone will call you shortly.');
    keep(await v.poll());
    keep(await v.start());
    keep(await v.heartbeat());
    keep(await configOf(w.key));
    for (const body of bodies) {
      for (const secret of ['Linda', 'Parkerson', email, linda.personId, phone.slice(2)])
        expect(body).not.toContain(secret);
    }
  });
});
