import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import {
  ProviderError,
  type Capabilities,
  type ContentTemplate,
  type ExternalNumber,
  type ExternalTwilioCreds,
  type LineCheck,
  type OutboundMessage,
  type PlaceCallRequest,
  type ProviderAccount,
  type RcsSenderInfo,
  type RegistrationKind,
  type NumberPortKind,
  type PortRequest,
  type RegistrationRequest,
  type TelephonyProvider,
  type TranscriptionState,
} from './provider';
import { fallbackOf } from './rcs-content';
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
  /** When the fake "carrier" took it, so usageDaily can bucket it by day. */
  readonly at: number;
  /**
   * How the "carrier" delivered it (0103): over RCS, or the SMS or MMS a phone without RCS gets instead. For a
   * rich text that fell back, `delivered` is what that phone was actually sent — the template's own fallback.
   */
  readonly via: 'rcs' | 'sms' | 'mms';
  readonly delivered: { readonly body: string; readonly mediaUrls: readonly string[] };
}

/** One of the fake's RCS senders (0103). */
export interface FakeRcsSender extends RcsSenderInfo {
  readonly accountSid: string;
}

/**
 * The fake's stand-in RCS senders, in every account (0103). Twilio makes senders only in its console, so locally
 * there is nothing to make: these are already "there" for Settings to find and connect.
 *
 * - `hfos_demo_agent` is approved and online;
 * - `hfos_review_agent` is with the carriers until `approvalMs` after it is first looked at, then online;
 * - `hfos_offline_agent` is offline.
 *
 * Any other id is not in the account, which is how a business that typed the wrong one hears so.
 */
export const FAKE_RCS_SENDERS = {
  online: 'hfos_demo_agent',
  review: 'hfos_review_agent',
  offline: 'hfos_offline_agent',
} as const;

/** A customer's phone that can't show RCS, in the fake: any number ending in 7. It gets the SMS or MMS instead. */
export const fakeCanShowRcs = (e164: string): boolean => !e164.endsWith('7');

export interface FakeCall extends PlaceCallRequest {
  readonly sid: string;
  readonly accountSid: string;
  readonly at: number;
}

export interface FakeTelephony extends TelephonyProvider {
  readonly sent: FakeSent[];
  /** Calls placed from business numbers (verification calls, and rings to people's own cells). */
  readonly calls: FakeCall[];
  /** The calls HandsFreeOS hung up (endCall), by sid. */
  readonly ended: string[];
  /** Live calls given new instructions (redirectCall), in order. */
  readonly redirected: { readonly callSid: string; readonly twiml: string }[];
  /** Live calls whose audio was sent to the worker (startCallStream), in order. */
  readonly streamed: {
    readonly callSid: string;
    readonly url: string;
    readonly params: Readonly<Record<string, string>>;
  }[];
  /** Registration steps in the order they were submitted. */
  readonly registrations: RegistrationRequest[];
  /** Ports asked for, in order, and the papers put on them. */
  readonly ports: PortRequest[];
  readonly portDocuments: { portSid: string; name: string }[];
  /** Ports called off, by sid. */
  readonly portsCancelled: string[];
  /** Numbers pointed at our webhooks after landing here, by sid. A bought one is never in this list. */
  readonly configured: string[];
  /** Numbers put on a messaging service, which is what lets one send. Nothing recorded this before. */
  readonly serviced: { serviceSid: string; numberSid: string }[];
  /** Recording and transcription ids deleted at the "provider". */
  readonly deleted: string[];
  /** Call recordings whose words were asked for. */
  readonly transcribed: string[];
  /** Subaccounts closed, by sid; their numbers are released with them. */
  readonly closedAccounts: string[];
  /** RCS senders the "carrier" has, by sid (0103). The stand-ins appear the first time an account is looked at. */
  readonly rcsSenders: Map<string, FakeRcsSender>;
  /** Which RCS sender sits in which messaging service's pool (0103): what makes a text go RCS first. */
  readonly rcsPools: Map<string, string>;
  /** Content templates made for rich texts, by sid, and the ones deleted once their message was done (0103). */
  readonly contents: Map<string, ContentTemplate & { readonly accountSid: string }>;
  readonly deletedContents: string[];
  /** Numbers the carrier lookup was asked about, in order (20261010000900). */
  readonly lookups: string[];
  /**
   * What the line check says about a number (AI calls, part 5), set by a test: anything not here is a mobile, and
   * its caller name is undetermined. Every check asked, in order, in `lineChecks`.
   */
  readonly lines: Map<string, LineCheck>;
  readonly lineChecks: {
    readonly e164: string;
    readonly lineType: boolean;
    readonly callerName: boolean;
  }[];
  /**
   * A business's own Twilio account, as if it had one (20261010000900): signed in to with `secret`, whether as
   * the account or as an API key. `parentSid` makes it a subaccount of another such account. Returns its sid.
   */
  addExternalAccount(input: {
    readonly sid?: string;
    readonly secret: string;
    readonly friendlyName?: string;
    readonly parentSid?: string;
  }): string;
  /** A number in one of those accounts, pointed wherever its owner points it today. Returns its sid (PN…). */
  addExternalNumber(
    accountSid: string,
    e164: string,
    urls?: { readonly smsUrl?: string | null; readonly voiceUrl?: string | null },
  ): string;
  /**
   * The owner's transfer request went through: the number leaves wherever it was (an account of theirs, or
   * HighLevel's) and lands in `toAccountSid`, still pointed at its old webhooks. Returns its sid there.
   */
  transferIn(e164: string, toAccountSid: string): string;
  /** Somebody deleted this API key in the Twilio console: `hasApiKey` says it is gone from then on. */
  deleteApiKey(keySid: string): void;
  /**
   * Somebody rotated this subaccount's Auth Token in the Twilio console. From then on sending a text refuses the
   * old token, the subaccount's webhooks are signed with the new one, and `subaccountToken` reads it. Returns
   * the new token: `token`, or a made-up one.
   */
  rotateSubaccountToken(accountSid: string, token?: string): string;
}

