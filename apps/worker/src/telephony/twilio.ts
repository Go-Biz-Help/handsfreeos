/**
 * Twilio over plain HTTPS (no SDK): the master account creates one subaccount per workspace, and each
 * workspace's numbers, messages and registrations live in its subaccount.
 */
import { HELP_KEYWORDS, rcsSenderIdOf, START_KEYWORDS, STOP_KEYWORDS } from '@hfos/core';
import {
  ProviderError,
  type AvailableNumber,
  type Capabilities,
  type ProviderAccount,
  type RcsSenderInfo,
  type RcsSenderState,
  type RegistrationRequest,
  type DailyUsage,
  type ExternalNumber,
  type ExternalTwilioCreds,
  type PortOutcome,
  type RegistrationState,
  type SubaccountNumber,
  type TelephonyProvider,
} from './provider';

const API = 'https://api.twilio.com/2010-04-01';
const MESSAGING = 'https://messaging.twilio.com/v1';
const TRUST_HUB = 'https://trusthub.twilio.com/v1';
const INTELLIGENCE = 'https://intelligence.twilio.com/v2';
/** Moving a number a business already owns: the whole thing (voice and texts). */
const PORTING = 'https://numbers.twilio.com/v1/Porting';
/** Taking over texting only, leaving their calls where they are. */
const HOSTED = 'https://numbers.twilio.com/v2/HostedNumber/Orders';
/** The Conversational Intelligence service whole calls are transcribed in: one per subaccount, found by this name. */
const TRANSCRIPT_SERVICE = 'hfos-call-transcripts';
/** RCS senders (0103), and the content templates a rich text goes out as. */
const SENDERS = 'https://messaging.twilio.com/v2/Channels/Senders';
const CONTENT = 'https://content.twilio.com/v1/Content';
/** Who hosts a number today: the carrier lookup that tells a Twilio-hosted number from one needing a port. */
const LOOKUPS = 'https://lookups.twilio.com/v2/PhoneNumbers';
/** Twilio's own host, which its list responses' `next_page_uri` is relative to. */
const TWILIO_HOST = 'https://api.twilio.com';
/** How many of a connected account's subaccounts are looked in. An agency with more has asked us to page. */
const MAX_LISTED_ACCOUNTS = 100;

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

/** The same as `call`, for the APIs that take JSON rather than a form: the Content API. */
async function callJson<T>(creds: Creds, url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.sid}:${creds.token}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw providerError(res.status, json as { code?: number; message?: string });
  return json as T;
}

const credsOf = (a: ProviderAccount): Creds => ({ sid: a.sid, token: a.authToken });
/** A business's own account signs in as its Account SID, or as the API key it gave us. */
const externalCreds = (c: ExternalTwilioCreds): Creds => ({ sid: c.username, token: c.secret });

interface IncomingNumberJson {
  readonly sid: string;
  readonly account_sid: string;
  readonly phone_number: string;
  readonly friendly_name?: string | null;
  readonly capabilities?: Record<string, boolean>;
  readonly sms_url?: string | null;
  readonly voice_url?: string | null;
}

/**
 * Twilio's word for an RCS sender, onto the four this system acts on (0103). Anything unrecognised is still in
 * review, deliberately: an unknown status means Twilio is still doing something, and guessing `failed` would tell
 * a business its sender broke when it had not. The word itself is kept too, so Settings can say which step.
 */
const RCS_SENDER_STATE: Readonly<Record<string, RcsSenderState>> = {
  ONLINE: 'online',
  'ONLINE:UPDATING': 'online',
  OFFLINE: 'offline',
  CREATING: 'in_review',
  DRAFT: 'in_review',
  STUBBED: 'in_review',
  PENDING_VERIFICATION: 'in_review',
  VERIFYING: 'in_review',
  TWILIO_REVIEW: 'in_review',
};

interface SenderJson {
  readonly sid: string;
  readonly status?: string | null;
  readonly sender_id?: string | null;
  readonly profile?: { readonly name?: string | null } | null;
  readonly offline_reasons?: readonly { readonly message?: string | null }[] | null;
}

const senderOf = (j: SenderJson): RcsSenderInfo => {
  const providerStatus = (j.status ?? '').toUpperCase();
  const reason = (j.offline_reasons ?? [])
    .map((r) => r.message ?? '')
    .filter(Boolean)
    .join(' ');
  return {
    sid: j.sid,
    senderId: rcsSenderIdOf(j.sender_id ?? ''),
    displayName: j.profile?.name || null,
    providerStatus,
    state: RCS_SENDER_STATE[providerStatus] ?? 'in_review',
    reason: reason || null,
  };
};

