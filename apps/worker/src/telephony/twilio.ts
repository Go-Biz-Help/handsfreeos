/**
 * Twilio over plain HTTPS (no SDK): the master account creates one subaccount per workspace, and each
 * workspace's numbers, messages and registrations live in its subaccount.
 */
import {
  ProviderError,
  type AvailableNumber,
  type Capabilities,
  type ProviderAccount,
  type RegistrationRequest,
  type RegistrationState,
  type TelephonyProvider,
} from './provider';

const API = 'https://api.twilio.com/2010-04-01';
const MESSAGING = 'https://messaging.twilio.com/v1';
const TRUST_HUB = 'https://trusthub.twilio.com/v1';

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

// ---------- carrier registration ----------

interface TwilioStatus {
  sid: string;
  status?: string;
  rejection_reason?: string | null;
  failure_reason?: string | null;
  errors?: readonly { code?: number | string; message?: string; description?: string }[] | null;
}
type StatusMap = Readonly<Record<string, RegistrationState['status']>>;

/** Customer profiles and trust products (Trust Hub bundles). */
const BUNDLE_STATUS: StatusMap = {
  draft: 'submitted',
  'pending-review': 'in_review',
  'in-review': 'in_review',
  'twilio-approved': 'approved',
  'twilio-rejected': 'rejected',
};
const BRAND_STATUS: StatusMap = {
  PENDING: 'in_review',
  IN_REVIEW: 'in_review',
  APPROVED: 'approved',
  FAILED: 'rejected',
  SUSPENDED: 'rejected',
  DELETION_PENDING: 'failed',
  DELETION_FAILED: 'failed',
};
const CAMPAIGN_STATUS: StatusMap = {
  PENDING: 'in_review',
  IN_PROGRESS: 'in_review',
  VERIFIED: 'approved',
  FAILED: 'rejected',
};

/** Twilio's policies for a secondary (client) customer profile and for the A2P messaging trust product. */
const SECONDARY_PROFILE_POLICY = 'RNdfbf3fae0e1107f8aded0e7cead80bf5';
const A2P_TRUST_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';

const A2P_BUSINESS_TYPE: Record<string, string> = {
  llc: 'Limited Liability Corporation',
  corporation: 'Corporation',
  partnership: 'Partnership',
  non_profit: 'Non-profit Corporation',
};
const A2P_USE_CASE: Record<string, string> = {
  customer_care: 'CUSTOMER_CARE',
  mixed: 'MIXED',
  marketing: 'MARKETING',
};
const CAMPAIGN_DESCRIPTION: Record<string, string> = {
  customer_care:
    'appointment confirmations, technician arrival notices, estimates and replies to customer questions',
  mixed:
    'appointment confirmations, arrival notices, replies to customer questions and occasional seasonal offers',
  marketing: 'seasonal offers and maintenance reminders',
};

/** The carrier's reason in one line, from whichever field this resource uses. */
function reasonOf(res: TwilioStatus): string | null {
  if (res.rejection_reason) return res.rejection_reason;
  if (res.failure_reason) return res.failure_reason;
  const list = (res.errors ?? [])
    .map((e) => e.description ?? e.message ?? (e.code ? `Error ${e.code}` : ''))
    .filter(Boolean);
  return list.length > 0 ? list.join(' ') : null;
}

function stateOf(
  sid: string,
  providerStatus: string,
  map: StatusMap,
  res: TwilioStatus,
): RegistrationState {
  const status = map[providerStatus] ?? 'in_review';
  return {
    providerSid: sid,
    providerStatus,
    status,
    rejectionReason: status === 'rejected' || status === 'failed' ? reasonOf(res) : null,
  };
}

type Bundle = 'CustomerProfiles' | 'TrustProducts';

async function assign(creds: Creds, bundle: Bundle, bundleSid: string, objectSid: string) {
  await call(creds, 'POST', `${TRUST_HUB}/${bundle}/${bundleSid}/EntityAssignments`, {
    ObjectSid: objectSid,
  });
}

