/**
 * The business email step's decisions (messaging/email-setup.ts): where a domain's mail and DNS are, the answers it
 * starts from (the owner's 2a: own domain first when there's one), what each screen needs, the records it shows (5a:
 * "Get email here too"), Home's card (7a), and where the step sits in the onboarding setup (1a, 3a).
 */
import { describe, expect, it } from 'vitest';
import {
  dnsHostFor,
  dnsHostOf,
  emailDomainPlanOf,
  emailSetupHomeOf,
  emailSetupLine,
  emailSetupOffersReceiving,
  emailSetupProblems,
  emailSetupReceives,
  emailSetupSenderAddress,
  emailSetupShownRecords,
  emailSetupTeamChoices,
  freeAddressLooksRandom,
  freeLocalPartFor,
  mailHostOf,
  NO_EMAIL_SETUP,
  onboardingSetupOwnerScreens,
  onboardingSetupScreenApplies,
  personLocalPartFor,
  startingEmailSetupAnswers,
  EmailSetupAnswers,
  type EmailSetupDomain,
  type EmailSetupState,
} from '../src';

const INBOUND = 'inbound.postmarkapp.com';
const ID = '00000000-0000-4000-8000-000000000001';
const ME = '00000000-0000-4000-8000-000000000002';

const domain = (over: Partial<EmailSetupDomain> = {}): EmailSetupDomain => ({
  id: ID,
  domain: 'bellassalon.com',
  status: 'pending',
  receiving: 'off',
  mailHost: 'none',
  dnsHost: 'godaddy',
  plan: { team: { localPart: 'hello', displayName: 'Bella’s Salon' } },
  records: [
    {
      type: 'TXT',
      purpose: 'Lets HandsFreeOS sign as you (DKIM)',
      host: '2026._domainkey',
      fullHost: '2026._domainkey.bellassalon.com',
      value: 'k=rsa; p=abc',
      found: true,
    },
    {
      type: 'CNAME',
      purpose: 'Bounces come back here',
      host: 'pm-bounces',
      fullHost: 'pm-bounces.bellassalon.com',
      value: 'pm.mtasv.net',
      found: false,
    },
  ],
  lastCheckedAt: null,
  lastError: null,
  ...over,
});

/** Bella’s Salon as onboarding made it: the free address with the random letters, a website, nothing else. */
const BELLA: EmailSetupState = {
  ...NO_EMAIL_SETUP,
  businessName: 'Bella’s Salon & Spa',
  websiteDomain: 'bellassalon.com',
  slug: 'bellas-salon',
  myEmail: 'maria@gmail.com',
  myFirstName: 'Maria José',
  sender: {
    address: 'bellas-salon-a2ceda@mail.handsfreeos.com',
    localPart: 'bellas-salon-a2ceda',
    domain: null,
    displayName: 'Bella’s Salon & Spa',
  },
  free: {
    id: ID,
    localPart: 'bellas-salon-a2ceda',
    address: 'bellas-salon-a2ceda@mail.handsfreeos.com',
    displayName: 'Bella’s Salon & Spa',
    isDefault: true,
  },
};

describe('where a domain’s mail and DNS are', () => {
  it('reads where mail goes from the MX records', () => {
    expect(mailHostOf([], INBOUND)).toBe('none');
    expect(mailHostOf(['inbound.postmarkapp.com.'], INBOUND)).toBe('handsfreeos');
    expect(mailHostOf(['ASPMX.L.GOOGLE.COM', 'alt1.aspmx.l.google.com'], INBOUND)).toBe('google');
    expect(mailHostOf(['bellassalon-com.mail.protection.outlook.com'], INBOUND)).toBe('microsoft');
    expect(mailHostOf(['smtp.secureserver.net'], INBOUND)).toBe('godaddy');
    expect(mailHostOf(['mx.zoho.com'], INBOUND)).toBe('zoho');
    expect(mailHostOf(['mx.fastmail.com'], INBOUND)).toBe('other');
  });

  it('reads where DNS is managed from the name servers, with that host’s steps', () => {
    expect(dnsHostOf(['ns51.domaincontrol.com', 'ns52.domaincontrol.com'])).toBe('godaddy');
    expect(dnsHostOf(['ada.ns.cloudflare.com.'])).toBe('cloudflare');
    expect(dnsHostOf(['ns-1.awsdns-01.org'])).toBe('route53');
    expect(dnsHostOf(['ns1.example-dns.net'])).toBe('other');
    expect(dnsHostOf(['ns1.dns-parking.com'])).toBe('hostinger');
    expect(dnsHostOf(['ns1.hostinger.co.uk'])).toBe('hostinger');
    // Whatever DNS answers, reading it stays quick.
    const long = `${'hostinger.'.repeat(5_000)}!`;
    const started = Date.now();
    dnsHostOf([long, `${'.'.repeat(50_000)}x`]);
    expect(mailHostOf([`a${'.'.repeat(50_000)}!`], INBOUND)).toBe('other');
    expect(Date.now() - started).toBeLessThan(500);
    expect(dnsHostOf([])).toBe('other');
    expect(dnsHostFor('godaddy')?.label).toBe('GoDaddy');
    expect(dnsHostFor('other')).toBeNull();
    expect(dnsHostFor(null)).toBeNull();
  });

  it('reads a stored plan forgivingly', () => {
    expect(emailDomainPlanOf(null)).toEqual({});
    expect(emailDomainPlanOf({ team: { localPart: '' } })).toEqual({});
    expect(emailDomainPlanOf({ receive: true })).toEqual({ receive: true });
  });
});