/**
 * Twilio's port and hosted-order statuses, onto the six this system has (M17).
 *
 * The two products say the same things in different words, which is most of why this map exists rather than a
 * pair of comparisons scattered through the adapter. Anything unrecognised is `carrier_review`, deliberately:
 * an unknown status means the carrier is still doing something, and guessing `failed` would tell a business
 * its port died when it had not.
 */
const PORT_STATUS: Readonly<Record<string, PortOutcome>> = {
  // Porting (full)
  draft: 'submitted',
  'pending-loa': 'submitted',
  'in-review': 'carrier_review',
  'waiting-for-signature': 'submitted',
  'action-required': 'carrier_review',
  'pending-port': 'scheduled',
  'port-scheduled': 'scheduled',
  completed: 'complete',
  'port-failed': 'rejected',
  canceled: 'failed',
  // Hosted messaging
  received: 'submitted',
  'pending-verification': 'carrier_review',
  verified: 'carrier_review',
  'pending-loa-authorization': 'submitted',
  'carrier-processing': 'carrier_review',
  testing: 'scheduled',
  failed: 'rejected',
};

const portOutcome = (status: string): PortOutcome =>
  PORT_STATUS[status.toLowerCase()] ?? 'carrier_review';

/** One of Twilio's available numbers as the rest of the worker wants it. */
const toAvailable = (n: {
  phone_number: string;
  locality: string | null;
  region: string | null;
  capabilities: Record<string, boolean>;
}): AvailableNumber => ({
  e164: n.phone_number,
  locality: n.locality || null,
  region: n.region || null,
  capabilities: caps(n.capabilities),
});

/** The subaccount's transcript service, made the first time a call is transcribed there. */
async function transcriptService(creds: Creds): Promise<string> {
  const list = await call<{ services?: { sid: string; unique_name?: string | null }[] }>(
    creds,
    'GET',
    `${INTELLIGENCE}/Services`,
    { PageSize: '100' },
  );
  const found = list.services?.find((x) => x.unique_name === TRANSCRIPT_SERVICE);
  if (found) return found.sid;
  // Two at once: the second is refused (the name is taken) and its job finds the first's next time.
  const made = await call<{ sid: string }>(creds, 'POST', `${INTELLIGENCE}/Services`, {
    UniqueName: TRANSCRIPT_SERVICE,
    FriendlyName: 'HandsFreeOS call transcripts',
    AutoTranscribe: 'false',
    DataLogging: 'false',
    LanguageCode: 'en-US',
  });
  return made.sid;
}

interface IntelligenceSentence {
  media_channel?: number | null;
  sentence_index?: number | null;
  transcript?: string | null;
}
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
/**
 * What the business texts, as the carriers read it after "<legal name> sends". Workflows text on their own
 * (speed to lead, missed-call text back, reminders, estimate follow-ups, review requests), and the carriers
 * approve what's described, so the customer-care wording says so plainly.
 */
const AUTOMATED_CARE =
  'automated and one-to-one texts to people who contacted it or booked with it: replies to new inquiries, a text back after a missed call, appointment confirmations and reminders, technician arrival notices, follow-ups on estimates, review requests and answers to customer questions';
const USE_CASE_TEXTS: Record<string, string> = {
  customer_care: AUTOMATED_CARE,
  mixed: `${AUTOMATED_CARE}, and occasional seasonal offers`,
  marketing: 'texts to its customers about seasonal offers and maintenance reminders',
};
const OPT_OUT_SENTENCE =
  'Every message includes opt-out instructions, and replying STOP stops them.';

/** The use case the carriers approve: a 10DLC campaign's Description and a toll-free UseCaseSummary. */
function useCaseDescription(b: Business): string {
  return `${b.legalName} sends ${USE_CASE_TEXTS[b.useCase] ?? AUTOMATED_CARE}. ${OPT_OUT_SENTENCE}`;
}

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

/** A resource that may be gone (404): null instead of an error. */
async function getIfThere<T>(creds: Creds, url: string): Promise<T | null> {
  try {
    return await call<T>(creds, 'GET', url);
  } catch (e) {
    if (e instanceof ProviderError && e.httpStatus === 404) return null;
    throw e;
  }
}

