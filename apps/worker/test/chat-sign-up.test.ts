/**
 * The chat's sign-up page (/chat/<key> opened on its own): its form works without a chat. A carrier's reviewer filled
 * in the old page, pressed Send and was told it only showed what the chat asks, and the campaign was turned down
 * (Twilio 30896, 1 Nov 2026). Now Send keeps them as a customer with their yes to texts, as the chat does.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeBotCheck } from '../src/booking/bot-check';
import {
  admin,
  chatServer,
  chatWorld,
  closeServers,
  errorOfChat,
  nextPhone,
  type ChatWorld,
} from './chat-world';

let w: ChatWorld;
let app: FastifyInstance;

beforeAll(async () => {
  w = await chatWorld('chat-sign-up');
  app = await chatServer(w);
});
afterAll(async () => {
  await closeServers();
  await closeTestDbs();
});

const signUp = (payload: Record<string, unknown>, srv = app, ip = '198.51.100.70') =>
  srv.inject({
    method: 'POST',
    url: `/public/chat/${w.key}/sign-up`,
    payload,
    remoteAddress: ip,
  });

describe('the sign-up page', () => {
  it('keeps them as a customer with their yes to texts, from any page (it’s our own)', async () => {
    const phone = nextPhone();
    const res = await signUp({ name: 'Sam Reviewer', phone, smsConsent: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ signedUp: true, texts: true });
    const [person] = await rows<{ sms_consent: string; sms_consent_source: string | null }>(
      admin(),
      sql`select sms_consent::text as sms_consent, sms_consent_source from app.people
          where workspace_id = ${w.workspaceId} and phone_e164 = ${phone}`,
    );
    expect(person).toMatchObject({ sms_consent: 'opted_in', sms_consent_source: 'chat_widget' });
  });

  it('asks for a mobile number to send texts to, and something to reach them by', async () => {
    const noPhone = await signUp({ name: 'Sam', email: 'sam@example.com', smsConsent: true });
    expect(noPhone.statusCode).toBe(400);
    expect(JSON.stringify(errorOfChat(noPhone).details)).toContain('mobile number');
    const nothing = await signUp({ name: 'Sam' });
    expect(nothing.statusCode).toBe(400);
    // Unticked is fine: they're kept, and get no texts.
    const quiet = await signUp({ name: 'Quiet Sam', phone: nextPhone() });
    expect(quiet.json()).toEqual({ signedUp: true, texts: false });
  });

  it('turns away a bot: a filled honeypot, and the human check when it’s on', async () => {
    const bot = await signUp({ phone: nextPhone(), smsConsent: true, honeypot: 'http://spam' });
    expect(bot.statusCode).toBe(400);
    const srv = await chatServer(w, { botCheck: fakeBotCheck() });
    const bare = await signUp({ phone: nextPhone(), smsConsent: true }, srv, '198.51.100.71');
    expect(errorOfChat(bare).rule).toBe('bot_check_required');
    const passed = await signUp(
      { phone: nextPhone(), smsConsent: true, turnstileToken: 'pass' },
      srv,
      '198.51.100.71',
    );
    expect(passed.statusCode, passed.body).toBe(200);
  });

  it('isn’t there for a paused chat', async () => {
    await rows(
      admin(),
      sql`update app.chat_widgets set paused_at = now() where id = ${w.widgetId}`,
    );
    const res = await signUp({ phone: nextPhone(), smsConsent: true });
    expect(errorOfChat(res).rule).toBe('widget_paused');
    await rows(admin(), sql`update app.chat_widgets set paused_at = null where id = ${w.widgetId}`);
  });
});