/** Checks a bundle against its policy, then sends it for review; a failed check names what to fix. */
async function evaluateAndSubmit(
  creds: Creds,
  bundle: Bundle,
  bundleSid: string,
  policySid: string,
): Promise<RegistrationState> {
  const evaluation = await call<{
    status: string;
    results?: readonly {
      passed?: boolean;
      friendly_name?: string;
      failure_reason?: string;
      fields?: readonly { passed?: boolean; friendly_name?: string; failure_reason?: string }[];
    }[];
  }>(creds, 'POST', `${TRUST_HUB}/${bundle}/${bundleSid}/Evaluations`, { PolicySid: policySid });
  if (evaluation.status !== 'compliant') {
    const problems: string[] = [];
    for (const r of evaluation.results ?? []) {
      if (r.passed !== false) continue;
      const fields = (r.fields ?? []).filter((f) => f.passed === false);
      if (fields.length === 0)
        problems.push(r.failure_reason || r.friendly_name || 'a required part');
      for (const f of fields)
        problems.push(f.failure_reason || f.friendly_name || 'a required field');
    }
    throw new ProviderError(
      `The carriers need more business details${problems.length > 0 ? `: ${problems.join('; ')}` : ''}.`,
      'bundle_noncompliant',
      true,
    );
  }
  const res = await call<TwilioStatus>(creds, 'POST', `${TRUST_HUB}/${bundle}/${bundleSid}`, {
    Status: 'pending-review',
  });
  return stateOf(res.sid, res.status ?? 'pending-review', BUNDLE_STATUS, res);
}

