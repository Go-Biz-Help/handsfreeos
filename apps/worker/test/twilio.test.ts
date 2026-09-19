import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  type ProviderAccount,
  type RegistrationKind,
  type RegistrationRequest,
} from '../src/telephony/provider';
import { createTwilioTelephony } from '../src/telephony/twilio';

/**
 * The Twilio provider against a recorded fetch: which host, path, credentials and form fields each call uses.
 * Ids here are made up and never hex, so secret scanners leave them alone.
 */
interface Seen {
  method: string;
  url: string;
  path: string;
  auth: string;
  body: URLSearchParams;
}
type Route = [RegExp, (seen: Seen) => { status?: number; json?: unknown }];

function mockTwilio(routes: Route[]): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const url = String(input);
      const s: Seen = {
        method: init.method ?? 'GET',
        url,
        path: new URL(url).pathname,
        auth: Buffer.from(
          (headers['authorization'] ?? '').replace('Basic ', ''),
          'base64',
        ).toString(),
        body: new URLSearchParams(init.body ? String(init.body) : ''),
      };
      seen.push(s);
      const route = routes.find(([pattern]) =>
        pattern.test(`${s.method} ${new URL(url).host}${s.path}`),
      );
      const out = route
        ? route[1](s)
        : { status: 404, json: { code: 20404, message: 'not mocked' } };
      const status = out.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(out.json ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

const MASTER = { accountSid: 'ACmastertest', authToken: 'master-token' };
const account: ProviderAccount = {
  id: '00000000-0000-4000-8000-000000000001',
  sid: 'ACsubtest',
  authToken: 'sub-token',
  messagingServiceSid: 'MGservicetest',
  apiKeySid: null,
  apiKeySecret: null,
  twimlAppSid: null,
};
const business = {
  legalName: 'Lone Star HVAC LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://lonestarhvac.example',
  address: {
    line1: '4410 Westpark Dr',
    city: 'Houston',
    state: 'TX',
    postalCode: '77027',
    country: 'US',
  },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '+17135550161',
  },
  useCase: 'customer_care',
  messageSamples: [
    'Hi Mike, this is Lone Star HVAC. Marco is on the way. Reply STOP to opt out.',
    'Hi Mike, your estimate for the new AC unit is ready. Reply with questions or STOP to opt out.',
  ],
  optInDescription:
    'Customers give us their cell number when they book a visit and agree to texts about it.',
  monthlyVolume: 'under_1000',
};
/** What the carriers are told a customer-care business texts: the 10DLC Description and toll-free UseCaseSummary. */
const CARE_USE_CASE =
  'Lone Star HVAC LLC sends automated and one-to-one texts to people who contacted it or booked with it: replies to new inquiries, a text back after a missed call, appointment confirmations and reminders, technician arrival notices, follow-ups on estimates, review requests and answers to customer questions. Every message includes opt-out instructions, and replying STOP stops them.';
const request = (
  kind: RegistrationKind,
  previous: RegistrationRequest['previous'] = {},
  submission: Record<string, unknown> = business,
): RegistrationRequest => ({
  kind,
  submission,
  phoneNumberSid: 'PNnumbertest',
  phoneNumberE164: '+18335551234',
  previous,
  messagingServiceSid: 'MGservicetest',
  notifyEmail: 'dale@example.com',
  replaces: null,
});
const urls = {
  smsUrl: 'https://hooks.example.com/webhooks/twilio/messaging/inbound',
  smsStatusUrl: 'https://hooks.example.com/webhooks/twilio/messaging/status',
  voiceUrl: 'https://hooks.example.com/webhooks/twilio/voice/inbound',
  voiceStatusUrl: 'https://hooks.example.com/webhooks/twilio/voice/status',
  voiceOutboundUrl: 'https://hooks.example.com/webhooks/twilio/voice/outbound',
};