describe('the names it suggests', () => {
  it('makes the free address from the business’s name, without random letters', () => {
    expect(freeLocalPartFor('Bella’s Salon & Spa')).toBe('bellassalonandspa');
    expect(freeLocalPartFor('Café Olé')).toBe('cafeole');
    expect(freeLocalPartFor('!!!')).toBe('mybusiness');
  });

  it('makes a person’s address from their first name', () => {
    expect(personLocalPartFor('Maria José')).toBe('maria');
    expect(personLocalPartFor('Zoë')).toBe('zoe');
    expect(personLocalPartFor(null)).toBe('');
  });

  it('offers the person’s name among the team address’s chips', () => {
    expect(emailSetupTeamChoices({ myFirstName: 'Maria' })).toEqual([
      'hello',
      'info',
      'office',
      'bookings',
      'maria',
    ]);
    expect(emailSetupTeamChoices({ myFirstName: null })).toHaveLength(4);
  });

  it('knows the free address made with the business', () => {
    expect(freeAddressLooksRandom(BELLA)).toBe(true);
    expect(
      freeAddressLooksRandom({ ...BELLA, free: { ...BELLA.free!, localPart: 'bellassalon' } }),
    ).toBe(false);
  });
});

describe('the answers it starts from', () => {
  it('starts on the website’s domain when there is one (2a)', () => {
    const a = startingEmailSetupAnswers(BELLA);
    expect(a.with).toBe('domain');
    expect(a.domain).toBe('bellassalon.com');
    expect(a.local).toBe('hello');
    expect(a.freeLocal).toBe('bellassalonandspa');
    expect(a.name).toBe('Bella’s Salon & Spa');
    expect(a.mine).toBe(false);
    expect(a.mineLocal).toBe('maria');
  });

  it('starts on the free address with no website and a Gmail sign-in', () => {
    const a = startingEmailSetupAnswers({ ...BELLA, websiteDomain: null });
    expect(a.with).toBe('free');
    expect(a.domain).toBe('');
  });

  it('takes the domain of a sign-up email that isn’t Gmail and the like', () => {
    const a = startingEmailSetupAnswers({
      ...BELLA,
      websiteDomain: null,
      myEmail: 'maria@bellasalon.co',
    });
    expect(a).toMatchObject({ with: 'domain', domain: 'bellasalon.co' });
  });

  it('carries on a domain whose records are on their way, with its plan', () => {
    const a = startingEmailSetupAnswers({
      ...BELLA,
      domains: [
        domain({
          plan: {
            team: { localPart: 'office', displayName: 'Bella' },
            own: { localPart: 'mj', userId: ME },
            receive: false,
          },
        }),
      ],
    });
    expect(a).toMatchObject({
      with: 'domain',
      local: 'office',
      name: 'Bella',
      receive: false,
      mine: true,
      mineLocal: 'mj',
    });
  });

  it('keeps a cleaned-up free address as it is', () => {
    const a = startingEmailSetupAnswers({
      ...BELLA,
      websiteDomain: null,
      free: { ...BELLA.free!, localPart: 'bellas' },
    });
    expect(a.freeLocal).toBe('bellas');
  });
});

describe('what each screen needs', () => {
  const answers = (over: Partial<EmailSetupAnswers> = {}) =>
    EmailSetupAnswers.parse({ ...startingEmailSetupAnswers(BELLA), ...over });
  const paths = (part: 'sender' | 'own', a: EmailSetupAnswers) =>
    emailSetupProblems(part, a, BELLA).map((p) => p.path);

  it('needs a name, and a domain a business can send from', () => {
    expect(paths('sender', answers())).toEqual([]);
    expect(paths('sender', answers({ name: ' ' }))).toEqual(['email.name']);
    expect(paths('sender', answers({ domain: 'gmail.com' }))).toEqual(['email.domain']);
    expect(paths('sender', answers({ domain: 'not a domain' }))).toEqual(['email.domain']);
    expect(paths('sender', answers({ local: 'two words' }))).toEqual(['email.local']);
  });

  it('keeps HandsFreeOS’s own names off the free address', () => {
    expect(paths('sender', answers({ with: 'free', freeLocal: 'support' }))).toEqual([
      'email.freeLocal',
    ]);
    expect(paths('sender', answers({ with: 'free', domain: 'gmail.com' }))).toEqual([]);
  });

  it('never makes the person’s own address the team’s (3a)', () => {
    expect(paths('own', answers({ mine: true, mineLocal: 'maria' }))).toEqual([]);
    expect(paths('own', answers({ mine: true, mineLocal: 'hello' }))).toEqual(['email.mineLocal']);
    expect(paths('own', answers({ mine: false, mineLocal: 'hello' }))).toEqual([]);
  });
});