/** What the fake says a text and a call cost it, in micro-dollars: Twilio's own list prices. */
export const FAKE_COST_MICROS = { sms: 10_900, call: 13_000 } as const;

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
  /**
   * A thumb on the scale for `usageDaily`: 0.2 makes the "carrier" report every category a fifth dearer than
   * we counted. That disagreement is the whole reason the reconciler exists, so a test needs a way to cause one.
   */
  readonly usageFudgeMicros?: number;
  /**
   * Local runs only: a number HandsFreeOS is watching for (one it looked up, or one sitting in a stand-in
   * account) arrives in the account watching for it this long after the first look, as if its owner had sent
   * the transfer request. Unset, a number only ever arrives through `transferIn`. A number ending 0002 never
   * does — its owner never sent the request — so the waiting screen can be seen as it stays.
   */
  readonly autoTransferMs?: number | null;
}

/**
 * An in-memory Twilio. Texts get "sent" then "delivered" callbacks (a body containing [fail] gets a
 * failure instead). With an online RCS sender in the messaging service's pool (0103) a text goes over RCS —
 * callbacks from `rcs:<sender>`, and a "read" after the "delivered" — unless the customer's number ends in 7,
 * which plays a phone without RCS and gets the SMS or MMS from the thread's number instead. Registrations
 * are approved after `approvalMs` (a legal name containing "reject" is
 * turned down, and so is a local number's campaign with an example text containing it), a number ending
 * in 0000 is "no longer available", and one ending in 0503 finds the carrier down on every try.
 *
 * A port is turned down for a number ending 0000, sat on for one ending 0001, and otherwise moves once
 * `approvalMs` has passed — at which point the carrier hands a full port's number over, so it becomes one
 * of the account's own like a bought one.
 *
 * Calls it places play out against the worker's own TwiML when callbacks are on: the phone answers and
 * presses 1, and a customer it dials picks up, talks for a few seconds and hangs up, leaving a recording. A cell
 * ending in 0404 never answers; one ending in 0405 answers but presses nothing (its voicemail); a customer
 * ending in 0486 is busy. A recording id containing "silent" has no words to transcribe. A call hung up with endCall
 * stops where it is and reports how it ended, as Twilio does.
 */