describe('numbers and texts', () => {
  it('searches with the master account and reads capabilities in either casing', async () => {
    const seen = mockTwilio([
      [
        /^GET api\.twilio\.com\/2010-04-01\/Accounts\/ACmastertest\/AvailablePhoneNumbers\/US\/Local\.json$/,
        () => ({
          json: {
            available_phone_numbers: [
              {
                phone_number: '+17135551234',
                locality: 'Houston',
                region: 'TX',
                capabilities: { SMS: true, MMS: true, voice: true },
              },
            ],
          },
        }),
      ],
    ]);
    const found = await createTwilioTelephony(MASTER).searchNumbers({
      numberType: 'local',
      areaCode: '713',
      limit: 5,
    });
    expect(found).toEqual([
      {
        e164: '+17135551234',
        locality: 'Houston',
        region: 'TX',
        capabilities: { sms: true, mms: true, voice: true },
      },
    ]);
    expect(seen[0]!.auth).toBe('ACmastertest:master-token');
    const q = new URL(seen[0]!.url).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      AreaCode: '713',
      SmsEnabled: 'true',
      MmsEnabled: 'true',
      VoiceEnabled: 'true',
      PageSize: '5',
    });
  });

  it('narrows one search by city, state and a digit pattern together', async () => {
    const seen = mockTwilio([
      [
        /^GET api\.twilio\.com\/2010-04-01\/Accounts\/ACmastertest\/AvailablePhoneNumbers\/US\/Local\.json$/,
        () => ({
          json: {
            available_phone_numbers: [
              {
                phone_number: '+12569914540',
                locality: 'Huntsville',
                region: 'AL',
                capabilities: { SMS: true, MMS: true, voice: true },
              },
            ],
          },
        }),
      ],
    ]);
    const found = await createTwilioTelephony(MASTER).searchNumbers({
      numberType: 'local',
      areaCode: '256',
      contains: '454',
      city: 'Huntsville',
      state: 'AL',
      limit: 5,
    });
    expect(found[0]!.locality).toBe('Huntsville');
    expect(Object.fromEntries(new URL(seen[0]!.url).searchParams)).toMatchObject({
      AreaCode: '256',
      Contains: '454',
      InLocality: 'Huntsville',
      InRegion: 'AL',
    });
  });

  it('leaves the city off a toll-free search, which has no geography', async () => {
    const seen = mockTwilio([
      [
        /^GET api\.twilio\.com\/2010-04-01\/Accounts\/ACmastertest\/AvailablePhoneNumbers\/US\/TollFree\.json$/,
        () => ({ json: { available_phone_numbers: [] } }),
      ],
    ]);
    await createTwilioTelephony(MASTER).searchNumbers({
      numberType: 'toll_free',
      contains: '454',
      city: 'Huntsville',
      state: 'AL',
      limit: 5,
    });
    const q = new URL(seen[0]!.url).searchParams;
    expect(q.get('Contains')).toBe('454');
    expect(q.get('InLocality')).toBeNull();
    expect(q.get('InRegion')).toBeNull();
  });

  it('buys with the subaccount and points the number at the worker', async () => {
    const seen = mockTwilio([
      [
        /^POST api\.twilio\.com\/2010-04-01\/Accounts\/ACsubtest\/IncomingPhoneNumbers\.json$/,
        () => ({
          status: 201,
          json: { sid: 'PNboughttest', capabilities: { sms: true, mms: true, voice: true } },
        }),
      ],
    ]);
    const bought = await createTwilioTelephony(MASTER).buyNumber(account, {
      e164: '+18335551234',
      urls,
    });
    expect(bought).toEqual({
      sid: 'PNboughttest',
      capabilities: { sms: true, mms: true, voice: true },
    });
    expect(seen[0]!.auth).toBe('ACsubtest:sub-token');
    expect(Object.fromEntries(seen[0]!.body)).toMatchObject({
      PhoneNumber: '+18335551234',
      SmsUrl: urls.smsUrl,
      VoiceUrl: urls.voiceUrl,
      StatusCallback: urls.voiceStatusUrl,
    });
  });

  it('creates the messaging service with smart encoding, so curly quotes don’t cost extra', async () => {
    const seen = mockTwilio([
      [
        /^POST messaging\.twilio\.com\/v1\/Services$/,
        () => ({ status: 201, json: { sid: 'MGnewtest' } }),
      ],
    ]);
    const sid = await createTwilioTelephony(MASTER).createMessagingService(account, {
      friendlyName: 'Lone Star HVAC',
      inboundUrl: urls.smsUrl,
      statusCallbackUrl: urls.smsStatusUrl,
    });
    expect(sid).toBe('MGnewtest');
    expect(seen[0]!.auth).toBe('ACsubtest:sub-token');
    expect(Object.fromEntries(seen[0]!.body)).toMatchObject({
      FriendlyName: 'Lone Star HVAC',
      InboundRequestUrl: urls.smsUrl,
      StatusCallback: urls.smsStatusUrl,
      UseInboundWebhookOnNumber: 'false',
      SmartEncoding: 'true',
    });
  });

  it('sends through the messaging service with one MediaUrl per photo', async () => {
    const seen = mockTwilio([
      [
        /^POST api\.twilio\.com\/2010-04-01\/Accounts\/ACsubtest\/Messages\.json$/,
        () => ({ status: 201, json: { sid: 'SMsenttest', status: 'accepted' } }),
      ],
    ]);
    const sent = await createTwilioTelephony(MASTER).sendMessage(account, {
      from: '+18335551234',
      messagingServiceSid: 'MGservicetest',
      to: '+17135550142',
      body: 'Here is the photo.',
      mediaUrls: ['https://files.example.com/a.png', 'https://files.example.com/b.png'],
      statusCallbackUrl: urls.smsStatusUrl,
    });
    expect(sent).toEqual({ sid: 'SMsenttest', status: 'accepted' });
    const body = seen[0]!.body;
    expect(body.getAll('MediaUrl')).toEqual([
      'https://files.example.com/a.png',
      'https://files.example.com/b.png',
    ]);
    expect(body.get('MessagingServiceSid')).toBe('MGservicetest');
    expect(body.has('From')).toBe(false);
    expect(body.get('StatusCallback')).toBe(urls.smsStatusUrl);
  });

  it('keeps permanent refusals apart from ones worth retrying', async () => {
    const seen = mockTwilio([
      [
        /^POST .*\/IncomingPhoneNumbers\.json$/,
        () => ({ status: 400, json: { code: 21422, message: 'PhoneNumber is not available' } }),
      ],
      [
        /^POST .*\/Messages\.json$/,
        () => ({ status: 429, json: { code: 20429, message: 'Too many requests' } }),
      ],
      [
        /^POST messaging\.twilio\.com\/v1\/Services\/MGservicetest\/PhoneNumbers$/,
        () => ({ status: 409, json: { code: 21710 } }),
      ],
      [
        /^DELETE .*\/IncomingPhoneNumbers\/PNgonetest\.json$/,
        () => ({ status: 404, json: { code: 20404 } }),
      ],
      [/^DELETE .*\/Media\/MEphototest\.json$/, () => ({ status: 204 })],
    ]);
    const t = createTwilioTelephony(MASTER);
    const refused = t.buyNumber(account, { e164: '+18335550000', urls });
    await expect(refused).rejects.toBeInstanceOf(ProviderError);
    await expect(t.buyNumber(account, { e164: '+18335550000', urls })).rejects.toMatchObject({
      code: '21422',
      permanent: true,
    });
    await expect(
      t.sendMessage(account, {
        from: '+18335551234',
        messagingServiceSid: 'MGservicetest',
        to: '+17135550142',
        body: 'hi',
        mediaUrls: [],
        statusCallbackUrl: urls.smsStatusUrl,
      }),
    ).rejects.toMatchObject({ permanent: false, httpStatus: 429 });
    await expect(
      t.addNumberToService(account, 'MGservicetest', 'PNnumbertest'),
    ).resolves.toBeUndefined();
    await expect(t.releaseNumber(account, 'PNgonetest')).resolves.toBeUndefined();
    await expect(
      t.deleteMedia(
        account,
        'https://api.twilio.com/2010-04-01/Accounts/ACsubtest/Messages/MMphototest/Media/MEphototest',
      ),
    ).resolves.toBeUndefined();
    expect(seen.at(-1)!.path).toMatch(/\/Media\/MEphototest\.json$/);
  });
});

