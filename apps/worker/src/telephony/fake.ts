import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import {
  ProviderError,
  type Capabilities,
  type OutboundMessage,
  type PlaceCallRequest,
  type ProviderAccount,
  type RegistrationKind,
  type RegistrationRequest,
  type TelephonyProvider,
  type TranscriptionState,
} from './provider';
import { twilioSignature } from './signature';

/** Not secrets: the fake signs its callbacks with this token, and tests sign fixtures with it too. */
export const FAKE_MASTER_SID = 'ACfakemasteraccount';
export const FAKE_AUTH_TOKEN = 'fake-twilio-auth-token';
/** Signs the fake's browser call tokens (not a secret either). */
export const FAKE_VOICE_KEY_SECRET = 'fake-voice-key-secret';

const CAPS: Capabilities = { sms: true, mms: true, voice: true };
const SID_PREFIX: Record<RegistrationKind, string> = {
  toll_free_verification: 'HH',
  a2p_customer_profile: 'BU',
  a2p_trust_product: 'BU',
  a2p_brand: 'BN',
  a2p_campaign: 'QE',
};

/** Fake ids read like Twilio's but are not hex, so secret scanners never mistake them for keys. */
export const fakeSid = (prefix: string): string =>
  `${prefix}fake${randomBytes(12)
    .toString('base64url')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 12)}`;

export interface FakeSent extends OutboundMessage {
  readonly sid: string;
  readonly accountSid: string;
}

export interface FakeCall extends PlaceCallRequest {
  readonly sid: string;
  readonly accountSid: string;
}

export interface FakeTelephony extends TelephonyProvider {
  readonly sent: FakeSent[];
  /** Calls placed from business numbers (verification calls, and rings to people's own cells). */
  readonly calls: FakeCall[];
  /** Registration steps in the order they were submitted. */
  readonly registrations: RegistrationRequest[];
  /** Recording and transcription ids deleted at the "provider". */
  readonly deleted: string[];
  /** Call recordings whose words were asked for. */
  readonly transcribed: string[];
}

/** What the fake's transcripts say: the business's side on channel 1, the customer's on channel 2. */
export const FAKE_TRANSCRIPT = [
  { channel: 1, text: 'Hi, this is the office. Is now a good time to talk about the visit?' },
  { channel: 2, text: 'Yes, go ahead.' },
  { channel: 1, text: 'Great. We can be there Thursday at one.' },
] as const;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
const attr = (xml: string, tag: string, name: string): string | null => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);
  return m ? m[1]!.replace(/&amp;/g, '&') : null;
};

export interface FakeOptions {
  /** How long the fake carrier takes to approve a registration. */
  readonly approvalMs: number;
  /** Post signed status callbacks for sent texts (off in unit tests that post their own). */
  readonly callbacks: boolean;
  readonly log: Logger;
}

/**
 * An in-memory Twilio. Texts get "sent" then "delivered" callbacks (a body containing [fail] gets a
 * failure instead), registrations are approved after `approvalMs` (a legal name containing "reject" is
 * turned down, and so is a local number's campaign with an example text containing it), a number ending
 * in 0000 is "no longer available", and one ending in 0503 finds the carrier down on every try.
 *
 * Calls it places play out against the worker's own TwiML when callbacks are on: the phone answers and
 * presses 1, and a customer it dials picks up, talks for a few seconds and hangs up, leaving a recording. A cell
 * ending in 0404 never answers; one ending in 0405 answers but presses nothing (its voicemail); a customer
 * ending in 0486 is busy. A recording id containing "silent" has no words to transcribe.
 */
