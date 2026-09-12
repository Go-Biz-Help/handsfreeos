import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import {
  ProviderError,
  type Capabilities,
  type OutboundMessage,
  type ProviderAccount,
  type RegistrationKind,
  type RegistrationRequest,
  type TelephonyProvider,
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

export interface FakeTelephony extends TelephonyProvider {
  readonly sent: FakeSent[];
  /** Registration steps in the order they were submitted. */
  readonly registrations: RegistrationRequest[];
  /** Recording and transcription ids deleted at the "provider". */
  readonly deleted: string[];
}

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
 * turned down), and a number ending in 0000 is "no longer available".
 */
export function createFakeTelephony(opts: FakeOptions): FakeTelephony {
  const sent: FakeSent[] = [];
  const registrations: RegistrationRequest[] = [];
  const deleted: string[] = [];
  const owned = new Map<string, { sid: string; e164: string; accountSid: string }>();
  const regs = new Map<string, { at: number; reject: boolean }>();

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

  return {
    name: 'fake',
    masterAccountSid: FAKE_MASTER_SID,
    masterAuthToken: FAKE_AUTH_TOKEN,
    sent,
    registrations,
    deleted,
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
    async submitRegistration(_account, request) {
      registrations.push(request);
      const sid = fakeSid(SID_PREFIX[request.kind]);
      const legalName = String(request.submission['legalName'] ?? '');
      regs.set(sid, { at: Date.now(), reject: /reject/i.test(legalName) });
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