describe('toll-free verification', () => {
  it('sends the business registration fields and reads the verdict', async () => {
    const seen = mockTwilio([
      [
        /^POST messaging\.twilio\.com\/v1\/Tollfree\/Verifications$/,
        () => ({ status: 201, json: { sid: 'HHverifytest', status: 'PENDING_REVIEW' } }),
      ],
      [
        /^GET messaging\.twilio\.com\/v1\/Tollfree\/Verifications\/HHverifytest$/,
        () => ({
          json: {
            sid: 'HHverifytest',
            status: 'TWILIO_REJECTED',
            rejection_reason: 'Opt-in is unclear.',
          },
        }),
      ],
    ]);
    const t = createTwilioTelephony(MASTER);
    expect(await t.submitRegistration(account, request('toll_free_verification'))).toEqual({
      providerSid: 'HHverifytest',
      providerStatus: 'PENDING_REVIEW',
      status: 'in_review',
      rejectionReason: null,
    });
    const body = seen[0]!.body;
    expect(seen[0]!.auth).toBe('ACsubtest:sub-token');
    expect(Object.fromEntries(body)).toMatchObject({
      TollfreePhoneNumberSid: 'PNnumbertest',
      BusinessType: 'PRIVATE_PROFIT',
      BusinessRegistrationNumber: '123456789',
      BusinessRegistrationAuthority: 'EIN',
      BusinessRegistrationCountry: 'US',
      MessageVolume: '1,000',
      OptInType: 'VERBAL',
    });
    expect(body.getAll('UseCaseCategories')).toEqual(['CUSTOMER_CARE', 'ACCOUNT_NOTIFICATIONS']);
    // The use case names the automated texts and STOP; how customers agree goes alongside it.
    expect(body.get('UseCaseSummary')).toBe(CARE_USE_CASE);
    expect(body.get('AdditionalInformation')).toBe(business.optInDescription);
    expect(
      await t.fetchRegistration(account, {
        kind: 'toll_free_verification',
        providerSid: 'HHverifytest',
      }),
    ).toEqual({
      providerSid: 'HHverifytest',
      providerStatus: 'TWILIO_REJECTED',
      status: 'rejected',
      rejectionReason: 'Opt-in is unclear.',
    });
  });

  it('tells the carriers a business with occasional promotions sends the same, plus offers', async () => {
    const seen = mockTwilio([
      [
        /^POST messaging\.twilio\.com\/v1\/Tollfree\/Verifications$/,
        () => ({ status: 201, json: { sid: 'HHmixedtest', status: 'PENDING_REVIEW' } }),
      ],
    ]);
    const t = createTwilioTelephony(MASTER);
    await t.submitRegistration(
      account,
      request('toll_free_verification', {}, { ...business, useCase: 'mixed' }),
    );
    expect(seen[0]!.body.get('UseCaseSummary')).toBe(
      CARE_USE_CASE.replace(
        'answers to customer questions.',
        'answers to customer questions, and occasional seasonal offers.',
      ),
    );
    expect(seen[0]!.body.getAll('UseCaseCategories')).toContain('MARKETING');
  });
});