async function submitTollFree(
  account: ProviderAccount,
  request: RegistrationRequest,
  b: Business,
): Promise<RegistrationState> {
  if (!request.phoneNumberSid)
    throw new ProviderError('The number has no carrier id yet.', 'no_number_sid', false);
  const res = await call<TwilioStatus>(
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
  return stateOf(res.sid, res.status ?? 'PENDING_REVIEW', TOLL_FREE_STATUS, res);
}

/**
 * The client's secondary customer profile, built in its own subaccount and linked under HandsFreeOS's
 * primary ISV profile: business information, an authorized representative and the business address.
 */
async function submitCustomerProfile(
  account: ProviderAccount,
  request: RegistrationRequest,
  b: Business,
  primaryProfileSid: string | null,
): Promise<RegistrationState> {
  if (!primaryProfileSid)
    throw new ProviderError(
      'Local numbers cannot be registered yet: HandsFreeOS is finishing its own carrier profile. Use a toll-free number for now.',
      'isv_profile_missing',
      true,
    );
  if (b.businessType === 'sole_proprietor' || !b.ein)
    throw new ProviderError(
      'Sole proprietors text from a toll-free number. Release this number and pick a toll-free one.',
      'a2p_sole_proprietor',
      true,
    );
  const creds = credsOf(account);
  const email = request.notifyEmail || b.contact.email;
  const name = (what: string) => `${b.legalName} ${what}`.slice(0, 64);
  const profile = await call<{ sid: string }>(creds, 'POST', `${TRUST_HUB}/CustomerProfiles`, {
    FriendlyName: name('profile'),
    Email: email,
    PolicySid: SECONDARY_PROFILE_POLICY,
  });
  const info = await call<{ sid: string }>(creds, 'POST', `${TRUST_HUB}/EndUsers`, {
    FriendlyName: name('business information'),
    Type: 'customer_profile_business_information',
    Attributes: JSON.stringify({
      business_name: b.legalName,
      business_type: A2P_BUSINESS_TYPE[b.businessType] ?? 'Limited Liability Corporation',
      // Home-services businesses (HVAC, plumbing, roofing, electrical).
      business_industry: 'CONSTRUCTION',
      business_registration_identifier: 'EIN',
      business_registration_number: b.ein.replace('-', ''),
      business_regions_of_operation: 'USA_AND_CANADA',
      website_url: b.website,
    }),
  });
  await assign(creds, 'CustomerProfiles', profile.sid, info.sid);
  const rep = await call<{ sid: string }>(creds, 'POST', `${TRUST_HUB}/EndUsers`, {
    FriendlyName: name('representative'),
    Type: 'authorized_representative_1',
    Attributes: JSON.stringify({
      first_name: b.contact.firstName,
      last_name: b.contact.lastName,
      email: b.contact.email,
      phone_number: b.contact.phone,
      business_title: 'Owner',
      job_position: 'Other',
    }),
  });
  await assign(creds, 'CustomerProfiles', profile.sid, rep.sid);
  const address = await call<{ sid: string }>(
    creds,
    'POST',
    `${API}/Accounts/${account.sid}/Addresses.json`,
    {
      CustomerName: b.legalName,
      Street: b.address.line1,
      City: b.address.city,
      Region: b.address.state,
      PostalCode: b.address.postalCode,
      IsoCountry: b.address.country ?? 'US',
    },
  );
  const doc = await call<{ sid: string }>(creds, 'POST', `${TRUST_HUB}/SupportingDocuments`, {
    FriendlyName: name('address'),
    Type: 'customer_profile_address',
    Attributes: JSON.stringify({ address_sids: address.sid }),
  });
  await assign(creds, 'CustomerProfiles', profile.sid, doc.sid);
  await assign(creds, 'CustomerProfiles', profile.sid, primaryProfileSid);
  return evaluateAndSubmit(creds, 'CustomerProfiles', profile.sid, SECONDARY_PROFILE_POLICY);
}

async function submitTrustProduct(
  account: ProviderAccount,
  request: RegistrationRequest,
  b: Business,
): Promise<RegistrationState> {
  const profileSid = request.previous.a2p_customer_profile;
  if (!profileSid) throw new ProviderError('The customer profile goes first.', 'a2p_order', false);
  const creds = credsOf(account);
  const product = await call<{ sid: string }>(creds, 'POST', `${TRUST_HUB}/TrustProducts`, {
    FriendlyName: `${b.legalName} A2P messaging`.slice(0, 64),
    Email: request.notifyEmail || b.contact.email,
    PolicySid: A2P_TRUST_POLICY,
  });
  const info = await call<{ sid: string }>(creds, 'POST', `${TRUST_HUB}/EndUsers`, {
    FriendlyName: `${b.legalName} messaging profile`.slice(0, 64),
    Type: 'us_a2p_messaging_profile_information',
    Attributes: JSON.stringify({
      company_type: b.businessType === 'non_profit' ? 'non-profit' : 'private',
    }),
  });
  await assign(creds, 'TrustProducts', product.sid, info.sid);
  await assign(creds, 'TrustProducts', product.sid, profileSid);
  return evaluateAndSubmit(creds, 'TrustProducts', product.sid, A2P_TRUST_POLICY);
}

async function submitBrand(
  account: ProviderAccount,
  request: RegistrationRequest,
  b: Business,
): Promise<RegistrationState> {
  const profileSid = request.previous.a2p_customer_profile;
  const productSid = request.previous.a2p_trust_product;
  if (!profileSid || !productSid)
    throw new ProviderError('The profile and trust product go first.', 'a2p_order', false);
  const res = await call<TwilioStatus>(
    credsOf(account),
    'POST',
    `${MESSAGING}/a2p/BrandRegistrations`,
    {
      CustomerProfileBundleSid: profileSid,
      A2PProfileBundleSid: productSid,
      BrandType: 'STANDARD',
      // Low-Volume Standard: small senders skip the paid secondary vetting.
      SkipAutomaticSecVet: b.monthlyVolume === 'under_1000' ? 'true' : 'false',
    },
  );
  return stateOf(res.sid, res.status ?? 'PENDING', BRAND_STATUS, res);
}

async function submitCampaign(
  account: ProviderAccount,
  request: RegistrationRequest,
  b: Business,
): Promise<RegistrationState> {
  const brandSid = request.previous.a2p_brand;
  const serviceSid = request.messagingServiceSid;
  if (!brandSid || !serviceSid)
    throw new ProviderError('The brand and messaging service go first.', 'a2p_order', false);
  const samples = b.messageSamples.slice(0, 5);
  if (samples.length < 2)
    throw new ProviderError(
      'Local numbers need at least two example texts. Add another example and submit again.',
      'a2p_samples',
      true,
    );
  const res = await call<TwilioStatus & { campaign_status?: string }>(
    credsOf(account),
    'POST',
    `${MESSAGING}/Services/${serviceSid}/Compliance/Usa2p`,
    {
      BrandRegistrationSid: brandSid,
      Description: `${b.legalName} texts its customers: ${CAMPAIGN_DESCRIPTION[b.useCase] ?? CAMPAIGN_DESCRIPTION['customer_care']}.`,
      MessageFlow: b.optInDescription.slice(0, 2048),
      MessageSamples: samples,
      UsAppToPersonUsecase: A2P_USE_CASE[b.useCase] ?? 'CUSTOMER_CARE',
      HasEmbeddedLinks: String(samples.some((x) => /https?:\/\/|www\./i.test(x))),
      HasEmbeddedPhone: String(samples.some((x) => /\d{3}\D{0,3}\d{3}\D{0,3}\d{4}/.test(x))),
    },
  );
  return stateOf(res.sid, res.campaign_status ?? 'PENDING', CAMPAIGN_STATUS, res);
}

export function createTwilioTelephony(master: {
  accountSid: string;
  authToken: string;
  /** HandsFreeOS's own approved ISV customer profile (BU...); client 10DLC profiles are linked under it. */
  primaryProfileSid?: string | null;
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

    async createApiKey(account, friendlyName) {
      const res = await call<{ sid: string; secret: string }>(
        credsOf(account),
        'POST',
        `${API}/Accounts/${account.sid}/Keys.json`,
        { FriendlyName: friendlyName.slice(0, 64) },
      );
      return { sid: res.sid, secret: res.secret };
    },

    async createTwimlApp(account, opts) {
      const res = await call<{ sid: string }>(
        credsOf(account),
        'POST',
        `${API}/Accounts/${account.sid}/Applications.json`,
        {
          FriendlyName: opts.friendlyName.slice(0, 64),
          VoiceUrl: opts.voiceUrl,
          VoiceMethod: 'POST',
          StatusCallback: opts.statusCallbackUrl,
          StatusCallbackMethod: 'POST',
        },
      );
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
          ...(areaCode ? { AreaCode: areaCode } : {}),
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

    async fetchRecording(account, recordingSid) {
      const res = await fetch(`${API}/Accounts/${account.sid}/Recordings/${recordingSid}.mp3`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${account.sid}:${account.authToken}`).toString('base64')}`,
        },
      });
      // A fresh recording can take a moment to appear, so every failure here is retried.
      if (!res.ok)
        throw new ProviderError(
          `Recording fetch failed (${res.status})`,
          String(res.status),
          false,
          res.status,
        );
      return {
        data: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      };
    },

    async deleteRecording(account, recordingSid) {
      try {
        await call(
          credsOf(account),
          'DELETE',
          `${API}/Accounts/${account.sid}/Recordings/${recordingSid}.json`,
        );
      } catch (e) {
        if (!(e instanceof ProviderError && e.httpStatus === 404)) throw e;
      }
    },

    async deleteTranscription(account, transcriptionSid) {
      try {
        await call(
          credsOf(account),
          'DELETE',
          `${API}/Accounts/${account.sid}/Transcriptions/${transcriptionSid}.json`,
        );
      } catch (e) {
        if (!(e instanceof ProviderError && e.httpStatus === 404)) throw e;
      }
    },

    async submitRegistration(account, request) {
      const b = request.submission as unknown as Business;
      switch (request.kind) {
        case 'toll_free_verification':
          return submitTollFree(account, request, b);
        case 'a2p_customer_profile':
          return submitCustomerProfile(account, request, b, master.primaryProfileSid ?? null);
        case 'a2p_trust_product':
          return submitTrustProduct(account, request, b);
        case 'a2p_brand':
          return submitBrand(account, request, b);
        case 'a2p_campaign':
          return submitCampaign(account, request, b);
      }
    },

    async fetchRegistration(account, { kind, providerSid }) {
      const creds = credsOf(account);
      switch (kind) {
        case 'toll_free_verification': {
          const res = await call<TwilioStatus>(
            creds,
            'GET',
            `${MESSAGING}/Tollfree/Verifications/${providerSid}`,
          );
          return stateOf(res.sid, res.status ?? '', TOLL_FREE_STATUS, res);
        }
        case 'a2p_customer_profile':
        case 'a2p_trust_product': {
          const bundle: Bundle =
            kind === 'a2p_customer_profile' ? 'CustomerProfiles' : 'TrustProducts';
          const res = await call<TwilioStatus>(
            creds,
            'GET',
            `${TRUST_HUB}/${bundle}/${providerSid}`,
          );
          return stateOf(res.sid, res.status ?? '', BUNDLE_STATUS, res);
        }
        case 'a2p_brand': {
          const res = await call<TwilioStatus>(
            creds,
            'GET',
            `${MESSAGING}/a2p/BrandRegistrations/${providerSid}`,
          );
          return stateOf(res.sid, res.status ?? '', BRAND_STATUS, res);
        }
        case 'a2p_campaign': {
          if (!account.messagingServiceSid)
            throw new ProviderError('The workspace has no messaging service.', 'no_service', false);
          const res = await call<TwilioStatus & { campaign_status?: string }>(
            creds,
            'GET',
            `${MESSAGING}/Services/${account.messagingServiceSid}/Compliance/Usa2p/${providerSid}`,
          );
          return stateOf(res.sid, res.campaign_status ?? '', CAMPAIGN_STATUS, res);
        }
      }
    },
  };
}