/** Removes a resource; one that is already gone is what we wanted. */
async function deleteIfThere(creds: Creds, url: string): Promise<void> {
  try {
    await call(creds, 'DELETE', url);
  } catch (e) {
    if (!(e instanceof ProviderError && e.httpStatus === 404)) throw e;
  }
}

async function fetchBundle(creds: Creds, bundle: Bundle, sid: string): Promise<RegistrationState> {
  const res = await call<TwilioStatus>(creds, 'GET', `${TRUST_HUB}/${bundle}/${sid}`);
  return stateOf(res.sid, res.status ?? '', BUNDLE_STATUS, res);
}

/** Twilio just took a request again: a verdict its answer still shows is the old one, so it reads as in review. */
const reviewingAgain = (state: RegistrationState): RegistrationState =>
  state.status === 'rejected' ? { ...state, status: 'in_review', rejectionReason: null } : state;

interface TollFreeVerification extends TwilioStatus {
  edit_allowed?: boolean | null;
  edit_expiration?: string | null;
}

/** Twilio takes edits of a rejected verification for about seven days after its decision, and reviews them first. */
const editable = (v: TollFreeVerification) =>
  v.edit_allowed === true && (!v.edit_expiration || Date.parse(v.edit_expiration) > Date.now());

/**
 * Toll-free verification. Sent again after a rejection, the same request is edited while Twilio allows it;
 * after that the old one is deleted and a new one waits in the normal queue.
 */
async function submitTollFree(
  account: ProviderAccount,
  request: RegistrationRequest,
  b: Business,
): Promise<RegistrationState> {
  if (!request.phoneNumberSid)
    throw new ProviderError('The number has no carrier id yet.', 'no_number_sid', false);
  const creds = credsOf(account);
  const url = `${MESSAGING}/Tollfree/Verifications`;
  if (request.replaces) {
    const earlier = await getIfThere<TollFreeVerification>(creds, `${url}/${request.replaces}`);
    // Back in review or approved already (sent again twice, say): there is nothing to fix.
    if (earlier && earlier.status !== 'TWILIO_REJECTED')
      return stateOf(earlier.sid, earlier.status ?? '', TOLL_FREE_STATUS, earlier);
    if (earlier && editable(earlier)) {
      const res = await call<TwilioStatus>(creds, 'POST', `${url}/${earlier.sid}`, {
        ...tollFreeDetails(request, b),
        EditReason: 'Corrected the business details the carriers asked about.',
      });
      return reviewingAgain(
        stateOf(res.sid, res.status ?? 'PENDING_REVIEW', TOLL_FREE_STATUS, res),
      );
    }
    if (earlier) await deleteIfThere(creds, `${url}/${earlier.sid}`);
  }
  const res = await call<TwilioStatus>(creds, 'POST', url, {
    TollfreePhoneNumberSid: request.phoneNumberSid,
    ...tollFreeDetails(request, b),
    ExternalReferenceId: request.phoneNumberE164,
  });
  return stateOf(res.sid, res.status ?? 'PENDING_REVIEW', TOLL_FREE_STATUS, res);
}