export function createFakeTelephony(opts: FakeOptions): FakeTelephony {
  const sent: FakeSent[] = [];
  const calls: FakeCall[] = [];
  const registrations: RegistrationRequest[] = [];
  const deleted: string[] = [];
  const transcribed: string[] = [];
  const transcripts = new Map<string, TranscriptionState>();
  const owned = new Map<string, { sid: string; e164: string; accountSid: string }>();
  const regs = new Map<string, { at: number; reject: boolean }>();
  const turnedDown = (request: RegistrationRequest) => {
    const samples = (request.submission['messageSamples'] ?? []) as unknown[];
    return (
      /reject/i.test(String(request.submission['legalName'] ?? '')) ||
      (request.kind === 'a2p_campaign' && samples.some((s) => /reject/i.test(String(s))))
    );
  };

  const callback = (
    url: string,
    token: string,
    params: Record<string, string>,
    delayMs: number,
  ) => {
    if (!opts.callbacks) return;
    const timer = setTimeout(() => {
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilioSignature(token, url, params),
        },
        body: new URLSearchParams(params),
      }).catch((e: unknown) => opts.log.warn({ err: e }, 'fake telephony callback failed'));
    }, delayMs);
    timer.unref();
  };

  /** A signed request to the worker, as Twilio makes it; its TwiML back (empty when it failed). */
  const post = async (url: string, token: string, params: Record<string, string>) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilioSignature(token, url, params),
        },
        body: new URLSearchParams(params),
      });
      return await res.text();
    } catch (e) {
      opts.log.warn({ err: e }, 'fake telephony callback failed');
      return '';
    }
  };

  /** A placed call, the way Twilio would run it against the worker's TwiML. */
  const playOut = async (account: ProviderAccount, c: FakeCall) => {
    const token = account.authToken;
    const base = {
      AccountSid: account.sid,
      CallSid: c.sid,
      From: c.from,
      To: c.to,
      Direction: 'outbound-api',
    };
    const status = (CallStatus: string, extra: Record<string, string> = {}) =>
      post(c.statusCallbackUrl, token, { ...base, CallStatus, ...extra });
    await wait(400);
    await status('ringing');
    await wait(800);
    if (c.to.endsWith('0404')) {
      await status('no-answer');
      return;
    }
    let twiml = await post(c.answerUrl, token, { ...base, CallStatus: 'in-progress' });
    let talked = 0;
    for (let step = 0; step < 4 && twiml; step++) {
      const gather = attr(twiml, 'Gather', 'action');
      if (gather) {
        await wait(600);
        const digits = c.to.endsWith('0405') ? '' : '1';
        twiml = await post(gather, token, { ...base, CallStatus: 'in-progress', Digits: digits });
        continue;
      }
      const dialed = /<Number\b[^>]*>([^<]+)<\/Number>/.exec(twiml)?.[1];
      const legStatus = attr(twiml, 'Number', 'statusCallback');
      const action = attr(twiml, 'Dial', 'action');
      if (!dialed || !legStatus || !action) break;
      const leg = {
        ...base,
        CallSid: fakeSid('CA'),
        ParentCallSid: c.sid,
        From: c.from,
        To: dialed,
        Direction: 'outbound-dial',
      };
      if (dialed.endsWith('0486')) {
        await post(legStatus, token, { ...leg, CallStatus: 'busy' });
        twiml = await post(action, token, {
          ...base,
          CallStatus: 'in-progress',
          DialCallStatus: 'busy',
        });
        continue;
      }
      await post(legStatus, token, { ...leg, CallStatus: 'ringing' });
      await wait(1000);
      await post(legStatus, token, { ...leg, CallStatus: 'in-progress' });
      await wait(3000);
      talked = 3;
      await post(legStatus, token, {
        ...leg,
        CallStatus: 'completed',
        CallDuration: String(talked),
      });
      const recording = attr(twiml, 'Dial', 'recordingStatusCallback');
      if (recording)
        await post(recording, token, {
          AccountSid: account.sid,
          CallSid: c.sid,
          RecordingSid: fakeSid('RE'),
          RecordingStatus: 'completed',
          RecordingDuration: String(talked),
          RecordingChannels: '2',
          RecordingSource: 'DialVerb',
        });
      twiml = await post(action, token, {
        ...base,
        CallStatus: 'in-progress',
        DialCallStatus: 'completed',
        DialCallDuration: String(talked),
      });
    }
    await status('completed', { CallDuration: String(talked + 5) });
  };

  return {
    name: 'fake',
    masterAccountSid: FAKE_MASTER_SID,
    masterAuthToken: FAKE_AUTH_TOKEN,
    sent,
    calls,
    registrations,
    deleted,
    transcribed,
    async createSubaccount() {
      return { sid: fakeSid('AC'), authToken: FAKE_AUTH_TOKEN };
    },
    async createMessagingService() {
      return fakeSid('MG');
    },
    async createApiKey() {
      return { sid: fakeSid('SK'), secret: FAKE_VOICE_KEY_SECRET };
    },
    async createTwimlApp() {
      return fakeSid('AP');
    },
    async searchNumbers({ numberType, areaCode, limit }) {
      const areas = areaCode
        ? [areaCode]
        : numberType === 'toll_free'
          ? ['833', '844', '855', '877']
          : ['713'];
      return Array.from({ length: Math.min(limit, 6) }, (_, i) => ({
        e164: `+1${areas[i % areas.length]}555${String(1000 + Math.floor(Math.random() * 8999))}`,
        locality: numberType === 'toll_free' ? null : 'Houston',
        region: numberType === 'toll_free' ? null : 'TX',
        capabilities: CAPS,
      }));
    },
    async findOwnedNumber(account: ProviderAccount, e164: string) {
      const n = [...owned.values()].find((x) => x.e164 === e164 && x.accountSid === account.sid);
      return n ? { sid: n.sid, capabilities: CAPS } : null;
    },
    async buyNumber(account, { e164 }) {
      if (e164.endsWith('0000'))
        throw new ProviderError('That number is no longer available.', '21422', true, 400);
      // Search never offers an ending below 1000, so only a test asks for this one.
      if (e164.endsWith('0503'))
        throw new ProviderError('Service Unavailable', '20503', false, 503);
      const sid = fakeSid('PN');
      owned.set(sid, { sid, e164, accountSid: account.sid });
      return { sid, capabilities: CAPS };
    },
    async addNumberToService() {},
    async releaseNumber(_account, sid) {
      owned.delete(sid);
    },
    async sendMessage(account, message) {
      const sid = fakeSid('SM');
      sent.push({ ...message, sid, accountSid: account.sid });
      const base = { AccountSid: account.sid, MessageSid: sid, From: message.from, To: message.to };
      if (message.body.includes('[fail]'))
        callback(
          message.statusCallbackUrl,
          account.authToken,
          { ...base, MessageStatus: 'failed', ErrorCode: '30006' },
          300,
        );
      else {
        callback(
          message.statusCallbackUrl,
          account.authToken,
          { ...base, MessageStatus: 'sent' },
          250,
        );
        callback(
          message.statusCallbackUrl,
          account.authToken,
          { ...base, MessageStatus: 'delivered' },
          700,
        );
      }
      return { sid, status: 'queued' };
    },
    async fetchMedia(_account, url) {
      if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        const head = url.slice(5, comma);
        const contentType = head.split(';')[0] || 'application/octet-stream';
        const data = Buffer.from(
          url.slice(comma + 1),
          head.includes(';base64') ? 'base64' : 'utf8',
        );
        return { data, contentType };
      }
      const res = await fetch(url);
      if (!res.ok)
        throw new ProviderError(
          `Media fetch failed (${res.status})`,
          String(res.status),
          res.status === 404,
        );
      return {
        data: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
    async deleteMedia() {},
    async fetchRecording() {
      return { data: voicemailAudio(), contentType: 'audio/wav' };
    },
    async deleteRecording(_account, recordingSid) {
      deleted.push(recordingSid);
    },
    async deleteTranscription(_account, transcriptionSid) {
      deleted.push(transcriptionSid);
    },
    async placeCall(account, request) {
      const c: FakeCall = { ...request, sid: fakeSid('CA'), accountSid: account.sid };
      calls.push(c);
      if (opts.callbacks) void playOut(account, c);
      return { sid: c.sid };
    },
    async transcribeRecording(_account, recordingSid) {
      transcribed.push(recordingSid);
      // A recording id with "Refused" in it plays an account without Conversational Intelligence turned on.
      if (/refused/i.test(recordingSid))
        throw new ProviderError('Conversational Intelligence is not enabled.', '20403', false, 403);
      const sid = fakeSid('GT');
      transcripts.set(
        sid,
        /silent/i.test(recordingSid)
          ? { status: 'failed' }
          : { status: 'completed', sentences: [...FAKE_TRANSCRIPT] },
      );
      return { transcriptionSid: sid };
    },
    async fetchTranscription(_account, transcriptionSid) {
      // A restarted fake forgets what it was asked; those words are the usual ones.
      return (
        transcripts.get(transcriptionSid) ?? {
          status: 'completed',
          sentences: [...FAKE_TRANSCRIPT],
        }
      );
    },
    async submitRegistration(_account, request) {
      registrations.push(request);
      // Sent again after a rejection: a campaign is replaced; a toll-free edit, a brand resubmission and a
      // Trust Hub bundle keep their id. Either way the carrier looks at the details anew.
      const kept = request.replaces && request.kind !== 'a2p_campaign' ? request.replaces : null;
      if (request.replaces && !kept) regs.delete(request.replaces);
      const sid = kept ?? fakeSid(SID_PREFIX[request.kind]);
      regs.set(sid, { at: Date.now(), reject: turnedDown(request) });
      return {
        providerSid: sid,
        providerStatus: 'PENDING_REVIEW',
        status: 'in_review',
        rejectionReason: null,
      };
    },
    async fetchRegistration(_account, { providerSid }) {
      const r = regs.get(providerSid);
      // A restarted fake forgets its registrations; treat those as approved.
      if (r && Date.now() - r.at < opts.approvalMs)
        return {
          providerSid,
          providerStatus: 'IN_REVIEW',
          status: 'in_review',
          rejectionReason: null,
        };
      if (r?.reject)
        return {
          providerSid,
          providerStatus: 'TWILIO_REJECTED',
          status: 'rejected',
          rejectionReason: 'The website does not show how customers agree to receive texts.',
        };
      return {
        providerSid,
        providerStatus: 'TWILIO_APPROVED',
        status: 'approved',
        rejectionReason: null,
      };
    },
  };
}

/** Three seconds of a soft two-note chime (8 kHz mono WAV): what the fake plays for every voicemail. */
function voicemailAudio(): Buffer {
  const rate = 8000;
  const samples = rate * 3;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const phase = t % 0.5;
    const hz = t % 1 < 0.5 ? 523 : 659;
    const envelope = Math.min(1, phase * 20) * Math.max(0, 1 - phase * 2);
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * t) * 2500 * envelope), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