describe('the records it shows', () => {
  it('adds the MX record while Get email here too is on, for a domain with no email yet (5a)', () => {
    const d = domain();
    expect(emailSetupOffersReceiving(d)).toBe(true);
    expect(emailSetupReceives(d, { receive: null })).toBe(true);
    const shown = emailSetupShownRecords(d, INBOUND, true);
    expect(shown.map((r) => r.type)).toEqual(['TXT', 'CNAME', 'MX']);
    expect(shown[2]).toMatchObject({ value: INBOUND, priority: 10, found: false });
    expect(emailSetupShownRecords(d, INBOUND, false)).toHaveLength(2);
  });

  it('never offers it for a domain whose mail goes elsewhere', () => {
    const d = domain({ mailHost: 'google' });
    expect(emailSetupOffersReceiving(d)).toBe(false);
    expect(emailSetupReceives(d, { receive: true })).toBe(false);
  });

  it('follows what was picked, then the plan', () => {
    expect(emailSetupReceives(domain(), { receive: false })).toBe(false);
    expect(emailSetupReceives(domain({ plan: { receive: false } }), { receive: null })).toBe(false);
    expect(emailSetupReceives(domain({ receiving: 'on' }), { receive: false })).toBe(true);
  });

  it('says where emails go out from, and when', () => {
    const a = startingEmailSetupAnswers(BELLA);
    expect(emailSetupSenderAddress(a, BELLA)).toBe('hello@bellassalon.com');
    expect(emailSetupLine(a, { ...BELLA, domains: [domain()] })).toMatch(/once its records/);
    expect(emailSetupLine(a, { ...BELLA, domains: [domain({ status: 'verified' })] })).toBe(
      'Emails go out from hello@bellassalon.com',
    );
  });
});

describe('Home’s card (7a)', () => {
  it('asks a business still on the address it was made with', () => {
    expect(emailSetupHomeOf(BELLA)).toEqual({
      kind: 'start',
      address: 'bellas-salon-a2ceda@mail.handsfreeos.com',
    });
  });

  it('says how far the records are while they’re on their way, not counting the MX', () => {
    expect(emailSetupHomeOf({ ...BELLA, domains: [domain()] })).toEqual({
      kind: 'records',
      domain: 'bellassalon.com',
      host: 'GoDaddy',
      found: 1,
      of: 2,
      from: 'bellas-salon-a2ceda@mail.handsfreeos.com',
      to: 'hello@bellassalon.com',
    });
  });

  it('stays away once it’s set up, and from anyone who can’t change it', () => {
    expect(emailSetupHomeOf({ ...BELLA, canManage: false })).toBeNull();
    expect(
      emailSetupHomeOf({
        ...BELLA,
        sender: { ...BELLA.sender!, address: 'bellas@mail.handsfreeos.com', localPart: 'bellas' },
        free: { ...BELLA.free!, localPart: 'bellas' },
      }),
    ).toBeNull();
    expect(
      emailSetupHomeOf({
        ...BELLA,
        sender: { ...BELLA.sender!, address: 'hello@bellassalon.com', domain: 'bellassalon.com' },
      }),
    ).toBeNull();
  });
});

describe('in the onboarding setup', () => {
  it('shows the records only for the own domain (1a)', () => {
    const at = (w: 'domain' | 'free' | null) =>
      onboardingSetupScreenApplies(
        'email_records',
        { booksTime: true, payWith: 'later', email: { with: w } } as never,
        {} as never,
      );
    expect(at('domain')).toBe(true);
    expect(at('free')).toBe(false);
    expect(at(null)).toBe(false);
  });

  it('leaves the owner their own address when someone else set the domain up', () => {
    const a = { ...startingEmailSetupAnswers(BELLA), with: 'domain' as const };
    const screens = (mine: EmailSetupState['mine']) =>
      onboardingSetupOwnerScreens({ booksTime: false, payWith: 'later', email: a }, {
        booking: { on: true, site: null },
        payments: {
          active: false,
          checking: false,
          needsInfo: false,
          broken: false,
          provider: null,
        },
        email: { ...BELLA, mine },
      } as never);
    expect(screens(null)[0]).toBe('email_own');
    expect(screens({ address: 'maria@bellassalon.com' })).not.toContain('email_own');
  });
});