/** The business details of a toll-free verification: the same fields for a new request and an edit. */
function tollFreeDetails(request: RegistrationRequest, b: Business): Params {
  return {
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
    UseCaseSummary: useCaseDescription(b),
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
  };
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
  // Sent again: support corrects a turned-down profile in the Twilio console, so here it is only looked at.
  if (request.replaces) return fetchBundle(credsOf(account), 'CustomerProfiles', request.replaces);
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
  // Sent again: support corrects a turned-down trust product in the Twilio console; here it is only looked at.
  if (request.replaces) return fetchBundle(credsOf(account), 'TrustProducts', request.replaces);
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
  if (request.replaces) {
    // Twilio checks the brand again against the business profile as it stands now (support corrects that in
    // the Twilio console first). Three of these are free; after that Twilio refuses (21724) until support asks.
    const res = await call<TwilioStatus>(
      credsOf(account),
      'POST',
      `${MESSAGING}/a2p/BrandRegistrations/${request.replaces}`,
    );
    return reviewingAgain(stateOf(res.sid, res.status ?? 'PENDING', BRAND_STATUS, res));
  }
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
  /**
   * The three messages a campaign declares, built from the business's own name.
   *
   * Kept short on purpose: every one of them is a real text somebody's phone will show, and a carrier reads
   * them looking for the business's name, the way out, and that rates may apply. 160 characters is one
   * segment, so none of these costs the business two.
   */
  const shortName = (b: Business) => b.legalName.slice(0, 40);
  const optInMessage = (b: Business) =>
    `${shortName(b)}: you're signed up for texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to stop.`.slice(
      0,
      320,
    );
  const optOutMessage = (b: Business) =>
    `${shortName(b)}: you're unsubscribed and will get no more texts. Reply START to start again.`.slice(
      0,
      320,
    );
  const helpMessage = (b: Business) =>
    `${shortName(b)}: reply STOP to stop texts. Msg & data rates may apply. Contact us at ${b.contact.email}.`.slice(
      0,
      320,
    );

  // A campaign the carriers turned down is replaced (Twilio's edit in place is still a private beta); the new
  // one may be charged the vetting fee again.
  if (request.replaces)
    await deleteIfThere(
      credsOf(account),
      `${MESSAGING}/Services/${serviceSid}/Compliance/Usa2p/${request.replaces}`,
    );
  const res = await call<TwilioStatus & { campaign_status?: string }>(
    credsOf(account),
    'POST',
    `${MESSAGING}/Services/${serviceSid}/Compliance/Usa2p`,
    {
      BrandRegistrationSid: brandSid,
      Description: useCaseDescription(b),
      MessageFlow: b.optInDescription.slice(0, 2048),
      MessageSamples: samples,
      UsAppToPersonUsecase: A2P_USE_CASE[b.useCase] ?? 'CUSTOMER_CARE',
      HasEmbeddedLinks: String(samples.some((x) => /https?:\/\/|www\./i.test(x))),
      HasEmbeddedPhone: String(samples.some((x) => /\d{3}\D{0,3}\d{3}\D{0,3}\d{4}/.test(x))),
      // What the carriers are told about stopping, starting and getting help. Increasingly required rather
      // than optional, and **the keyword lists come from core** so what we declare is what the code does
      // (packages/core/src/messaging/sms.ts) rather than a second copy that drifts.
      OptInKeywords: [...START_KEYWORDS],
      OptInMessage: optInMessage(b),
      OptOutKeywords: [...STOP_KEYWORDS],
      OptOutMessage: optOutMessage(b),
      HelpKeywords: [...HELP_KEYWORDS],
      HelpMessage: helpMessage(b),
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

    async closeSubaccount(accountSid) {
      try {
        await call(masterCreds, 'POST', `${API}/Accounts/${accountSid}.json`, { Status: 'closed' });
      } catch (e) {
        if (!(e instanceof ProviderError && e.httpStatus === 404)) throw e;
      }
    },

    async createMessagingService(account, opts) {
      const res = await call<{ sid: string }>(credsOf(account), 'POST', `${MESSAGING}/Services`, {
        FriendlyName: opts.friendlyName,
        InboundRequestUrl: opts.inboundUrl,
        InboundMethod: 'POST',
        StatusCallback: opts.statusCallbackUrl,
        UseInboundWebhookOnNumber: 'false',
        // Curly quotes and dashes go out as their plain twins, so a text stays in the cheaper encoding
        // (160 characters a segment instead of 70).
        SmartEncoding: 'true',
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

    async searchNumbers({ numberType, areaCode, contains, city, state, withinMiles, limit }) {
      const ask = (params: Params) =>
        call<{
          available_phone_numbers: {
            phone_number: string;
            locality: string | null;
            region: string | null;
            latitude: number | string | null;
            longitude: number | string | null;
            capabilities: Record<string, boolean>;
          }[];
        }>(
          masterCreds,
          'GET',
          `${API}/Accounts/${master.accountSid}/AvailablePhoneNumbers/US/${numberType === 'toll_free' ? 'TollFree' : 'Local'}.json`,
          { SmsEnabled: 'true', MmsEnabled: 'true', VoiceEnabled: 'true', ...params },
        );
      // Toll-free numbers sit in no city, and Twilio's TollFree endpoint refuses the pair.
      const inCity = numberType === 'local' && city && state;
      const narrow = {
        ...(areaCode ? { AreaCode: areaCode } : {}),
        ...(contains ? { Contains: contains } : {}),
      };

      /**
       * "Within N miles of Huntsville" is two questions: where is Huntsville, and what is free around it.
       * Twilio has no city-to-coordinates lookup, but every US number it offers carries its own latitude and
       * longitude — so one number in the city is the landmark the second search is measured from. A city with
       * nothing free has no landmark, and rather than quietly answering the wider question this returns
       * nothing, which the caller reports as not being able to centre on that city.
       */
      if (inCity && withinMiles) {
        const anchor = await ask({ PageSize: '1', InLocality: city, InRegion: state });
        const at = anchor.available_phone_numbers[0];
        if (!at || at.latitude == null || at.longitude == null) return [];
        const res = await ask({
          ...narrow,
          PageSize: String(limit),
          NearLatLong: `${at.latitude},${at.longitude}`,
          Distance: String(withinMiles),
        });
        return res.available_phone_numbers.map(toAvailable);
      }

      const res = await ask({
        ...narrow,
        PageSize: String(limit),
        ...(inCity ? { InLocality: city, InRegion: state } : {}),
      });
      return res.available_phone_numbers.map(toAvailable);
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

    async listOwnedNumbers(account, { limit }) {
      const out: SubaccountNumber[] = [];
      let url: string | null =
        `${API}/Accounts/${account.sid}/IncomingPhoneNumbers.json?PageSize=1000`;
      while (url && out.length < limit) {
        const page: {
          incoming_phone_numbers?: IncomingNumberJson[];
          next_page_uri?: string | null;
        } = await call(credsOf(account), 'GET', url);
        for (const n of page.incoming_phone_numbers ?? [])
          out.push({
            sid: n.sid,
            e164: n.phone_number,
            friendlyName: n.friendly_name || null,
            capabilities: caps(n.capabilities),
            smsUrl: n.sms_url || null,
            voiceUrl: n.voice_url || null,
          });
        url = page.next_page_uri ? `${TWILIO_HOST}${page.next_page_uri}` : null;
      }
      return out.slice(0, limit);
    },

    async configureNumber(account, numberSid, urls) {
      await call(
        credsOf(account),
        'POST',
        `${API}/Accounts/${account.sid}/IncomingPhoneNumbers/${numberSid}.json`,
        {
          SmsUrl: urls.smsUrl,
          SmsMethod: 'POST',
          VoiceUrl: urls.voiceUrl,
          VoiceMethod: 'POST',
          StatusCallback: urls.voiceStatusUrl,
          StatusCallbackMethod: 'POST',
          // A number transferred in from another account can still carry its old owner's TwiML apps, which
          // Twilio uses *instead of* the addresses above, and fallbacks that would hand a text to them the
          // moment ours hiccupped. Empty clears them.
          SmsApplicationSid: '',
          VoiceApplicationSid: '',
          SmsFallbackUrl: '',
          VoiceFallbackUrl: '',
        },
      );
    },

    async lookupNumber(e164) {
      const res = await call<{
        valid?: boolean;
        line_type_intelligence?: { carrier_name?: string | null; type?: string | null } | null;
      }>(masterCreds, 'GET', `${LOOKUPS}/${encodeURIComponent(e164)}`, {
        Fields: 'line_type_intelligence',
      });
      const line = res.line_type_intelligence ?? null;
      return { carrierName: line?.carrier_name || null, lineType: line?.type || null };
    },

    async inspectAccount(creds) {
      const res = await call<{
        sid: string;
        friendly_name?: string | null;
        status?: string | null;
        owner_account_sid?: string | null;
      }>(externalCreds(creds), 'GET', `${API}/Accounts/${creds.accountSid}.json`);
      return {
        sid: res.sid,
        friendlyName: res.friendly_name || null,
        status: res.status ?? 'active',
        // Twilio answers a top-level account with its own sid here; only a real parent is a parent.
        ownerAccountSid:
          res.owner_account_sid && res.owner_account_sid !== res.sid ? res.owner_account_sid : null,
      };
    },

    async listAccountNumbers(creds, { limit }) {
      const auth = externalCreds(creds);
      // Signed in as a parent, Accounts.json is the parent and every subaccount; as a subaccount, itself.
      const accounts: { sid: string; friendly_name?: string | null }[] = [];
      let next: string | null = `${API}/Accounts.json?Status=active&PageSize=100`;
      while (next && accounts.length < MAX_LISTED_ACCOUNTS) {
        const page: {
          accounts?: { sid: string; friendly_name?: string | null }[];
          next_page_uri?: string | null;
        } = await call(auth, 'GET', next);
        accounts.push(...(page.accounts ?? []));
        next = page.next_page_uri ? `${TWILIO_HOST}${page.next_page_uri}` : null;
      }
      if (!accounts.some((a) => a.sid === creds.accountSid))
        accounts.unshift({ sid: creds.accountSid, friendly_name: null });

      const out: ExternalNumber[] = [];
      for (const a of accounts.slice(0, MAX_LISTED_ACCOUNTS)) {
        let url: string | null = `${API}/Accounts/${a.sid}/IncomingPhoneNumbers.json?PageSize=1000`;
        while (url && out.length < limit) {
          const page: {
            incoming_phone_numbers?: IncomingNumberJson[];
            next_page_uri?: string | null;
          } = await call(auth, 'GET', url);
          for (const n of page.incoming_phone_numbers ?? [])
            out.push({
              sid: n.sid,
              accountSid: n.account_sid,
              accountName: a.friendly_name || null,
              e164: n.phone_number,
              friendlyName: n.friendly_name || null,
              capabilities: caps(n.capabilities),
              smsUrl: n.sms_url || null,
              voiceUrl: n.voice_url || null,
            });
          url = page.next_page_uri ? `${TWILIO_HOST}${page.next_page_uri}` : null;
        }
        if (out.length >= limit) break;
      }
      return out.slice(0, limit);
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
      // RCS first (0103): the service tries RCS and falls back to an SMS or MMS from the thread's own number.
      const rcsFirst = !!m.rcsFirst && !!m.messagingServiceSid;
      const res = await call<{ sid: string; status: string }>(
        credsOf(account),
        'POST',
        `${API}/Accounts/${account.sid}/Messages.json`,
        {
          To: m.to,
          ...(m.messagingServiceSid
            ? { MessagingServiceSid: m.messagingServiceSid }
            : { From: m.from }),
          ...(rcsFirst ? { FallbackFrom: m.from } : {}),
          // A rich text is its template: the card over RCS, its own text or media fallback otherwise.
          ...(m.contentSid
            ? { ContentSid: m.contentSid }
            : {
                Body: m.body,
                ...(m.mediaUrls.length > 0 ? { MediaUrl: m.mediaUrls } : {}),
              }),
          StatusCallback: m.statusCallbackUrl,
        },
      );
      return { sid: res.sid, status: res.status };
    },

    async listRcsSenders(account) {
      const out: RcsSenderInfo[] = [];
      let url: string | null = `${SENDERS}?Channel=rcs&PageSize=100`;
      // A business has one or two; five pages is a ceiling on a loop, not a limit anybody meets.
      for (let page = 0; url && page < 5; page++) {
        const res: { senders?: SenderJson[]; meta?: { next_page_url?: string | null } } =
          await call(credsOf(account), 'GET', url);
        for (const j of res.senders ?? []) if (j.sid) out.push(senderOf(j));
        url = res.meta?.next_page_url ?? null;
      }
      return out;
    },

    async fetchRcsSender(account, sid) {
      const j = await getIfThere<SenderJson>(credsOf(account), `${SENDERS}/${sid}`);
      return j ? senderOf(j) : null;
    },

    async addRcsSenderToService(account, serviceSid, senderSid) {
      const creds = credsOf(account);
      const url = `${MESSAGING}/Services/${serviceSid}/ChannelSenders`;
      // Asked first rather than caught after: Twilio documents no error code for "already in the pool".
      const list = await call<{ senders?: { sid: string }[] }>(creds, 'GET', url, {
        PageSize: '100',
      });
      if ((list.senders ?? []).some((x) => x.sid === senderSid)) return;
      await call(creds, 'POST', url, { Sid: senderSid });
    },

    async removeRcsSenderFromService(account, serviceSid, senderSid) {
      await deleteIfThere(
        credsOf(account),
        `${MESSAGING}/Services/${serviceSid}/ChannelSenders/${senderSid}`,
      );
    },

    async createContent(account, template) {
      const res = await callJson<{ sid: string }>(credsOf(account), CONTENT, {
        friendly_name: template.friendlyName,
        language: 'en',
        types: template.types,
      });
      return { sid: res.sid };
    },

    async deleteContent(account, contentSid) {
      await deleteIfThere(credsOf(account), `${CONTENT}/${contentSid}`);
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
      // A whole call's words (GT…) live in Conversational Intelligence; a voicemail's (TR…) with the recording.
      const url = transcriptionSid.startsWith('GT')
        ? `${INTELLIGENCE}/Transcripts/${transcriptionSid}`
        : `${API}/Accounts/${account.sid}/Transcriptions/${transcriptionSid}.json`;
      try {
        await call(credsOf(account), 'DELETE', url);
      } catch (e) {
        if (!(e instanceof ProviderError && e.httpStatus === 404)) throw e;
      }
    },

    async placeCall(account, r) {
      const res = await call<{ sid: string }>(
        credsOf(account),
        'POST',
        `${API}/Accounts/${account.sid}/Calls.json`,
        {
          To: r.to,
          From: r.from,
          Url: r.answerUrl,
          Method: 'POST',
          StatusCallback: r.statusCallbackUrl,
          StatusCallbackMethod: 'POST',
          StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          Timeout: String(r.timeoutSeconds),
          ...(r.record
            ? {
                Record: 'true',
                RecordingChannels: 'dual',
                RecordingStatusCallback: r.record.statusCallbackUrl,
                RecordingStatusCallbackMethod: 'POST',
                RecordingStatusCallbackEvent: ['completed', 'absent'],
              }
            : {}),
          ...(r.machineDetection
            ? {
                MachineDetection: r.machineDetection === 'beep' ? 'DetectMessageEnd' : 'Enable',
              }
            : {}),
        },
      );
      return { sid: res.sid };
    },

    async endCall(account, callSid) {
      try {
        // `completed` hangs up whatever state the call is in (`canceled` would leave an answered one going).
        await call(
          credsOf(account),
          'POST',
          `${API}/Accounts/${account.sid}/Calls/${callSid}.json`,
          {
            Status: 'completed',
          },
        );
      } catch (e) {
        // Already over: gone (404), or "Call is not in-progress" (21220).
        if (!(e instanceof ProviderError && (e.httpStatus === 404 || e.code === '21220'))) throw e;
      }
    },

    async redirectCall(account, callSid, twiml) {
      try {
        await call(
          credsOf(account),
          'POST',
          `${API}/Accounts/${account.sid}/Calls/${callSid}.json`,
          {
            Twiml: twiml,
          },
        );
      } catch (e) {
        // Already over: gone (404), or "Call is not in-progress" (21220).
        if (!(e instanceof ProviderError && (e.httpStatus === 404 || e.code === '21220'))) throw e;
      }
    },

    async transcribeRecording(account, recordingSid) {
      const creds = credsOf(account);
      const res = await call<{ sid: string }>(creds, 'POST', `${INTELLIGENCE}/Transcripts`, {
        ServiceSid: await transcriptService(creds),
        Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
        CustomerKey: recordingSid,
      });
      return { transcriptionSid: res.sid };
    },

    async fetchTranscription(account, transcriptionSid) {
      const creds = credsOf(account);
      const t = await call<{ status?: string | null }>(
        creds,
        'GET',
        `${INTELLIGENCE}/Transcripts/${transcriptionSid}`,
      );
      const status = (t.status ?? '').toLowerCase();
      if (status === 'failed' || status === 'canceled' || status === 'error')
        return { status: 'failed' };
      if (status !== 'completed') return { status: 'pending' };
      const found: { index: number; channel: number; text: string }[] = [];
      let url: string | null =
        `${INTELLIGENCE}/Transcripts/${transcriptionSid}/Sentences?PageSize=1000`;
      for (let page = 0; url && page < 20; page++) {
        const res: {
          sentences?: IntelligenceSentence[];
          meta?: { next_page_url?: string | null };
        } = await call(creds, 'GET', url);
        for (const x of res.sentences ?? []) {
          const text = x.transcript?.trim();
          if (text)
            found.push({
              index: x.sentence_index ?? found.length,
              channel: x.media_channel ?? 0,
              text,
            });
        }
        url = res.meta?.next_page_url ?? null;
      }
      found.sort((a, b) => a.index - b.index);
      return {
        status: 'completed',
        sentences: found.map(({ channel, text }) => ({ channel, text })),
      };
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

    /**
     * What Twilio actually charged this business, day by day. Read from the **subaccount's** own daily usage
     * records, which is what makes this authoritative per tenant with no allocation guesswork: one workspace,
     * one subaccount, one set of records.
     *
     * `Category` is left off on purpose. Asking for every category is one request instead of a dozen, and it
     * is the only way to see a line we are not pricing at all — a carrier fee, a recording, a lookup — which
     * is half of what the reconciliation is for.
     */
    /**
     * Moving a number a business already owns (M17). Two Twilio products behind one seam:
     *
     * - **full** → the Porting API. Texts and calls both come to us, in two to four weeks, and the losing
     *   carrier can refuse.
     * - **hosted_messaging** → Hosted Numbers. We take over texting only, in days, and their calls carry on
     *   exactly where they are — which is why so many businesses actually want this one and not the other.
     *
     * The account number and PIN in `submission` are the **losing carrier's** credentials. They go straight
     * into the request body and are never logged, never returned, and never put on a phone.
     */
    async submitPort(account, request) {
      const sub = request.submission as Record<string, string | undefined>;
      const creds = credsOf(account);
      if (request.kind === 'hosted_messaging') {
        const order = await call<{ sid: string; status: string }>(creds, 'POST', HOSTED, {
          PhoneNumber: request.e164,
          SmsCapability: 'true',
          AddressSid: sub['addressSid'],
          Email: sub['email'],
          FriendlyName: sub['businessName'],
        });
        return {
          providerSid: order.sid,
          providerStatus: order.status,
          status: portOutcome(order.status),
          rejectionReason: null,
          scheduledFor: null,
        };
      }
      const port = await call<{ port_in_request_sid: string; status: string }>(
        creds,
        'POST',
        `${PORTING}`,
        {
          PhoneNumbers: [request.e164],
          AccountSid: account.sid,
          LosingCarrierAccountNumber: sub['accountNumber'],
          LosingCarrierPin: sub['pin'],
          AuthorizedRepresentative: sub['authorizedBy'],
          ServiceAddress: sub['serviceAddress'],
        },
      );
      return {
        providerSid: port.port_in_request_sid,
        providerStatus: port.status,
        status: portOutcome(port.status),
        rejectionReason: null,
        scheduledFor: null,
      };
    },

    async fetchPort(account, providerSid) {
      const creds = credsOf(account);
      // A hosted order and a port-in have different sid prefixes, so the sid says which product to ask.
      const hosted = providerSid.startsWith('HR');
      const url = hosted ? `${HOSTED}/${providerSid}` : `${PORTING}/${providerSid}`;
      const got = await call<{
        sid?: string;
        port_in_request_sid?: string;
        status: string;
        failure_reason?: string | null;
        target_port_in_date?: string | null;
      }>(creds, 'GET', url);
      const status = portOutcome(got.status);
      return {
        providerSid,
        providerStatus: got.status,
        status,
        rejectionReason: status === 'rejected' ? (got.failure_reason ?? null) : null,
        scheduledFor: got.target_port_in_date ?? null,
      };
    },

    async uploadPortDocument(account, { portSid, name, contentType, data }) {
      // The same Trust Hub upload the A2P supporting documents use, then attached to the port.
      const creds = credsOf(account);
      const body = new FormData();
      body.append('FriendlyName', name);
      body.append('File', new Blob([data as BlobPart], { type: contentType }), name);
      const res = await fetch(`${TRUST_HUB}/SupportingDocuments`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${creds.sid}:${creds.token}`).toString('base64')}`,
        },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok) throw providerError(res.status, json as { code?: number; message?: string });
      const sid = json.sid;
      if (!sid)
        throw new ProviderError('The carrier did not take the document.', 'port_document', true);
      await call(creds, 'POST', `${PORTING}/${portSid}/Documents`, { DocumentSid: sid });
      return { sid };
    },

    async cancelPort(account, providerSid) {
      const creds = credsOf(account);
      const hosted = providerSid.startsWith('HR');
      await call(
        creds,
        'DELETE',
        hosted ? `${HOSTED}/${providerSid}` : `${PORTING}/${providerSid}`,
      );
    },

    async usageDaily(account, range) {
      const out: DailyUsage[] = [];
      let url: string | null =
        `${API}/Accounts/${account.sid}/Usage/Records/Daily.json` +
        `?StartDate=${range.start}&EndDate=${range.end}&PageSize=1000`;
      // Twilio pages with a full URL of its own; a month of a busy business runs past one page.
      while (url) {
        const page: UsagePage = await call<UsagePage>(credsOf(account), 'GET', url);
        for (const r of page.usage_records ?? []) {
          const costMicros = Math.round(Number(r.price ?? 0) * -1_000_000);
          out.push({
            day: String(r.start_date ?? ''),
            category: String(r.category ?? ''),
            count: Number(r.count ?? 0) || 0,
            // Twilio writes what it charged us as a negative number. Ours is what we paid, so it is positive.
            costMicros: Number.isFinite(costMicros) ? Math.abs(costMicros) : 0,
          });
        }
        url = page.next_page_uri ? `https://api.twilio.com${page.next_page_uri}` : null;
      }
      return out.filter((r) => r.day && r.category);
    },
  };
}

interface UsagePage {
  readonly usage_records?: readonly {
    readonly start_date?: string;
    readonly category?: string;
    readonly count?: string | number;
    readonly price?: string | number;
  }[];
  readonly next_page_uri?: string | null;
}