describe('local numbers (10DLC)', () => {
  const bundleRoutes = (evaluation: unknown): Route[] => {
    let endUsers = 0;
    return [
      [
        /^POST trusthub\.twilio\.com\/v1\/CustomerProfiles$/,
        () => ({ status: 201, json: { sid: 'BUclienttest' } }),
      ],
      [
        /^POST trusthub\.twilio\.com\/v1\/EndUsers$/,
        () => ({ status: 201, json: { sid: ++endUsers === 1 ? 'ITinfotest' : 'ITreptest' } }),
      ],
      [/\/EntityAssignments$/, () => ({ status: 201, json: { sid: 'BVassigntest' } })],
      [
        /^POST api\.twilio\.com\/2010-04-01\/Accounts\/ACsubtest\/Addresses\.json$/,
        () => ({ status: 201, json: { sid: 'ADaddresstest' } }),
      ],
      [
        /^POST trusthub\.twilio\.com\/v1\/SupportingDocuments$/,
        () => ({ status: 201, json: { sid: 'RDdoctest' } }),
      ],
      [/\/Evaluations$/, () => ({ status: 201, json: evaluation })],
      [
        /^POST trusthub\.twilio\.com\/v1\/CustomerProfiles\/BUclienttest$/,
        () => ({ json: { sid: 'BUclienttest', status: 'pending-review' } }),
      ],
    ];
  };

  it('builds the client profile in its subaccount and links it under the HandsFreeOS profile', async () => {
    const seen = mockTwilio(bundleRoutes({ status: 'compliant', results: [] }));
    const t = createTwilioTelephony({ ...MASTER, primaryProfileSid: 'BUprimarytest' });
    expect(await t.submitRegistration(account, request('a2p_customer_profile'))).toMatchObject({
      providerSid: 'BUclienttest',
      providerStatus: 'pending-review',
      status: 'in_review',
    });
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /v1/CustomerProfiles',
      'POST /v1/EndUsers',
      'POST /v1/CustomerProfiles/BUclienttest/EntityAssignments',
      'POST /v1/EndUsers',
      'POST /v1/CustomerProfiles/BUclienttest/EntityAssignments',
      'POST /2010-04-01/Accounts/ACsubtest/Addresses.json',
      'POST /v1/SupportingDocuments',
      'POST /v1/CustomerProfiles/BUclienttest/EntityAssignments',
      'POST /v1/CustomerProfiles/BUclienttest/EntityAssignments',
      'POST /v1/CustomerProfiles/BUclienttest/Evaluations',
      'POST /v1/CustomerProfiles/BUclienttest',
    ]);
    expect(seen.every((x) => x.auth === 'ACsubtest:sub-token')).toBe(true);
    expect(seen[0]!.body.get('PolicySid')).toBe('RNdfbf3fae0e1107f8aded0e7cead80bf5');
    expect(JSON.parse(seen[1]!.body.get('Attributes')!)).toMatchObject({
      business_name: 'Lone Star HVAC LLC',
      business_type: 'Limited Liability Corporation',
      business_registration_identifier: 'EIN',
      business_registration_number: '123456789',
    });
    expect(JSON.parse(seen[3]!.body.get('Attributes')!)).toMatchObject({
      first_name: 'Dale',
      last_name: 'Ramsey',
      phone_number: '+17135550161',
    });
    expect(JSON.parse(seen[6]!.body.get('Attributes')!)).toEqual({ address_sids: 'ADaddresstest' });
    expect(seen[8]!.body.get('ObjectSid')).toBe('BUprimarytest');
    expect(seen[10]!.body.get('Status')).toBe('pending-review');
  });

  it('says what is missing, and refuses before HandsFreeOS has its own profile or for sole proprietors', async () => {
    mockTwilio(
      bundleRoutes({
        status: 'noncompliant',
        results: [
          {
            passed: false,
            friendly_name: 'Business information',
            fields: [
              { passed: false, friendly_name: 'Website', failure_reason: 'The website must load.' },
            ],
          },
        ],
      }),
    );
    const withPrimary = createTwilioTelephony({ ...MASTER, primaryProfileSid: 'BUprimarytest' });
    await expect(
      withPrimary.submitRegistration(account, request('a2p_customer_profile')),
    ).rejects.toMatchObject({
      code: 'bundle_noncompliant',
      permanent: true,
      message: expect.stringContaining('The website must load.'),
    });
    await expect(
      createTwilioTelephony(MASTER).submitRegistration(account, request('a2p_customer_profile')),
    ).rejects.toMatchObject({ code: 'isv_profile_missing', permanent: true });
    await expect(
      withPrimary.submitRegistration(
        account,
        request(
          'a2p_customer_profile',
          {},
          { ...business, businessType: 'sole_proprietor', ein: null },
        ),
      ),
    ).rejects.toMatchObject({ code: 'a2p_sole_proprietor', permanent: true });
  });

  it('registers the trust product, brand and campaign on top of the earlier steps', async () => {
    const seen = mockTwilio([
      [
        /^POST trusthub\.twilio\.com\/v1\/TrustProducts$/,
        () => ({ status: 201, json: { sid: 'BUproducttest' } }),
      ],
      [
        /^POST trusthub\.twilio\.com\/v1\/EndUsers$/,
        () => ({ status: 201, json: { sid: 'ITa2ptest' } }),
      ],
      [/\/EntityAssignments$/, () => ({ status: 201, json: { sid: 'BVassigntest' } })],
      [/\/Evaluations$/, () => ({ status: 201, json: { status: 'compliant' } })],
      [
        /^POST trusthub\.twilio\.com\/v1\/TrustProducts\/BUproducttest$/,
        () => ({ json: { sid: 'BUproducttest', status: 'pending-review' } }),
      ],
      [
        /^POST messaging\.twilio\.com\/v1\/a2p\/BrandRegistrations$/,
        () => ({ status: 201, json: { sid: 'BNbrandtest', status: 'PENDING' } }),
      ],
      [
        /^POST messaging\.twilio\.com\/v1\/Services\/MGservicetest\/Compliance\/Usa2p$/,
        () => ({ status: 201, json: { sid: 'QEcampaigntest', campaign_status: 'PENDING' } }),
      ],
      [
        /^GET trusthub\.twilio\.com\/v1\/TrustProducts\/BUproducttest$/,
        () => ({ json: { sid: 'BUproducttest', status: 'twilio-approved' } }),
      ],
      [
        /^GET messaging\.twilio\.com\/v1\/a2p\/BrandRegistrations\/BNbrandtest$/,
        () => ({
          json: { sid: 'BNbrandtest', status: 'FAILED', failure_reason: 'The EIN does not match.' },
        }),
      ],
      [
        /^GET messaging\.twilio\.com\/v1\/Services\/MGservicetest\/Compliance\/Usa2p\/QEcampaigntest$/,
        () => ({ json: { sid: 'QEcampaigntest', campaign_status: 'VERIFIED' } }),
      ],
    ]);
    const t = createTwilioTelephony({ ...MASTER, primaryProfileSid: 'BUprimarytest' });

    const product = await t.submitRegistration(
      account,
      request('a2p_trust_product', { a2p_customer_profile: 'BUclienttest' }),
    );
    expect(product).toMatchObject({ providerSid: 'BUproducttest', status: 'in_review' });
    expect(seen[0]!.body.get('PolicySid')).toBe('RNb0d4771c2c98518d916a3d4cd70a8f8b');
    expect(JSON.parse(seen[1]!.body.get('Attributes')!)).toEqual({ company_type: 'private' });
    expect(
      seen.filter((x) => x.path.endsWith('/EntityAssignments')).map((x) => x.body.get('ObjectSid')),
    ).toEqual(['ITa2ptest', 'BUclienttest']);

    const brand = await t.submitRegistration(
      account,
      request('a2p_brand', {
        a2p_customer_profile: 'BUclienttest',
        a2p_trust_product: 'BUproducttest',
      }),
    );
    expect(brand).toMatchObject({ providerSid: 'BNbrandtest', status: 'in_review' });
    expect(Object.fromEntries(seen.at(-1)!.body)).toEqual({
      CustomerProfileBundleSid: 'BUclienttest',
      A2PProfileBundleSid: 'BUproducttest',
      BrandType: 'STANDARD',
      SkipAutomaticSecVet: 'true',
    });

    const campaign = await t.submitRegistration(
      account,
      request('a2p_campaign', { a2p_brand: 'BNbrandtest' }),
    );
    expect(campaign).toMatchObject({ providerSid: 'QEcampaigntest', status: 'in_review' });
    const body = seen.at(-1)!.body;
    expect(body.getAll('MessageSamples')).toEqual(business.messageSamples);
    expect(Object.fromEntries(body)).toMatchObject({
      BrandRegistrationSid: 'BNbrandtest',
      UsAppToPersonUsecase: 'CUSTOMER_CARE',
      HasEmbeddedLinks: 'false',
      HasEmbeddedPhone: 'false',
      MessageFlow: business.optInDescription,
    });
    expect(body.get('Description')).toBe(CARE_USE_CASE);

    await expect(
      t.submitRegistration(
        account,
        request(
          'a2p_campaign',
          { a2p_brand: 'BNbrandtest' },
          { ...business, messageSamples: [business.messageSamples[0]] },
        ),
      ),
    ).rejects.toMatchObject({ code: 'a2p_samples', permanent: true });

    expect(
      await t.fetchRegistration(account, {
        kind: 'a2p_trust_product',
        providerSid: 'BUproducttest',
      }),
    ).toMatchObject({
      status: 'approved',
    });
    expect(
      await t.fetchRegistration(account, { kind: 'a2p_brand', providerSid: 'BNbrandtest' }),
    ).toEqual({
      providerSid: 'BNbrandtest',
      providerStatus: 'FAILED',
      status: 'rejected',
      rejectionReason: 'The EIN does not match.',
    });
    expect(
      await t.fetchRegistration(account, { kind: 'a2p_campaign', providerSid: 'QEcampaigntest' }),
    ).toMatchObject({
      providerStatus: 'VERIFIED',
      status: 'approved',
    });
  });
});

