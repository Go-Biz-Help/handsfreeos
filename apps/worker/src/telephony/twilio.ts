/**
 * Twilio over plain HTTPS (no SDK): the master account creates one subaccount per workspace, and each
 * workspace's numbers, messages and registrations live in its subaccount.
 */
import {
  ProviderError,
  type AvailableNumber,
  type Capabilities,
  type ProviderAccount,
  type RegistrationState,
  type TelephonyProvider,
} from './provider';

const API = 'https://api.twilio.com/2010-04-01';
const MESSAGING = 'https://messaging.twilio.com/v1';

interface Creds {
  readonly sid: string;
  readonly token: string;
}
type Params = Readonly<Record<string, string | readonly string[] | undefined>>;

function form(params: Params): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) body.append(k, x);
    else body.append(k, v as string);
  }
  return body;
}

/** 4xx answers about the request itself are permanent; auth, throttling and server trouble are retried. */
function providerError(
  status: number,
  json: { code?: number; message?: string; more_info?: string },
) {
  const permanent = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
  return new ProviderError(
    json.message ?? `Twilio answered ${status}`,
    String(json.code ?? status),
    permanent,
    status,
  );
}

async function call<T>(
  creds: Creds,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  params?: Params,
): Promise<T> {
  const target = method === 'GET' && params ? `${url}?${form(params).toString()}` : url;
  const res = await fetch(target, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.sid}:${creds.token}`).toString('base64')}`,
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' && params ? { body: form(params) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw providerError(res.status, json as { code?: number; message?: string });
  return json as T;
}

const credsOf = (a: ProviderAccount): Creds => ({ sid: a.sid, token: a.authToken });
const caps = (c: Record<string, boolean | undefined> | undefined): Capabilities => ({
  sms: !!(c?.['sms'] ?? c?.['SMS']),
  mms: !!(c?.['mms'] ?? c?.['MMS']),
  voice: !!(c?.['voice'] ?? c?.['Voice']),
});

const MESSAGE_VOLUME: Record<string, string> = {
  under_1000: '1,000',
  '1000_10000': '10,000',
  '10000_100000': '100,000',
  over_100000: '250,000',
};
const USE_CASES: Record<string, readonly string[]> = {
  customer_care: ['CUSTOMER_CARE', 'ACCOUNT_NOTIFICATIONS'],
  mixed: ['CUSTOMER_CARE', 'ACCOUNT_NOTIFICATIONS', 'MARKETING'],
  marketing: ['MARKETING'],
};
const TOLL_FREE_STATUS: Record<string, RegistrationState['status']> = {
  PENDING_REVIEW: 'in_review',
  IN_REVIEW: 'in_review',
  TWILIO_APPROVED: 'approved',
  TWILIO_REJECTED: 'rejected',
};

/** Since Feb 2026 toll-free verification needs the business type and, except for sole proprietors, the EIN. */
const TOLL_FREE_BUSINESS_TYPE: Record<string, string> = {
  llc: 'PRIVATE_PROFIT',
  corporation: 'PRIVATE_PROFIT',
  partnership: 'PRIVATE_PROFIT',
  sole_proprietor: 'SOLE_PROPRIETOR',
  non_profit: 'NON_PROFIT',
};

interface Business {
  legalName: string;
  businessType: string;
  website: string;
  ein?: string | null;
  address: { line1: string; city: string; state: string; postalCode: string; country?: string };
  contact: { firstName: string; lastName: string; email: string; phone: string };
  useCase: string;
  messageSamples: string[];
  optInDescription: string;
  monthlyVolume: string;
}