export function createFakeTelephony(opts: FakeOptions): FakeTelephony {
  const sent: FakeSent[] = [];
  const calls: FakeCall[] = [];
  const ended: string[] = [];
  const redirected: { callSid: string; twiml: string }[] = [];
  const streamed: { callSid: string; url: string; params: Readonly<Record<string, string>> }[] = [];
  const registrations: RegistrationRequest[] = [];
  const deleted: string[] = [];
  const transcribed: string[] = [];
  const closedAccounts: string[] = [];
  const transcripts = new Map<string, TranscriptionState>();
  /** Numbers in our own subaccounts. One transferred in keeps pointing where its old owner had it. */
  const owned = new Map<
    string,
    {
      sid: string;
      e164: string;
      accountSid: string;
      smsUrl?: string | null;
      voiceUrl?: string | null;
    }
  >();
  const regs = new Map<string, { at: number; reject: boolean }>();
  const ports: PortRequest[] = [];
  const portDocuments: { portSid: string; name: string }[] = [];
  const portsCancelled: string[] = [];
  const configured: string[] = [];
  const serviced: { serviceSid: string; numberSid: string }[] = [];
  const portRows = new Map<
    string,
    { at: number; e164: string; kind: NumberPortKind; numberSid?: string }
  >();
  const rcsSenders = new Map<string, FakeRcsSender>();
  /** When each stand-in was first looked at, so the one in review can be approved `approvalMs` later. */
  const rcsSeenAt = new Map<string, number>();
  const rcsPools = new Map<string, string>();
  const contents = new Map<string, ContentTemplate & { accountSid: string }>();
  const deletedContents: string[] = [];
  const lookups: string[] = [];
  const lines = new Map<string, LineCheck>();
  const lineChecks: FakeTelephony['lineChecks'] = [];
  /** Businesses' own Twilio accounts (20261010000900), and the numbers in them. */
  const externalAccounts = new Map<
    string,
    { sid: string; secret: string; friendlyName: string; parentSid: string | null }
  >();
  const externalNumbers = new Map<
    string,
    {
      sid: string;
      accountSid: string;
      e164: string;
      smsUrl: string | null;
      voiceUrl: string | null;
    }
  >();
  /** When each account first looked for a number that had not arrived, for `autoTransferMs`. */
  const firstLooked = new Map<string, number>();
  /** Our own subaccounts, so one given back to us as "somebody else's" can be recognised. */
  const subaccounts = new Set<string>();
  /** API keys deleted "in the console" (deleteApiKey). Every other key is still there. */
  const deletedApiKeys = new Set<string>();
  /** Subaccount tokens rotated "in the console" (rotateSubaccountToken). Every other one is as it was made. */
  const rotatedTokens = new Map<string, string>();
  /** What Twilio signs an account's webhooks with: the rotated token once there is one. */
  const signingToken = (account: ProviderAccount) =>
    rotatedTokens.get(account.sid) ?? account.authToken;

  const unauthorised = (accountSid?: string) =>
    new ProviderError('Authenticate', '20003', false, 401, accountSid);

  /** A stand-in account for a local run: three numbers, one of them in use by HighLevel. */
  const demoAccount = (sid: string, secret: string) => {
    externalAccounts.set(sid, { sid, secret, friendlyName: 'My Twilio', parentSid: null });
    const middle = () => String(200 + Math.floor(Math.random() * 799));
    addExternalNumber(sid, `+1256${middle()}${String(1000 + Math.floor(Math.random() * 8999))}`, {
      smsUrl: 'https://services.leadconnectorhq.com/phone-system/twilio/inbound-sms',
      voiceUrl: 'https://services.leadconnectorhq.com/phone-system/twilio/voice',
    });
    addExternalNumber(sid, `+1713${middle()}${String(1000 + Math.floor(Math.random() * 8999))}`);
    addExternalNumber(sid, `+1833${middle()}${String(1000 + Math.floor(Math.random() * 8999))}`);
  };

  /** Signs in the way Twilio does: the account's secret, whichever name it is given under. */
  const signIn = (creds: ExternalTwilioCreds) => {
    if (creds.accountSid === FAKE_MASTER_SID || subaccounts.has(creds.accountSid)) {
      if (creds.secret !== (rotatedTokens.get(creds.accountSid) ?? FAKE_AUTH_TOKEN))
        throw unauthorised();
      return {
        sid: creds.accountSid,
        friendlyName: 'HandsFreeOS',
        parentSid: creds.accountSid === FAKE_MASTER_SID ? null : FAKE_MASTER_SID,
      };
    }
    let a = externalAccounts.get(creds.accountSid);
    if (!a) {
      if (/wrong/i.test(creds.secret)) throw unauthorised();
      demoAccount(creds.accountSid, creds.secret);
      a = externalAccounts.get(creds.accountSid)!;
    }
    if (a.secret !== creds.secret) throw unauthorised();
    return a;
  };

  function addExternalNumber(
    accountSid: string,
    e164: string,
    urls: { readonly smsUrl?: string | null; readonly voiceUrl?: string | null } = {},
  ): string {
    const sid = fakeSid('PN');
    externalNumbers.set(sid, {
      sid,
      accountSid,
      e164,
      smsUrl: urls.smsUrl ?? null,
      voiceUrl: urls.voiceUrl ?? null,
    });
    return sid;
  }

  function transferIn(e164: string, toAccountSid: string): string {
    const already = [...owned.values()].find((x) => x.e164 === e164);
    if (already?.accountSid === toAccountSid) return already.sid;
    if (already) owned.delete(already.sid);
    const from = [...externalNumbers.values()].find((x) => x.e164 === e164);
    if (from) externalNumbers.delete(from.sid);
    const sid = from?.sid ?? already?.sid ?? fakeSid('PN');
    owned.set(sid, {
      sid,
      e164,
      accountSid: toAccountSid,
      smsUrl: from?.smsUrl ?? already?.smsUrl ?? null,
      voiceUrl: from?.voiceUrl ?? already?.voiceUrl ?? null,
    });
    return sid;
  }

  /** The stand-in senders of an account, as they stand now: the one in review comes online with time. */
  const standIns = (accountSid: string): FakeRcsSender[] =>
    Object.entries(FAKE_RCS_SENDERS).map(([kind, senderId]) => {
      const key = `${accountSid}|${senderId}`;
      const existing = [...rcsSenders.values()].find(
        (x) => x.accountSid === accountSid && x.senderId === senderId,
      );
      const seen = rcsSeenAt.get(key) ?? Date.now();
      rcsSeenAt.set(key, seen);
      const reviewing = kind === 'review' && Date.now() - seen < opts.approvalMs;
      const sender: FakeRcsSender = {
        accountSid,
        sid: existing?.sid ?? fakeSid('XE'),
        senderId,
        displayName: kind === 'online' ? 'Stand-in RCS sender' : `Stand-in RCS sender (${kind})`,
        providerStatus: kind === 'offline' ? 'OFFLINE' : reviewing ? 'TWILIO_REVIEW' : 'ONLINE',
        state: kind === 'offline' ? 'offline' : reviewing ? 'in_review' : 'online',
        reason: kind === 'offline' ? 'The carriers took this sender down.' : null,
      };
      rcsSenders.set(sender.sid, sender);
      return sender;
    });
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
    const token = signingToken(account);
    const base = {
      AccountSid: account.sid,
      CallSid: c.sid,
      From: c.from,
      To: c.to,
      Direction: 'outbound-api',
    };
    const status = (CallStatus: string, extra: Record<string, string> = {}) =>
      post(c.statusCallbackUrl, token, { ...base, CallStatus, ...extra });
    let answered = false;
    // Hung up by HandsFreeOS (endCall): it reports how it ended and plays no further.
    const hungUp = async () => {
      if (!ended.includes(c.sid)) return false;
      await status(answered ? 'completed' : 'canceled');
      return true;
    };
    await wait(400);
    if (await hungUp()) return;
    await status('ringing');
    await wait(800);
    if (await hungUp()) return;
    if (c.to.endsWith('0404')) {
      await status('no-answer');
      return;
    }
    answered = true;
    let twiml = await post(c.answerUrl, token, { ...base, CallStatus: 'in-progress' });
    let talked = 0;
    for (let step = 0; step < 4 && twiml; step++) {
      const gather = attr(twiml, 'Gather', 'action');
      if (gather) {
        await wait(600);
        if (await hungUp()) return;
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
      if (ended.includes(c.sid)) {
        // Hung up while the customer's phone rang: their leg ends with the call.
        await post(legStatus, token, { ...leg, CallStatus: 'canceled' });
        await hungUp();
        return;
      }
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
    ended,
    redirected,
    streamed,
    registrations,
    ports,
    portDocuments,
    portsCancelled,
    configured,
    serviced,
    deleted,
    transcribed,
    closedAccounts,
    rcsSenders,
    rcsPools,
    contents,
    deletedContents,
    lookups,
    lines,
    lineChecks,
    addExternalAccount({ sid, secret, friendlyName, parentSid }) {
      const id = sid ?? fakeSid('AC');
      externalAccounts.set(id, {
        sid: id,
        secret,
        friendlyName: friendlyName ?? 'My Twilio',
        parentSid: parentSid ?? null,
      });
      return id;
    },
    addExternalNumber,
    transferIn,
    async createSubaccount() {
      const sid = fakeSid('AC');
      subaccounts.add(sid);
      return { sid, authToken: FAKE_AUTH_TOKEN };
    },
    async subaccountToken(accountSid) {
      return (
        rotatedTokens.get(accountSid) ?? (subaccounts.has(accountSid) ? FAKE_AUTH_TOKEN : null)
      );
    },
    rotateSubaccountToken(accountSid, token = `fake-rotated-${randomBytes(8).toString('hex')}`) {
      rotatedTokens.set(accountSid, token);
      return token;
    },
    async closeSubaccount(accountSid) {
      if (!closedAccounts.includes(accountSid)) closedAccounts.push(accountSid);
      for (const [sid, n] of owned) if (n.accountSid === accountSid) owned.delete(sid);
    },
    async createMessagingService() {
      return fakeSid('MG');
    },
    async createApiKey() {
      return { sid: fakeSid('SK'), secret: FAKE_VOICE_KEY_SECRET };
    },
    async hasApiKey(_account, keySid) {
      return !deletedApiKeys.has(keySid);
    },
    deleteApiKey(keySid) {
      deletedApiKeys.add(keySid);
    },
    async createTwimlApp() {
      return fakeSid('AP');
    },
    async configureNumber(_account, numberSid, urls) {
      configured.push(numberSid);
      const n = owned.get(numberSid);
      if (n) owned.set(numberSid, { ...n, smsUrl: urls.smsUrl, voiceUrl: urls.voiceUrl });
    },
    async searchNumbers({ numberType, areaCode, contains, city, state, withinMiles, limit }) {
      const areas = areaCode
        ? [areaCode]
        : numberType === 'toll_free'
          ? ['833', '844', '855', '877']
          : ['713'];
      // What was asked for is what comes back: the digits really are in the number, the city really is its city.
      const wanted = (contains ?? '').replace(/[^0-9]/g, '').slice(0, 7);
      return Array.from({ length: Math.min(limit, 6) }, (_, i) => {
        const line = `555${String(1000 + Math.floor(Math.random() * 8999))}`;
        return {
          e164: `+1${areas[i % areas.length]}${wanted}${line.slice(wanted.length)}`,
          // Widened to a radius, the towns around the city answer too — the second one stands in for them.
          locality:
            numberType === 'toll_free'
              ? null
              : withinMiles && i % 2 === 1
                ? 'Madison'
                : city || 'Houston',
          region: numberType === 'toll_free' ? null : state || 'TX',
          capabilities: CAPS,
        };
      });
    },
    async listOwnedNumbers(account, { limit }) {
      return [...owned.values()]
        .filter((n) => n.accountSid === account.sid)
        .slice(0, limit)
        .map((n) => ({
          sid: n.sid,
          e164: n.e164,
          friendlyName: n.e164,
          capabilities: n.e164.startsWith('+18') ? { ...CAPS, mms: false } : CAPS,
          smsUrl: n.smsUrl ?? null,
          voiceUrl: n.voiceUrl ?? null,
        }));
    },
    async findOwnedNumber(account: ProviderAccount, e164: string) {
      const n = [...owned.values()].find((x) => x.e164 === e164 && x.accountSid === account.sid);
      if (n) return { sid: n.sid, capabilities: CAPS };
      // Local runs: a number being watched for arrives a little later, as if its owner sent the request.
      const watched =
        lookups.includes(e164) || [...externalNumbers.values()].some((x) => x.e164 === e164);
      if (opts.autoTransferMs == null || !watched || e164.endsWith('0002')) return null;
      const key = `${account.sid}|${e164}`;
      const since = firstLooked.get(key) ?? Date.now();
      firstLooked.set(key, since);
      if (Date.now() - since < opts.autoTransferMs) return null;
      return { sid: transferIn(e164, account.sid), capabilities: CAPS };
    },
    /**
     * Who hosts a number (20261010000900). Twilio, unless it ends 0009 (another carrier: it needs a port) or
     * 0008 (the lookup is down, which must never stop an import from being watched for).
     */
    async lookupNumber(e164) {
      lookups.push(e164);
      if (e164.endsWith('0008'))
        throw new ProviderError('Service Unavailable', '20503', false, 503);
      if (e164.endsWith('0009')) return { carrierName: 'Verizon Wireless', lineType: 'mobile' };
      return {
        carrierName: e164.startsWith('+18')
          ? 'Twilio - Toll-Free - SMS-Sybase365/MMS-SVR'
          : 'Twilio - SMS/MMS-SVR',
        lineType: e164.startsWith('+18') ? 'tollFree' : 'nonFixedVoip',
      };
    },
    async checkLine(_account, e164, ask) {
      lineChecks.push({ e164, ...ask });
      const line = lines.get(e164) ?? { lineType: 'mobile', callerType: 'UNDETERMINED' };
      return {
        lineType: ask.lineType ? line.lineType : null,
        callerType: ask.callerName ? line.callerType : null,
      };
    },
    async inspectAccount(creds) {
      const a = signIn(creds);
      return {
        sid: a.sid,
        friendlyName: a.friendlyName,
        status: 'active',
        ownerAccountSid: a.parentSid,
      };
    },
    async listAccountNumbers(creds, { limit }) {
      const a = signIn(creds);
      const names = new Map(
        [...externalAccounts.values()]
          .filter((x) => x.sid === a.sid || x.parentSid === a.sid)
          .map((x) => [x.sid, x.friendlyName]),
      );
      const out: ExternalNumber[] = [...externalNumbers.values()]
        .filter((n) => names.has(n.accountSid))
        .map((n) => ({
          sid: n.sid,
          accountSid: n.accountSid,
          accountName: names.get(n.accountSid) ?? null,
          e164: n.e164,
          friendlyName: n.e164,
          capabilities: n.e164.startsWith('+18') ? { ...CAPS, mms: false } : CAPS,
          smsUrl: n.smsUrl,
          voiceUrl: n.voiceUrl,
        }));
      return out.slice(0, limit);
    },
    async buyNumber(account, { e164, urls }) {
      if (e164.endsWith('0000'))
        throw new ProviderError('That number is no longer available.', '21422', true, 400);
      // Search never offers an ending below 1000, so only a test asks for this one.
      if (e164.endsWith('0503'))
        throw new ProviderError('Service Unavailable', '20503', false, 503);
      const sid = fakeSid('PN');
      owned.set(sid, {
        sid,
        e164,
        accountSid: account.sid,
        smsUrl: urls.smsUrl,
        voiceUrl: urls.voiceUrl,
      });
      return { sid, capabilities: CAPS };
    },
    async addNumberToService(_account, serviceSid, numberSid) {
      serviced.push({ serviceSid, numberSid });
    },
    async releaseNumber(_account, sid) {
      owned.delete(sid);
    },
    async sendMessage(account, message) {
      if (rotatedTokens.has(account.sid) && account.authToken !== rotatedTokens.get(account.sid))
        throw unauthorised(account.sid);
      const sid = fakeSid('SM');
      const template = message.contentSid ? contents.get(message.contentSid) : undefined;
      if (message.contentSid && !template)
        throw new ProviderError('The content template does not exist.', '21655', true, 400);
      /*
       * RCS first, as Twilio does it (0103): an online sender in the service's pool is tried for every text sent
       * through the service, and a phone that can't show RCS gets the SMS or MMS instead — from `from`, which is
       * the `FallbackFrom` the worker names.
       */
      const pooled = message.messagingServiceSid
        ? rcsSenders.get(rcsPools.get(message.messagingServiceSid) ?? '')
        : undefined;
      const overRcs = !!pooled && pooled.state === 'online' && fakeCanShowRcs(message.to);
      const plain = template
        ? fallbackOf(template)
        : { body: message.body, mediaUrls: message.mediaUrls };
      const via = overRcs ? 'rcs' : plain.mediaUrls.length > 0 ? 'mms' : 'sms';
      sent.push({
        ...message,
        sid,
        accountSid: account.sid,
        at: Date.now(),
        via,
        delivered: overRcs ? { body: message.body, mediaUrls: message.mediaUrls } : plain,
      });
      const base = {
        AccountSid: account.sid,
        MessageSid: sid,
        From: overRcs ? `rcs:${pooled.senderId}` : message.from,
        To: message.to,
        ...(message.messagingServiceSid
          ? { MessagingServiceSid: message.messagingServiceSid }
          : {}),
        ...(overRcs ? { ChannelPrefix: 'rcs' } : {}),
      };
      if (message.body.includes('[fail]'))
        callback(
          message.statusCallbackUrl,
          signingToken(account),
          { ...base, MessageStatus: 'failed', ErrorCode: '30006' },
          300,
        );
      else {
        callback(
          message.statusCallbackUrl,
          signingToken(account),
          { ...base, MessageStatus: 'sent' },
          250,
        );
        callback(
          message.statusCallbackUrl,
          signingToken(account),
          { ...base, MessageStatus: 'delivered' },
          700,
        );
        // RCS tells the business when the customer opened it; an SMS never does.
        if (overRcs)
          callback(
            message.statusCallbackUrl,
            signingToken(account),
            { ...base, MessageStatus: 'read', EventType: 'READ' },
            1500,
          );
      }
      return { sid, status: 'queued' };
    },
    async listRcsSenders(account) {
      standIns(account.sid);
      return [...rcsSenders.values()].filter((x) => x.accountSid === account.sid);
    },
    async fetchRcsSender(account, sid) {
      standIns(account.sid);
      const found = rcsSenders.get(sid);
      return found && found.accountSid === account.sid ? found : null;
    },
    async addRcsSenderToService(account, serviceSid, senderSid) {
      const found = rcsSenders.get(senderSid);
      if (!found || found.accountSid !== account.sid)
        throw new ProviderError('The requested resource was not found', '20404', true, 404);
      rcsPools.set(serviceSid, senderSid);
    },
    async removeRcsSenderFromService(_account, serviceSid, senderSid) {
      if (rcsPools.get(serviceSid) === senderSid) rcsPools.delete(serviceSid);
    },
    async createContent(account, template) {
      if (!template.types['twilio/text'])
        throw new ProviderError('A template needs a text fallback.', '20001', true, 400);
      const sid = fakeSid('HX');
      contents.set(sid, { ...template, accountSid: account.sid });
      return { sid };
    },
    async deleteContent(_account, contentSid) {
      contents.delete(contentSid);
      deletedContents.push(contentSid);
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
      const c: FakeCall = {
        ...request,
        sid: fakeSid('CA'),
        accountSid: account.sid,
        at: Date.now(),
      };
      calls.push(c);
      if (opts.callbacks) void playOut(account, c);
      return { sid: c.sid };
    },
    async endCall(_account, callSid) {
      if (!ended.includes(callSid)) ended.push(callSid);
    },
    async redirectCall(_account, callSid, twiml) {
      redirected.push({ callSid, twiml });
    },
    async startCallStream(_account, callSid, stream) {
      streamed.push({ callSid, url: stream.url, params: stream.params });
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

    /**
     * Moving a number in (M17). Driven by the same two levers the rest of this file uses: `approvalMs` decides
     * how long the carrier "takes", and a magic suffix picks the unhappy path, so a test can walk a port all
     * the way through or watch one be turned down without waiting or stubbing.
     *
     * - `…0000` the losing carrier refuses it (a wrong PIN, a number under contract).
     * - `…0001` it sticks in `carrier_review` forever, which is the case a business actually complains about.
     * - anything else moves: submitted → carrier_review → scheduled → complete.
     *
     * Hosted messaging is the same machine and a different promise: voice stays where it is, so a test can
     * assert we never touched the calls.
     */
    async submitPort(_account, request) {
      ports.push(request);
      const sid = fakeSid('PO');
      portRows.set(sid, { at: Date.now(), e164: request.e164, kind: request.kind });
      return {
        providerSid: sid,
        providerStatus: 'PENDING_LOA',
        status: 'submitted',
        rejectionReason: null,
        scheduledFor: null,
      };
    },
    async fetchPort(account, providerSid) {
      const p = portRows.get(providerSid);
      // A restarted fake forgets its ports; treat those as done rather than hanging a test forever.
      if (!p)
        return {
          providerSid,
          providerStatus: 'COMPLETED',
          status: 'complete',
          rejectionReason: null,
          scheduledFor: null,
        };
      if (p.e164.endsWith('0000'))
        return {
          providerSid,
          providerStatus: 'CARRIER_REJECTED',
          status: 'rejected',
          rejectionReason: 'The account number or PIN did not match the losing carrier’s records.',
          scheduledFor: null,
        };
      const waited = Date.now() - p.at;
      if (p.e164.endsWith('0001') || waited < opts.approvalMs)
        return {
          providerSid,
          providerStatus: 'IN_PROGRESS',
          status: 'carrier_review',
          rejectionReason: null,
          scheduledFor: null,
        };
      /*
       * Past the wait: the carrier has named a day and then moved it — **and hands the number over**,
       * which is the half a fake is most likely to forget. A real carrier puts a ported-in number in the
       * account like any other, which is what lets it be pointed at our webhooks; without that here,
       * `findOwnedNumber` answered null and a full port landed with nobody listening on it.
       *
       * Once, remembered on the port, so polling twice does not mint a second number.
       *
       * **Only a full port.** Hosted messaging leaves the line with the old carrier for calls and has no
       * incoming-number row of its own — the messaging service is the whole arrangement.
       */
      if (p.kind === 'full' && !p.numberSid) {
        p.numberSid = fakeSid('PN');
        owned.set(p.numberSid, { sid: p.numberSid, e164: p.e164, accountSid: account.sid });
      }
      return {
        providerSid,
        providerStatus: 'COMPLETED',
        status: 'complete',
        rejectionReason: null,
        scheduledFor: new Date(p.at + opts.approvalMs).toISOString().slice(0, 10),
      };
    },
    async uploadPortDocument(_account, { portSid, name }) {
      portDocuments.push({ portSid, name });
      return { sid: fakeSid('RI') };
    },
    async cancelPort(_account, providerSid) {
      portsCancelled.push(providerSid);
      portRows.delete(providerSid);
    },

    /**
     * What the "carrier" says this business used. The fake bills from what it was actually asked to send and
     * dial, so a test can drive a text and a call through and then reconcile against them — which is the only
     * way to test that the reconciler writes a real difference and not a made-up one.
     *
     * `usageFudgeMicros` is the thumb on the scale: set it and every category comes back that much dearer than
     * we counted, which is the case the reconciler exists for.
     */
    async usageDaily(account, range) {
      const within = (at: number) => {
        const day = new Date(at).toISOString().slice(0, 10);
        return day >= range.start && day <= range.end;
      };
      const byDay = new Map<string, { count: number; micros: number }>();
      const add = (at: number, category: string, micros: number) => {
        if (!within(at)) return;
        const key = `${new Date(at).toISOString().slice(0, 10)}|${category}`;
        const row = byDay.get(key) ?? { count: 0, micros: 0 };
        byDay.set(key, { count: row.count + 1, micros: row.micros + micros });
      };
      for (const m of sent)
        if (m.accountSid === account.sid) add(m.at, 'sms-outbound', FAKE_COST_MICROS.sms);
      for (const c of calls)
        if (c.accountSid === account.sid) add(c.at, 'calls-outbound', FAKE_COST_MICROS.call);
      return [...byDay.entries()].map(([key, v]) => {
        const [day, category] = key.split('|') as [string, string];
        return {
          day,
          category,
          count: v.count,
          costMicros: v.micros + Math.round(v.micros * (opts.usageFudgeMicros ?? 0)),
        };
      });
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