describe('sending a turned-down registration again', () => {
  const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  it('edits a rejected toll-free verification while Twilio takes edits', async () => {
    const seen = mockTwilio([
      [
        /^GET messaging\.twilio\.com\/v1\/Tollfree\/Verifications\/HHverifytest$/,
        () => ({
          json: {
            sid: 'HHverifytest',
            status: 'TWILIO_REJECTED',
            rejection_reason: 'Opt-in is unclear.',
            edit_allowed: true,
            edit_expiration: inAWeek(),
          },
        }),
      ],
      [
        /^POST messaging\.twilio\.com\/v1\/Tollfree\/Verifications\/HHverifytest$/,
        () => ({
          json: {
            sid: 'HHverifytest',
            status: 'TWILIO_REJECTED',
            rejection_reason: 'Opt-in is unclear.',
          },
        }),
      ],
    ]);
    const state = await createTwilioTelephony(MASTER).submitRegistration(account, {
      ...request('toll_free_verification'),
      replaces: 'HHverifytest',
    });
    // The answer may still show the old decision: the edit itself is under review.
    expect(state).toEqual({
      providerSid: 'HHverifytest',
      providerStatus: 'TWILIO_REJECTED',
      status: 'in_review',
      rejectionReason: null,
    });
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/Tollfree/Verifications/HHverifytest',
      'POST /v1/Tollfree/Verifications/HHverifytest',
    ]);
    const body = Object.fromEntries(seen[1]!.body);
    expect(body).toMatchObject({
      BusinessName: 'Lone Star HVAC LLC',
      BusinessRegistrationNumber: '123456789',
      EditReason: expect.any(String),
    });
    expect(body).not.toHaveProperty('TollfreePhoneNumberSid');
    expect(body).not.toHaveProperty('ExternalReferenceId');
    expect(seen.every((x) => x.auth === 'ACsubtest:sub-token')).toBe(true);
  });

  it('replaces it with a new request once the edit window closed, and leaves one back in review alone', async () => {
    let status = 'TWILIO_REJECTED';
    const seen = mockTwilio([
      [
        /^GET messaging\.twilio\.com\/v1\/Tollfree\/Verifications\/HHverifytest$/,
        () => ({
          json: {
            sid: 'HHverifytest',
            status,
            edit_allowed: false,
            edit_expiration: new Date(Date.now() - 86_400_000).toISOString(),
          },
        }),
      ],
      [
        /^DELETE messaging\.twilio\.com\/v1\/Tollfree\/Verifications\/HHverifytest$/,
        () => ({ status: 204 }),
      ],
      [
        /^POST messaging\.twilio\.com\/v1\/Tollfree\/Verifications$/,
        () => ({ status: 201, json: { sid: 'HHnewtest', status: 'PENDING_REVIEW' } }),
      ],
    ]);
    const t = createTwilioTelephony(MASTER);
    const again = { ...request('toll_free_verification'), replaces: 'HHverifytest' };
    expect(await t.submitRegistration(account, again)).toMatchObject({
      providerSid: 'HHnewtest',
      status: 'in_review',
    });
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/Tollfree/Verifications/HHverifytest',
      'DELETE /v1/Tollfree/Verifications/HHverifytest',
      'POST /v1/Tollfree/Verifications',
    ]);
    expect(seen[2]!.body.get('TollfreePhoneNumberSid')).toBe('PNnumbertest');
    // Sent twice: the first is already back in review, so there is nothing to change.
    status = 'IN_REVIEW';
    seen.length = 0;
    expect(await t.submitRegistration(account, again)).toMatchObject({
      providerSid: 'HHverifytest',
      status: 'in_review',
    });
    expect(seen.map((x) => x.method)).toEqual(['GET']);
  });

  it('replaces a failed campaign, resubmits a failed brand, and only looks at the Trust Hub bundles', async () => {
    const seen = mockTwilio([
      [
        /^DELETE messaging\.twilio\.com\/v1\/Services\/MGservicetest\/Compliance\/Usa2p\/QEoldtest$/,
        () => ({ status: 204 }),
      ],
      [
        /^POST messaging\.twilio\.com\/v1\/Services\/MGservicetest\/Compliance\/Usa2p$/,
        () => ({ status: 201, json: { sid: 'QEnewtest', campaign_status: 'PENDING' } }),
      ],
      [
        /^POST messaging\.twilio\.com\/v1\/a2p\/BrandRegistrations\/BNbrandtest$/,
        () => ({ json: { sid: 'BNbrandtest', status: 'IN_REVIEW' } }),
      ],
      [
        /^GET trusthub\.twilio\.com\/v1\/CustomerProfiles\/BUclienttest$/,
        () => ({ json: { sid: 'BUclienttest', status: 'pending-review' } }),
      ],
      [
        /^GET trusthub\.twilio\.com\/v1\/TrustProducts\/BUproducttest$/,
        () => ({
          json: {
            sid: 'BUproducttest',
            status: 'twilio-rejected',
            errors: [{ description: 'The business type does not match.' }],
          },
        }),
      ],
    ]);
    const t = createTwilioTelephony({ ...MASTER, primaryProfileSid: 'BUprimarytest' });
    // One example text is refused before the old campaign goes.
    await expect(
      t.submitRegistration(account, {
        ...request(
          'a2p_campaign',
          { a2p_brand: 'BNbrandtest' },
          { ...business, messageSamples: [business.messageSamples[0]] },
        ),
        replaces: 'QEoldtest',
      }),
    ).rejects.toMatchObject({ code: 'a2p_samples' });
    expect(seen).toHaveLength(0);
    expect(
      await t.submitRegistration(account, {
        ...request('a2p_campaign', { a2p_brand: 'BNbrandtest' }),
        replaces: 'QEoldtest',
      }),
    ).toMatchObject({ providerSid: 'QEnewtest', status: 'in_review' });
    expect(
      await t.submitRegistration(account, { ...request('a2p_brand'), replaces: 'BNbrandtest' }),
    ).toMatchObject({ providerSid: 'BNbrandtest', status: 'in_review' });
    expect(
      await t.submitRegistration(account, {
        ...request('a2p_customer_profile'),
        replaces: 'BUclienttest',
      }),
    ).toMatchObject({ providerSid: 'BUclienttest', status: 'in_review' });
    expect(
      await t.submitRegistration(account, {
        ...request('a2p_trust_product'),
        replaces: 'BUproducttest',
      }),
    ).toMatchObject({ status: 'rejected', rejectionReason: 'The business type does not match.' });
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'DELETE /v1/Services/MGservicetest/Compliance/Usa2p/QEoldtest',
      'POST /v1/Services/MGservicetest/Compliance/Usa2p',
      'POST /v1/a2p/BrandRegistrations/BNbrandtest',
      'GET /v1/CustomerProfiles/BUclienttest',
      'GET /v1/TrustProducts/BUproducttest',
    ]);
    // The brand resubmission names only the brand.
    expect(seen[2]!.body.toString()).toBe('');
  });
});

