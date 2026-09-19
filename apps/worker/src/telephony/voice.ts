/**
 * Calls: the TwiML the worker answers Twilio with, and the access tokens browsers ring with.
 * Everything here is pure (no I/O), so the routes and the tests share it.
 */
import { createHmac } from 'node:crypto';
import {
  BRIDGE_CUSTOMER_RING_SECONDS,
  BRIDGE_GATE_SECONDS,
  type ForwardedCallerId,
} from '@hfos/core';

/** A natural-sounding voice for greetings and the forwarded-phone screen. */
export const VOICE = 'Polly.Joanna-Neural';
const E164 = /^\+[1-9][0-9]{6,14}$/;
export const isPhone = (v: string | undefined | null): v is string => !!v && E164.test(v);

/** A teammate's browser identity: letters and digits only (Twilio allows at most 121). Mirrors private.phone_route. */
export const identityOf = (userId: string): string => `u${userId.replace(/-/g, '')}`;

/** The user behind `client:u…` (or a bare identity); null for phones and anything else. */
export function userIdOfIdentity(value: string | undefined | null): string | null {
  const m = /^(?:client:)?u([0-9a-f]{32})$/.exec(value ?? '');
  if (!m) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A Twilio Voice access token (HS256 over the subaccount's own API key). The browser can place calls only
 * through the workspace's TwiML app, and rings for its own identity.
 */
export function voiceAccessToken(o: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
  ttlSeconds?: number;
  now?: number;
}): { token: string; expiresAt: string } {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + (o.ttlSeconds ?? 3600);
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${o.apiKeySid}-${iat}`,
    iss: o.apiKeySid,
    sub: o.accountSid,
    iat,
    exp,
    grants: {
      identity: o.identity,
      voice: { incoming: { allow: true }, outgoing: { application_sid: o.twimlAppSid } },
    },
  };
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createHmac('sha256', o.apiKeySecret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

// ---------- TwiML ----------

const escapeXml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const attrs = (a: Readonly<Record<string, string | number | boolean | undefined>>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('');

export const twiml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
export const say = (text: string) => `<Say${attrs({ voice: VOICE })}>${escapeXml(text)}</Say>`;
export const HANGUP = '<Hangup/>';

/** Where Twilio reaches the worker about calls. Built from WORKER_PUBLIC_URL, never from a Host header. */
export function voiceUrls(publicUrl: string) {
  const base = `${publicUrl}/webhooks/twilio/voice`;
  const line = (path: string, e164: string) => `${base}/${path}?line=${encodeURIComponent(e164)}`;
  return {
    inbound: `${base}/inbound`,
    outbound: `${base}/outbound`,
    status: `${base}/status`,
    legStatus: `${base}/leg-status`,
    dialResult: `${base}/dial-result`,
    hangup: `${base}/hangup`,
    recording: `${base}/recording`,
    /**
     * A forwarding phone that picked up. `from` is the customer's number when forwarded phones show the business
     * number instead (their leg then says the business is calling, so the screen reads the customer from here).
     */
    screen: (e164: string, from?: string | null) =>
      from ? `${line('screen', e164)}&from=${encodeURIComponent(from)}` : line('screen', e164),
    screenResult: (e164: string) => line('screen-result', e164),
    /** A call through someone's own cell: their cell answered, they pressed a key, and how the customer's leg went. */
    bridge: (callId: string) => `${base}/bridge?callId=${callId}`,
    bridgeGate: (callId: string) => `${base}/bridge-gate?callId=${callId}`,
    bridgeResult: (callId: string) => `${base}/bridge-result?callId=${callId}`,
    /** The call that confirms someone's cell: it answered, they pressed a key, and how it went. */
    verify: (userPhoneId: string) => `${base}/verify?userPhoneId=${userPhoneId}`,
    verifyResult: (userPhoneId: string) => `${base}/verify-result?userPhoneId=${userPhoneId}`,
    verifyStatus: (userPhoneId: string) => `${base}/verify-status?userPhoneId=${userPhoneId}`,
  };
}
export type VoiceUrls = ReturnType<typeof voiceUrls>;

export interface Forwarding {
  readonly e164: string;
  readonly label: string;
}

export interface Routing {
  readonly forwarding: readonly Forwarding[];
  readonly ringSeconds: number;
  readonly voicemailEnabled: boolean;
  readonly voicemailGreeting: string | null;
  /** What forwarding phones show: the customer's number, or the business number. */
  readonly forwardedCallerId: ForwardedCallerId;
}

/** The number's routing (phone_numbers.routing), with the rules the settings page enforces applied again. */
export function routingOf(raw: unknown): Routing {
  const r = (raw ?? {}) as {
    forwarding?: { e164?: unknown; label?: unknown; enabled?: unknown }[];
    ringSeconds?: unknown;
    voicemailEnabled?: unknown;
    voicemailGreeting?: unknown;
    forwardedCallerId?: unknown;
  };
  const ring = typeof r.ringSeconds === 'number' ? r.ringSeconds : 20;
  return {
    forwarding: (Array.isArray(r.forwarding) ? r.forwarding : [])
      .filter((f) => f.enabled !== false && typeof f.e164 === 'string' && isPhone(f.e164))
      .slice(0, 3)
      .map((f) => ({
        e164: f.e164 as string,
        label:
          typeof f.label === 'string' && f.label.trim() ? f.label.trim() : 'a forwarding phone',
      })),
    ringSeconds: Math.min(25, Math.max(10, Math.round(ring))),
    voicemailEnabled: r.voicemailEnabled !== false,
    voicemailGreeting:
      typeof r.voicemailGreeting === 'string' && r.voicemailGreeting.trim()
        ? r.voicemailGreeting.trim()
        : null,
    forwardedCallerId: r.forwardedCallerId === 'business' ? 'business' : 'customer',
  };
}

export const defaultGreeting = (workspaceName: string) =>
  `You’ve reached ${workspaceName}. Leave your name, number and what you need, and we’ll call you back today.`;

/** A number spoken digit by digit ("7 1 3, 5 5 5, 0 1 4 2"), for the forwarded-phone screen. */
export function spokenPhone(e164: string): string {
  const digits = e164.replace(/^\+1(?=\d{10}$)/, '').replace(/\D/g, '');
  const groups =
    digits.length === 10 ? [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)] : [digits];
  return groups.map((g) => g.split('').join(' ')).join(', ');
}

/**
 * Rings every teammate's browser and each enabled forwarding phone at once. The first to answer takes the
 * call; forwarded phones hear "press 1" first, so a cell's own voicemail cannot grab it. `params` reach the
 * browsers as the call's custom parameters (who is calling, what else rings). With `callerId`, forwarded phones
 * see the business number rather than the customer's (a phone that silences unknown callers still rings), and
 * still hear who is calling before they press 1; browsers name the caller from `params` either way.
 */
export function ringTwiml(
  plan: {
    identities: readonly string[];
    forwarding: readonly Forwarding[];
    ringSeconds: number;
    line: string;
    params: Readonly<Record<string, string>>;
    /** The business number, when forwarded phones show it. */
    callerId?: string | null;
  },
  urls: VoiceUrls,
): string {
  const leg = {
    statusCallback: urls.legStatus,
    statusCallbackEvent: 'answered completed',
    statusCallbackMethod: 'POST',
  };
  const parameters = Object.entries(plan.params)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `<Parameter${attrs({ name, value })}/>`)
    .join('');
  const clients = plan.identities
    .slice(0, 10)
    .map((id) => `<Client${attrs(leg)}><Identity>${escapeXml(id)}</Identity>${parameters}</Client>`)
    .join('');
  const caller = plan.callerId ? plan.params['from'] || null : null;
  const numbers = plan.forwarding
    .slice(0, 3)
    .map(
      (f) =>
        `<Number${attrs({ url: urls.screen(plan.line, caller), method: 'POST', ...leg })}>${escapeXml(f.e164)}</Number>`,
    )
    .join('');
  // Twilio adds about five seconds to a Dial timeout, so ask for five fewer than the setting.
  const dial = attrs({
    answerOnBridge: true,
    callerId: plan.callerId || undefined,
    timeout: Math.max(5, plan.ringSeconds - 5),
    action: urls.dialResult,
    method: 'POST',
  });
  return twiml(`<Dial${dial}>${clients}${numbers}</Dial>`);
}

/**
 * Nobody answered: the greeting, then a message of up to two minutes. Its words are asked for afterwards, from
 * our own copy of the recording (telephony/transcriber.ts) — `<Record transcribe>` is Twilio's legacy
 * transcription, which skips anything under two seconds and is deprecated.
 */
export function voicemailTwiml(greeting: string, urls: VoiceUrls): string {
  const record = attrs({
    maxLength: 120,
    playBeep: true,
    timeout: 5,
    finishOnKey: '#',
    trim: 'trim-silence',
    action: urls.hangup,
    method: 'POST',
    recordingStatusCallback: urls.recording,
    recordingStatusCallbackMethod: 'POST',
    recordingStatusCallbackEvent: 'completed absent',
  });
  return twiml(`${say(greeting)}<Record${record}/>${HANGUP}`);
}

export const UNAVAILABLE_TWIML = twiml(
  `${say('Sorry, nobody can take your call right now. Please try again later.')}${HANGUP}`,
);
export const NOT_IN_SERVICE_TWIML = twiml(
  `${say('Sorry, this number is not in service.')}${HANGUP}`,
);
export const CANNOT_PLACE_TWIML = twiml(`${say('Sorry, this call could not be placed.')}${HANGUP}`);
export const HANGUP_TWIML = twiml(HANGUP);

/** What a forwarded phone hears after it picks up. Anything but 1 (or silence) hangs up that phone only. */
export function screenTwiml(announcement: string, line: string, urls: VoiceUrls): string {
  const gather = attrs({
    numDigits: 1,
    timeout: 6,
    action: urls.screenResult(line),
    method: 'POST',
  });
  return twiml(`<Gather${gather}>${say(`${announcement} Press 1 to take it.`)}</Gather>${HANGUP}`);
}

/** A teammate's browser calls a customer: the customer sees the business number. */
export function outboundTwiml(from: string, to: string, urls: VoiceUrls): string {
  const dial = attrs({ callerId: from, answerOnBridge: true, action: urls.hangup, method: 'POST' });
  const leg = attrs({
    statusCallback: urls.legStatus,
    statusCallbackEvent: 'ringing answered completed',
    statusCallbackMethod: 'POST',
  });
  return twiml(`<Dial${dial}><Number${leg}>${escapeXml(to)}</Number></Dial>`);
}

// ---------- calls through someone's own cell ----------

/**
 * Someone's cell answered the call HandsFreeOS placed to connect them to a customer: "Press 1 to call Mike
 * Johnson.", twice. Nothing pressed (a voicemail picked up, or they hung up) ends it, and the customer never rings.
 */
export function bridgeGateTwiml(customer: string, callId: string, urls: VoiceUrls): string {
  const gather = attrs({
    numDigits: 1,
    timeout: Math.max(3, Math.round(BRIDGE_GATE_SECONDS / 2)),
    action: urls.bridgeGate(callId),
    method: 'POST',
  });
  const prompt = say(`Press 1 to call ${customer}.`);
  return twiml(
    `<Gather${gather}>${prompt}<Pause length="1"/>${prompt}</Gather>${say('The call wasn’t placed. Goodbye.')}${HANGUP}`,
  );
}

/** They pressed 1: the customer is dialed from the business number, recorded on two channels (theirs second). */
export function bridgeDialTwiml(
  call: {
    readonly callerId: string;
    readonly to: string;
    readonly callId: string;
    readonly customer: string;
  },
  urls: VoiceUrls,
): string {
  const dial = attrs({
    callerId: call.callerId,
    answerOnBridge: true,
    timeout: BRIDGE_CUSTOMER_RING_SECONDS,
    action: urls.bridgeResult(call.callId),
    method: 'POST',
    record: 'record-from-answer-dual',
    recordingStatusCallback: urls.recording,
    recordingStatusCallbackMethod: 'POST',
    recordingStatusCallbackEvent: 'completed absent',
  });
  const leg = attrs({
    statusCallback: urls.legStatus,
    statusCallbackEvent: 'ringing answered completed',
    statusCallbackMethod: 'POST',
  });
  return twiml(
    `${say(`Calling ${call.customer}.`)}<Dial${dial}><Number${leg}>${escapeXml(call.to)}</Number></Dial>`,
  );
}

/** How the customer's phone went, said to the person before hanging up. */
export function bridgeResultTwiml(dialStatus: string | undefined, customer: string): string {
  switch (dialStatus) {
    case 'busy':
      return twiml(`${say(`${customer}’s line is busy. Try again in a few minutes.`)}${HANGUP}`);
    case 'no-answer':
      return twiml(`${say(`${customer} didn’t answer.`)}${HANGUP}`);
    case 'failed':
      return twiml(`${say('That call didn’t go through.')}${HANGUP}`);
    default:
      return HANGUP_TWIML;
  }
}

export const BRIDGE_NOT_PLACED_TWIML = twiml(`${say('The call wasn’t placed. Goodbye.')}${HANGUP}`);

// ---------- confirming someone's cell ----------

export const VERIFY_WORDS = 'This is HandsFreeOS confirming this is your phone. Press 1.';

/** The call that confirms someone's cell: pressing 1 proves the phone is theirs. */
export function verifyTwiml(userPhoneId: string, urls: VoiceUrls): string {
  const gather = attrs({
    numDigits: 1,
    timeout: 5,
    action: urls.verifyResult(userPhoneId),
    method: 'POST',
  });
  return twiml(
    `<Gather${gather}>${say(VERIFY_WORDS)}<Pause length="1"/>${say(VERIFY_WORDS)}</Gather>${say('We didn’t hear a 1, so this phone isn’t confirmed. Goodbye.')}${HANGUP}`,
  );
}

export const VERIFIED_TWIML = twiml(`${say('Thanks. Your phone is confirmed. Goodbye.')}${HANGUP}`);
export const NOT_VERIFIED_TWIML = twiml(`${say('This phone isn’t confirmed. Goodbye.')}${HANGUP}`);