export function createTwilioTelephony(master: {
  accountSid: string;
  authToken: string;
}): TelephonyProvider {
  const masterCreds: Creds = { sid: master.accountSid, token: master.authToken };
  return {
    name: 'twilio',
    masterAccountSid: master.accountSid,
    masterAuthToken: master.authToken,

    async createSubaccount(friendlyName) {
      const res = await call<{ sid: string; auth_token: string }>(
        masterCreds,
        'POST',
        `${API}/Accounts.json`,
        {
          FriendlyName: friendlyName,
        },
      );
      return { sid: res.sid, authToken: res.auth_token };
    },

    async createMessagingService(account, opts) {
      const res = await call<{ sid: string }>(credsOf(account), 'POST', `${MESSAGING}/Services`, {
        FriendlyName: opts.friendlyName,
        InboundRequestUrl: opts.inboundUrl,
        InboundMethod: 'POST',
        StatusCallback: opts.statusCallbackUrl,
        UseInboundWebhookOnNumber: 'false',
      });
      return res.sid;
    },

    async searchNumbers({ numberType, areaCode, contains, limit }) {
      const res = await call<{
        available_phone_numbers: {
          phone_number: string;
          locality: string | null;
          region: string | null;
          capabilities: Record<string, boolean>;
        }[];
      }>(
        masterCreds,
        'GET',
        `${API}/Accounts/${master.accountSid}/AvailablePhoneNumbers/US/${numberType === 'toll_free' ? 'TollFree' : 'Local'}.json`,
        {
          SmsEnabled: 'true',
          MmsEnabled: 'true',
          VoiceEnabled: 'true',
          PageSize: String(limit),
          ...(areaCode && numberType === 'local' ? { AreaCode: areaCode } : {}),
          ...(contains ? { Contains: contains } : {}),
        },
      );
      return res.available_phone_numbers.map((n): AvailableNumber => ({
        e164: n.phone_number,
        locality: n.locality || null,
        region: n.region || null,
        capabilities: caps(n.capabilities),
      }));
    },

    async findOwnedNumber(account, e164) {
      const res = await call<{
        incoming_phone_numbers: { sid: string; capabilities: Record<string, boolean> }[];
      }>(credsOf(account), 'GET', `${API}/Accounts/${account.sid}/IncomingPhoneNumbers.json`, {
        PhoneNumber: e164,
      });
      const n = res.incoming_phone_numbers[0];
      return n ? { sid: n.sid, capabilities: caps(n.capabilities) } : null;
    },

    async buyNumber(account, { e164, urls }) {
      const res = await call<{ sid: string; capabilities: Record<string, boolean> }>(
        credsOf(account),
        'POST',
        `${API}/Accounts/${account.sid}/IncomingPhoneNumbers.json`,
        {
          PhoneNumber: e164,
          SmsUrl: urls.smsUrl,
          SmsMethod: 'POST',
          VoiceUrl: urls.voiceUrl,
          VoiceMethod: 'POST',
          StatusCallback: urls.voiceStatusUrl,
          StatusCallbackMethod: 'POST',
        },
      );
      return { sid: res.sid, capabilities: caps(res.capabilities) };
    },

    async addNumberToService(account, serviceSid, numberSid) {
      try {
        await call(credsOf(account), 'POST', `${MESSAGING}/Services/${serviceSid}/PhoneNumbers`, {
          PhoneNumberSid: numberSid,
        });
      } catch (e) {
        // 21710: the number is already in this service.
        if (!(e instanceof ProviderError && e.code === '21710')) throw e;
      }
    },

    async releaseNumber(account, numberSid) {
      try {
        await call(
          credsOf(account),
          'DELETE',
          `${API}/Accounts/${account.sid}/IncomingPhoneNumbers/${numberSid}.json`,
        );
      } catch (e) {
        if (!(e instanceof ProviderError && e.httpStatus === 404)) throw e;
      }
    },

    async sendMessage(account, m) {
      const res = await call<{ sid: string; status: string }>(
        credsOf(account),
        'POST',
        `${API}/Accounts/${account.sid}/Messages.json`,
        {
          To: m.to,
          ...(m.messagingServiceSid
            ? { MessagingServiceSid: m.messagingServiceSid }
            : { From: m.from }),
          Body: m.body,
          ...(m.mediaUrls.length > 0 ? { MediaUrl: m.mediaUrls } : {}),
          StatusCallback: m.statusCallbackUrl,
        },
      );
      return { sid: res.sid, status: res.status };
    },

    async fetchMedia(account, url) {
      const res = await fetch(url, {
        headers: {
          authorization: `Basic ${Buffer.from(`${account.sid}:${account.authToken}`).toString('base64')}`,
        },
      });
      if (!res.ok)
        throw new ProviderError(
          `Media fetch failed (${res.status})`,
          String(res.status),
          res.status === 404,
          res.status,
        );
      return {
        data: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },

    async deleteMedia(account, url) {
      try {
        await call(credsOf(account), 'DELETE', url.endsWith('.json') ? url : `${url}.json`);
      } catch (e) {
        if (!(e instanceof ProviderError && e.httpStatus === 404)) throw e;
      }
    },

    async submitRegistration(account, request) {
      if (request.kind !== 'toll_free_verification')
        throw new ProviderError(
          'Local-number (10DLC) registration is not switched on yet. Use a toll-free number for now.',
          'a2p_not_enabled',
          true,
        );
      const b = request.submission as unknown as Business;
      if (!request.phoneNumberSid)
        throw new ProviderError('The number has no carrier id yet.', 'no_number_sid', false);
      const res = await call<{ sid: string; status: string; rejection_reason?: string | null }>(
        credsOf(account),
        'POST',
        `${MESSAGING}/Tollfree/Verifications`,
        {
          TollfreePhoneNumberSid: request.phoneNumberSid,
          BusinessName: b.legalName,
          BusinessType: TOLL_FREE_BUSINESS_TYPE[b.businessType] ?? 'PRIVATE_PROFIT',
          ...(b.businessType !== 'sole_proprietor' && b.ein
            ? {
                BusinessRegistrationNumber: b.ein.replace('-', ''),
                BusinessRegistrationAuthority: 'EIN',
                BusinessRegistrationCountry: 'US',
              }
            : {}),
          BusinessWebsite: b.website,
          NotificationEmail: request.notifyEmail || b.contact.email,
          UseCaseCategories: USE_CASES[b.useCase] ?? USE_CASES['customer_care'],
          UseCaseSummary: b.optInDescription,
          ProductionMessageSample: b.messageSamples.join('\n\n'),
          OptInImageUrls: [b.website],
          OptInType: 'VERBAL',
          MessageVolume: MESSAGE_VOLUME[b.monthlyVolume] ?? '1,000',
          BusinessStreetAddress: b.address.line1,
          BusinessCity: b.address.city,
          BusinessStateProvinceRegion: b.address.state,
          BusinessPostalCode: b.address.postalCode,
          BusinessCountry: b.address.country ?? 'US',
          BusinessContactFirstName: b.contact.firstName,
          BusinessContactLastName: b.contact.lastName,
          BusinessContactEmail: b.contact.email,
          BusinessContactPhone: b.contact.phone,
          AdditionalInformation: b.optInDescription,
          ExternalReferenceId: request.phoneNumberE164,
        },
      );
      return {
        providerSid: res.sid,
        providerStatus: res.status,
        status: TOLL_FREE_STATUS[res.status] ?? 'in_review',
        rejectionReason: res.rejection_reason ?? null,
      };
    },

    async fetchRegistration(account, { kind, providerSid }) {
      if (kind !== 'toll_free_verification')
        throw new ProviderError(
          'Local-number (10DLC) registration is not switched on yet.',
          'a2p_not_enabled',
          true,
        );
      const res = await call<{ sid: string; status: string; rejection_reason?: string | null }>(
        credsOf(account),
        'GET',
        `${MESSAGING}/Tollfree/Verifications/${providerSid}`,
      );
      return {
        providerSid: res.sid,
        providerStatus: res.status,
        status: TOLL_FREE_STATUS[res.status] ?? 'in_review',
        rejectionReason: res.rejection_reason ?? null,
      };
    },
  };
}