describe('browser calls and voicemail recordings', () => {
  it('makes the subaccount key and TwiML app, fetches recordings as MP3, and deletes the provider copies', async () => {
    const sub = /^(POST|GET|DELETE) api\.twilio\.com\/2010-04-01\/Accounts\/ACsubtest\//;
    const seen = mockTwilio([
      [
        new RegExp(`${sub.source}Keys\\.json$`),
        () => ({ status: 201, json: { sid: 'SKkeytest', secret: 'key-secret-test' } }),
      ],
      [
        new RegExp(`${sub.source}Applications\\.json$`),
        () => ({ status: 201, json: { sid: 'APapptest' } }),
      ],
      [new RegExp(`${sub.source}Recordings/REtest\\.mp3$`), () => ({ json: { audio: true } })],
      [new RegExp(`${sub.source}Recordings/REtest\\.json$`), () => ({ status: 204 })],
      [
        new RegExp(`${sub.source}Transcriptions/TRtest\\.json$`),
        () => ({ status: 404, json: { code: 20404 } }),
      ],
    ]);
    const t = createTwilioTelephony(MASTER);
    expect(await t.createApiKey(account, 'HandsFreeOS calls 1234')).toEqual({
      sid: 'SKkeytest',
      secret: 'key-secret-test',
    });
    expect(
      await t.createTwimlApp(account, {
        friendlyName: 'HandsFreeOS calls 1234',
        voiceUrl: urls.voiceOutboundUrl,
        statusCallbackUrl: urls.voiceStatusUrl,
      }),
    ).toBe('APapptest');
    expect((await t.fetchRecording(account, 'REtest')).data.length).toBeGreaterThan(0);
    await t.deleteRecording(account, 'REtest');
    // Already gone at the provider is what we wanted.
    await t.deleteTranscription(account, 'TRtest');
    expect(seen.map((x) => `${x.method} ${x.path.split('/').pop()}`)).toEqual([
      'POST Keys.json',
      'POST Applications.json',
      'GET REtest.mp3',
      'DELETE REtest.json',
      'DELETE TRtest.json',
    ]);
    expect(seen.every((x) => x.auth === 'ACsubtest:sub-token')).toBe(true);
    expect(Object.fromEntries(seen[1]!.body)).toEqual({
      FriendlyName: 'HandsFreeOS calls 1234',
      VoiceUrl: urls.voiceOutboundUrl,
      VoiceMethod: 'POST',
      StatusCallback: urls.voiceStatusUrl,
      StatusCallbackMethod: 'POST',
    });
  });
});

describe('calls through a cell and their words', () => {
  it('places the call from the subaccount, with its answer and status addresses and a short ring', async () => {
    const seen = mockTwilio([
      [
        /^POST api\.twilio\.com\/2010-04-01\/Accounts\/ACsubtest\/Calls\.json$/,
        () => ({ status: 201, json: { sid: 'CAplacedtest' } }),
      ],
    ]);
    const t = createTwilioTelephony(MASTER);
    expect(
      await t.placeCall(account, {
        from: '+18335550100',
        to: '+15125550142',
        answerUrl: 'https://hooks.worker.test/webhooks/twilio/voice/bridge?callId=abc',
        statusCallbackUrl: 'https://hooks.worker.test/webhooks/twilio/voice/status',
        timeoutSeconds: 25,
      }),
    ).toEqual({ sid: 'CAplacedtest' });
    expect(seen[0]!.auth).toBe('ACsubtest:sub-token');
    expect(seen[0]!.body.getAll('StatusCallbackEvent')).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);
    const fields = Object.fromEntries(seen[0]!.body);
    delete fields['StatusCallbackEvent'];
    expect(fields).toEqual({
      To: '+15125550142',
      From: '+18335550100',
      Url: 'https://hooks.worker.test/webhooks/twilio/voice/bridge?callId=abc',
      Method: 'POST',
      StatusCallback: 'https://hooks.worker.test/webhooks/twilio/voice/status',
      StatusCallbackMethod: 'POST',
      Timeout: '25',
    });
  });

  it('transcribes in the subaccount’s own Conversational Intelligence service, made once, and reads the words in order', async () => {
    let services: { sid: string; unique_name: string }[] = [];
    let sentencesAsked = 0;
    const seen = mockTwilio([
      [/^GET intelligence\.twilio\.com\/v2\/Services$/, () => ({ json: { services } })],
      [
        /^POST intelligence\.twilio\.com\/v2\/Services$/,
        () => {
          services = [{ sid: 'GAservicetest', unique_name: 'hfos-call-transcripts' }];
          return { status: 201, json: { sid: 'GAservicetest' } };
        },
      ],
      [
        /^POST intelligence\.twilio\.com\/v2\/Transcripts$/,
        () => ({ status: 201, json: { sid: 'GTwordstest' } }),
      ],
      [
        /^GET intelligence\.twilio\.com\/v2\/Transcripts\/GTwordstest$/,
        () => ({ json: { status: sentencesAsked === 0 ? 'queued' : 'completed' } }),
      ],
      [
        /^GET intelligence\.twilio\.com\/v2\/Transcripts\/GTwordstest\/Sentences$/,
        (s) => {
          sentencesAsked++;
          return s.url.includes('Page=1')
            ? {
                json: {
                  sentences: [
                    { media_channel: 2, sentence_index: 1, transcript: 'Yes, go ahead.' },
                  ],
                  meta: { next_page_url: null },
                },
              }
            : {
                json: {
                  sentences: [
                    { media_channel: 1, sentence_index: 2, transcript: 'Thursday at one.' },
                    { media_channel: 1, sentence_index: 0, transcript: 'Hi, this is the office.' },
                    { media_channel: 2, sentence_index: 3, transcript: '  ' },
                  ],
                  meta: {
                    next_page_url:
                      'https://intelligence.twilio.com/v2/Transcripts/GTwordstest/Sentences?PageSize=1000&Page=1',
                  },
                },
              };
        },
      ],
      [/^DELETE intelligence\.twilio\.com\/v2\/Transcripts\/GTwordstest$/, () => ({ status: 204 })],
    ]);
    const t = createTwilioTelephony(MASTER);
    expect(await t.transcribeRecording(account, 'RErecordingtest')).toEqual({
      transcriptionSid: 'GTwordstest',
    });
    // Asked again (another call), the service is found by its name rather than made twice.
    await t.transcribeRecording(account, 'RErecordingtest2');
    const made = seen.filter((x) => x.method === 'POST' && x.path === '/v2/Services');
    expect(made).toHaveLength(1);
    expect(Object.fromEntries(made[0]!.body)).toEqual({
      UniqueName: 'hfos-call-transcripts',
      FriendlyName: 'HandsFreeOS call transcripts',
      AutoTranscribe: 'false',
      DataLogging: 'false',
      LanguageCode: 'en-US',
    });
    const asked = seen.find((x) => x.method === 'POST' && x.path === '/v2/Transcripts')!;
    expect(Object.fromEntries(asked.body)).toEqual({
      ServiceSid: 'GAservicetest',
      Channel: JSON.stringify({ media_properties: { source_sid: 'RErecordingtest' } }),
      CustomerKey: 'RErecordingtest',
    });

    expect(await t.fetchTranscription(account, 'GTwordstest')).toEqual({ status: 'pending' });
    sentencesAsked = 1;
    expect(await t.fetchTranscription(account, 'GTwordstest')).toEqual({
      status: 'completed',
      sentences: [
        { channel: 1, text: 'Hi, this is the office.' },
        { channel: 2, text: 'Yes, go ahead.' },
        { channel: 1, text: 'Thursday at one.' },
      ],
    });
    // A GT transcript lives in Conversational Intelligence, not the old voicemail transcriptions.
    await t.deleteTranscription(account, 'GTwordstest');
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/v2/Transcripts/GTwordstest' });
    expect(seen.every((x) => x.auth === 'ACsubtest:sub-token')).toBe(true);
  });

  it('reads a refusal from Conversational Intelligence as one', async () => {
    mockTwilio([
      [
        /^GET intelligence\.twilio\.com\/v2\/Services$/,
        () => ({ status: 403, json: { code: 20403, message: 'Forbidden' } }),
      ],
    ]);
    const t = createTwilioTelephony(MASTER);
    const err = await t.transcribeRecording(account, 'RErecordingtest').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ httpStatus: 403, permanent: false });
  });
});
