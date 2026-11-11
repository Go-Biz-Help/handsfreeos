/**
 * The business email step: onboarding's "Your business email" stop, and Home's "Set up your business email" for a
 * business that finished setting up before the step existed. Which address booking emails, reminders, invoices and
 * the AI teammate's emails go out from (a team address on the business's own domain, or a free one on the shared
 * subdomain), the records to add where the domain is managed, with steps for that place, and an address just for the
 * person setting it up. Browser-safe: the web, the phone and the commands all work from these.
 *
 * Rules the owner set (2026-11-10, picks 1a–7a):
 * - The default sender is always a team address. An address just for one person ("Only me") is never the sender
 *   for booking emails or the AI teammate's.
 * - Until a domain's records check out, mail goes from the free address. Then the team address on the domain is
 *   made and becomes the default on its own (`plan.team`), and the owners hear about it.
 * - The free address drops the random letters the business was made with: `riveralawncare@`, not
 *   `rivera-lawn-care-a2ceda@`.
 * - A domain that gets no email yet is offered "Get email here too" (its mail comes to the Inbox), switched on.
 */
import { z } from 'zod';
import {
  emailDomainName,
  emailDomainStatus,
  emailLocalPart,
  emailReceivingStatus,
  isConsumerMailDomain,
  isHandsFreeOsDomain,
  isReservedLocalPart,
  mailboxProvider,
  mailboxStatus,
  normalizeEmailDomain,
} from '../schemas/email';

// ---------- the answers ----------

/** "Which address should customers see?" */
export const EMAIL_SETUP_WITH = ['domain', 'free'] as const;
export type EmailSetupWith = (typeof EMAIL_SETUP_WITH)[number];

/** The step's three screens, each saved on its own Next. */
export const EMAIL_SETUP_PARTS = ['sender', 'records', 'own'] as const;
export type EmailSetupPart = (typeof EMAIL_SETUP_PARTS)[number];

/**
 * The step's answers, as typed. Loose on purpose: they're kept with the setup's other answers while someone is part
 * way through, and read forgivingly, so each screen checks its own (`emailSetupProblems`) before Next.
 */
export const EmailSetupAnswers = z.object({
  /** Own domain or the free address; null until anything was picked, so the business's own picks fill it in. */
  with: z.enum(EMAIL_SETUP_WITH).nullable().default(null),
  /** "Your domain", as typed: "bellassalon.com". */
  domain: z.string().max(300).default(''),
  /** The team address's name on the domain: "hello". */
  local: z.string().max(300).default('hello'),
  /** The free address's name on the shared subdomain: "bellassalon". */
  freeLocal: z.string().max(300).default(''),
  /** "Name customers see". */
  name: z.string().max(300).default(''),
  /** "Get email at <domain> here too"; null leaves it to where the domain's mail goes now. */
  receive: z.boolean().nullable().default(null),
  /** "Do you want an address just for you?" */
  mine: z.boolean().default(false),
  /** That address's name: "maria". */
  mineLocal: z.string().max(300).default(''),
});
export type EmailSetupAnswers = z.infer<typeof EmailSetupAnswers>;
export type EmailSetupAnswersInput = z.input<typeof EmailSetupAnswers>;

/**
 * What a domain does once its records check out, kept on the domain (`email_domains.plan`): make the team address
 * and the default, make the person's own address, and receive its mail. Cleared once it's done.
 */
export const EmailDomainPlan = z.object({
  team: z
    .object({ localPart: z.string().min(1).max(64), displayName: z.string().min(1).max(120) })
    .optional(),
  own: z.object({ localPart: z.string().min(1).max(64), userId: z.uuid() }).optional(),
  receive: z.boolean().optional(),
});
export type EmailDomainPlan = z.infer<typeof EmailDomainPlan>;

/** A domain's plan as stored, read forgivingly: anything that no longer parses counts as none. */
export const emailDomainPlanOf = (raw: unknown): EmailDomainPlan => {
  const r = EmailDomainPlan.safeParse(raw ?? {});
  return r.success ? r.data : {};
};

// ---------- where a domain's mail and DNS are ----------

/** Where a domain's mail goes now, from its MX records: none, here already, or a mail service. */
export const MAIL_HOSTS = [
  'none',
  'handsfreeos',
  'google',
  'microsoft',
  'godaddy',
  'zoho',
  'other',
] as const;
export type MailHost = (typeof MAIL_HOSTS)[number];

export const MAIL_HOST_LABELS: Readonly<Record<MailHost, string>> = {
  none: 'nowhere yet',
  handsfreeos: 'HandsFreeOS',
  google: 'Google Workspace (Gmail)',
  microsoft: 'Microsoft 365 (Outlook)',
  godaddy: 'GoDaddy email',
  zoho: 'Zoho Mail',
  other: 'another mail service',
};

/** A host name as DNS gives it, lower case without its trailing dot. Never longer than a host name can be (253). */
const host = (h: string) => {
  let out = h.trim().toLowerCase().slice(0, 254);
  while (out.endsWith('.')) out = out.slice(0, -1);
  return out;
};

/**
 * Where mail to the domain goes, from the names its MX records point at ([] for none). A "null MX" (one record
 * naming ".", the domain saying it takes no mail) is none too.
 */
export function mailHostOf(exchanges: readonly string[], inboundMxHost: string): MailHost {
  const all = exchanges.map(host).filter(Boolean);
  if (!all.length) return 'none';
  if (all.some((h) => h === host(inboundMxHost))) return 'handsfreeos';
  if (all.some((h) => /(^|\.)(google|googlemail)\.com$/.test(h))) return 'google';
  if (all.some((h) => /\.outlook\.com$/.test(h))) return 'microsoft';
  if (all.some((h) => /(^|\.)secureserver\.net$/.test(h))) return 'godaddy';
  if (all.some((h) => /(^|\.)zoho(mail)?\.(com|eu|in|com\.au)$/.test(h))) return 'zoho';
  return 'other';
}

/** A place a domain's DNS is managed, with where its records go there. */
export interface DnsHost {
  readonly key: string;
  readonly label: string;
  /** Matches the domain's name servers. */
  readonly ns: RegExp;
  /** Where its domains are listed once signed in. */
  readonly url: string;
  /** Where the records go, after the domain: "DNS". */
  readonly where: string;
  /** The button that adds one. */
  readonly add: string;
  /** Anything that trips people up there. */
  readonly note?: string;
}

/** The places most small businesses' domains are managed, by their name servers. */
export const DNS_HOSTS: readonly DnsHost[] = [
  {
    key: 'godaddy',
    label: 'GoDaddy',
    ns: /(^|\.)domaincontrol\.com$/,
    url: 'https://dcc.godaddy.com/domains',
    where: 'DNS',
    add: 'Add New Record',
  },
  {
    key: 'cloudflare',
    label: 'Cloudflare',
    ns: /(^|\.)ns\.cloudflare\.com$/,
    url: 'https://dash.cloudflare.com/',
    where: 'DNS → Records',
    add: 'Add record',
    note: 'Set the CNAME record to DNS only (the grey cloud), not Proxied.',
  },
  {
    key: 'namecheap',
    label: 'Namecheap',
    ns: /(^|\.)registrar-servers\.com$/,
    url: 'https://ap.www.namecheap.com/domains/list/',
    where: 'Manage → Advanced DNS',
    add: 'Add New Record',
  },
  {
    key: 'squarespace',
    label: 'Squarespace',
    ns: /(^|\.)(squarespacedns\.com|googledomains\.com)$/,
    url: 'https://account.squarespace.com/domains',
    where: 'DNS → DNS Settings',
    add: 'Add record',
  },
  {
    key: 'wix',
    label: 'Wix',
    ns: /(^|\.)wixdns\.net$/,
    url: 'https://manage.wix.com/account/domains',
    where: 'Manage DNS Records',
    add: 'Add Record',
  },
  {
    key: 'ionos',
    label: 'IONOS',
    ns: /(^|\.)ui-dns\.(com|de|org|biz)$/,
    url: 'https://my.ionos.com/domains',
    where: 'DNS',
    add: 'Add record',
  },
  {
    key: 'hostinger',
    label: 'Hostinger',
    ns: /(^|\.)(dns-parking\.com|hostinger\.[a-z]{2,6}(\.[a-z]{2})?)$/,
    url: 'https://hpanel.hostinger.com/domains',
    where: 'DNS / Nameservers',
    add: 'Add Record',
  },
  {
    key: 'bluehost',
    label: 'Bluehost',
    ns: /(^|\.)bluehost\.com$/,
    url: 'https://my.bluehost.com/',
    where: 'Domains → DNS',
    add: 'Add Record',
  },
  {
    key: 'hostgator',
    label: 'HostGator',
    ns: /(^|\.)hostgator\.com$/,
    url: 'https://portal.hostgator.com/',
    where: 'Domains → DNS',
    add: 'Add DNS Record',
  },
  {
    key: 'networksolutions',
    label: 'Network Solutions',
    ns: /(^|\.)worldnic\.com$/,
    url: 'https://www.networksolutions.com/my-account/domain-center',
    where: 'Advanced Tools → Advanced DNS Records',
    add: 'Add Record',
  },
  {
    key: 'namecom',
    label: 'Name.com',
    ns: /(^|\.)name\.com$/,
    url: 'https://www.name.com/account/domain',
    where: 'Manage DNS Records',
    add: 'Add Record',
  },
  {
    key: 'porkbun',
    label: 'Porkbun',
    ns: /(^|\.)porkbun\.com$/,
    url: 'https://porkbun.com/account/domainsSpeedy',
    where: 'DNS',
    add: 'Add',
  },
  {
    key: 'route53',
    label: 'Amazon Route 53',
    ns: /(^|\.)awsdns-\d+\.(com|net|org|co\.uk)$/,
    url: 'https://console.aws.amazon.com/route53/v2/hostedzones',
    where: 'Hosted zones',
    add: 'Create record',
  },
  {
    key: 'wordpress',
    label: 'WordPress.com',
    ns: /(^|\.)wordpress\.com$/,
    url: 'https://wordpress.com/domains/manage',
    where: 'DNS records',
    add: 'Add a record',
  },
  {
    key: 'dreamhost',
    label: 'DreamHost',
    ns: /(^|\.)dreamhost\.com$/,
    url: 'https://panel.dreamhost.com/',
    where: 'Websites → DNS',
    add: 'Add Record',
  },
  {
    key: 'siteground',
    label: 'SiteGround',
    ns: /(^|\.)siteground\.net$/,
    url: 'https://my.siteground.com/',
    where: 'Domain → DNS Zone Editor',
    add: 'Create',
  },
  {
    key: 'hover',
    label: 'Hover',
    ns: /(^|\.)hover\.com$/,
    url: 'https://www.hover.com/control_panel',
    where: 'DNS',
    add: 'Add a record',
  },
  {
    key: 'gandi',
    label: 'Gandi',
    ns: /(^|\.)gandi\.net$/,
    url: 'https://admin.gandi.net/domain',
    where: 'DNS Records',
    add: 'Add record',
  },
  {
    key: 'digitalocean',
    label: 'DigitalOcean',
    ns: /(^|\.)digitalocean\.com$/,
    url: 'https://cloud.digitalocean.com/networking/domains',
    where: 'Domains',
    add: 'Create Record',
  },
  {
    key: 'vercel',
    label: 'Vercel',
    ns: /(^|\.)vercel-dns\.com$/,
    url: 'https://vercel.com/dashboard/domains',
    where: 'DNS Records',
    add: 'Add',
  },
];

/** The place a domain's DNS is managed, from its name servers: a key of `DNS_HOSTS`, or "other". */
export function dnsHostOf(nameServers: readonly string[]): string {
  const all = nameServers.map(host).filter(Boolean);
  return DNS_HOSTS.find((h) => all.some((n) => h.ns.test(n)))?.key ?? 'other';
}

export const dnsHostFor = (key: string | null | undefined): DnsHost | null =>
  DNS_HOSTS.find((h) => h.key === key) ?? null;

// ---------- what the step starts from ----------

const iso = z.iso.datetime();

export const EmailSetupRecordOut = z.object({
  type: z.enum(['TXT', 'CNAME', 'MX']),
  purpose: z.string(),
  host: z.string(),
  fullHost: z.string(),
  value: z.string(),
  priority: z.int().optional(),
  found: z.boolean(),
});

export const EmailSetupDomainOut = z.object({
  id: z.uuid(),
  domain: z.string(),
  status: emailDomainStatus,
  receiving: emailReceivingStatus,
  /** Where its mail goes now (`MAIL_HOSTS`); null until the worker has looked. */
  mailHost: z.enum(MAIL_HOSTS).nullable(),
  /** Where its DNS is managed (`DNS_HOSTS`, or "other"); null until the worker has looked. */
  dnsHost: z.string().nullable(),
  plan: EmailDomainPlan,
  /** The records to add, in order; empty while they're being made. */
  records: z.array(EmailSetupRecordOut),
  lastCheckedAt: iso.nullable(),
  lastError: z.string().nullable(),
});
export type EmailSetupDomain = z.infer<typeof EmailSetupDomainOut>;

/** What the step starts from: the business's addresses and domains as they are, and who's setting it up. */
export const EmailSetupStateOut = z.object({
  /** The shared subdomain: "mail.handsfreeos.com". */
  sharedDomain: z.string(),
  inboundMxHost: z.string(),
  businessName: z.string(),
  /** The business's website's domain, when it has one. */
  websiteDomain: z.string().nullable(),
  /** The business's own name in addresses, as it was made: a random-looking free address starts with it. */
  slug: z.string(),
  /** The person setting it up: their sign-in email and first name. */
  myEmail: z.string().nullable(),
  myFirstName: z.string().nullable(),
  /** Where booking emails go out from now: the default address. */
  sender: z
    .object({
      address: z.string(),
      localPart: z.string(),
      domain: z.string().nullable(),
      displayName: z.string(),
    })
    .nullable(),
  /** The business's address on the shared subdomain: the default one, else the first. */
  free: z
    .object({
      id: z.uuid(),
      localPart: z.string(),
      address: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
    })
    .nullable(),
  domains: z.array(EmailSetupDomainOut),
  /** This person's own address ("Only you"), when they have one. */
  mine: z.object({ address: z.string() }).nullable(),
  /** Gmail and Outlook mailboxes connected here, and whether each is this person's. */
  mailboxes: z.array(
    z.object({
      provider: mailboxProvider,
      accountEmail: z.string().nullable(),
      status: mailboxStatus,
      mine: z.boolean(),
    }),
  ),
  /** This person can change the business's email (`channels.manage`). */
  canManage: z.boolean(),
});
export type EmailSetupState = z.infer<typeof EmailSetupStateOut>;

/** A record as the step shows it. */
export type EmailSetupRecord = z.infer<typeof EmailSetupRecordOut>;

/**
 * A domain's records as the step shows them: Settings → Email's, with the MX record while "Get email here too" is
 * on and receiving hasn't started yet. Found once the domain's mail already points here.
 */
export function emailSetupShownRecords(
  d: Pick<EmailSetupDomain, 'domain' | 'records' | 'receiving' | 'mailHost'>,
  inboundMxHost: string,
  receive: boolean,
): EmailSetupRecord[] {
  if (d.receiving !== 'off' || !receive || !d.records.length) return d.records;
  return [
    ...d.records,
    {
      type: 'MX',
      purpose: 'Brings your mail here (priority 10)',
      host: '@',
      fullHost: d.domain,
      value: inboundMxHost,
      priority: 10,
      found: d.mailHost === 'handsfreeos',
    },
  ];
}

/** The free address's name from the business's: "Bella’s Salon & Spa" → "bellassalonandspa". */
export function freeLocalPartFor(businessName: string): string {
  const base = businessName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
  if (!base) return 'mybusiness';
  return isReservedLocalPart(base) ? `${base}team` : base;
}

/** The address's name for a person: "Maria José" → "maria". */
export const personLocalPartFor = (firstName: string | null | undefined): string =>
  (firstName ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)[0]!
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);

/** The free address still has the random letters it was made with: `bellas-salon-a2ceda`. */
export const freeAddressLooksRandom = (state: Pick<EmailSetupState, 'free' | 'slug'>): boolean =>
  !!state.free &&
  !!state.slug &&
  (state.free.localPart === state.slug || state.free.localPart.startsWith(`${state.slug}-`));

/** The team address's name, as chips under the box. */
export const emailSetupTeamChoices = (state: Pick<EmailSetupState, 'myFirstName'>): string[] => {
  const me = personLocalPartFor(state.myFirstName);
  return [...new Set(['hello', 'info', 'office', 'bookings', ...(me ? [me] : [])])];
};

/** The domain the business most likely owns: its website's, else its sign-in email's when that isn't Gmail and the like. */
export function emailSetupSuggestedDomain(
  state: Pick<EmailSetupState, 'websiteDomain' | 'myEmail'>,
): string | null {
  if (state.websiteDomain) return state.websiteDomain;
  const at = state.myEmail?.split('@')[1]?.toLowerCase();
  if (!at || isConsumerMailDomain(at) || isHandsFreeOsDomain(at)) return null;
  return at;
}

/** Where the suggested domain came from, for the note under the box. */
export function emailSetupDomainSource(
  state: Pick<EmailSetupState, 'websiteDomain' | 'myEmail'>,
  domain: string,
): 'website' | 'email' | null {
  const d = normalizeEmailDomain(domain);
  if (state.websiteDomain && d === state.websiteDomain) return 'website';
  if (state.myEmail?.split('@')[1]?.toLowerCase() === d) return 'email';
  return null;
}

/** The domain being set up: one whose records are on their way, else the one the default address is on. */
export const emailSetupPendingDomain = (
  state: Pick<EmailSetupState, 'domains'>,
): EmailSetupDomain | null =>
  state.domains.find((d) => d.status !== 'verified' && d.plan.team) ?? null;

/** The answers before anyone answers: how the business's email is set up now, else our picks (2a: own domain first when it has one). */
export function startingEmailSetupAnswers(state: EmailSetupState): EmailSetupAnswers {
  const freeLocal =
    state.free && !freeAddressLooksRandom(state)
      ? state.free.localPart
      : freeLocalPartFor(state.businessName);
  const name = (state.sender?.displayName || state.businessName).trim().slice(0, 120);
  const me = personLocalPartFor(state.myFirstName);
  const mineLocal = state.mine?.address.split('@')[0] ?? me;
  const pending = emailSetupPendingDomain(state);
  if (pending?.plan.team)
    return EmailSetupAnswers.parse({
      with: 'domain',
      domain: pending.domain,
      local: pending.plan.team.localPart,
      freeLocal,
      name: pending.plan.team.displayName,
      receive: pending.plan.receive ?? null,
      mine: !!pending.plan.own || !!state.mine,
      mineLocal: pending.plan.own?.localPart ?? mineLocal,
    });
  if (state.sender?.domain)
    return EmailSetupAnswers.parse({
      with: 'domain',
      domain: state.sender.domain,
      local: state.sender.localPart,
      freeLocal,
      name,
      mine: !!state.mine,
      mineLocal,
    });
  const suggested = emailSetupSuggestedDomain(state);
  return EmailSetupAnswers.parse({
    with: suggested ? 'domain' : 'free',
    domain: suggested ?? '',
    local: 'hello',
    freeLocal,
    name,
    mine: false,
    mineLocal,
  });
}

/** The answers kept, over our picks where nothing was ever picked. */
export const emailSetupAnswersOver = (
  kept: EmailSetupAnswers,
  starting: EmailSetupAnswers,
): EmailSetupAnswers => (kept.with ? kept : starting);

/** The domain the answers name, as the business has it. */
export const emailSetupDomainOf = (
  state: Pick<EmailSetupState, 'domains'>,
  answers: Pick<EmailSetupAnswers, 'domain'>,
): EmailSetupDomain | null => {
  const d = normalizeEmailDomain(answers.domain);
  return state.domains.find((x) => x.domain === d) ?? null;
};

/**
 * Whether the domain's mail will come here: as picked, else as planned, else when nobody gets email there yet (5a:
 * offered, switched on). A domain whose mail goes elsewhere never is, unless picked in Settings → Email.
 */
export function emailSetupReceives(
  d: Pick<EmailSetupDomain, 'mailHost' | 'plan' | 'receiving'> | null,
  answers: Pick<EmailSetupAnswers, 'receive'>,
): boolean {
  if (!d) return false;
  if (d.receiving !== 'off') return true;
  if (!emailSetupOffersReceiving(d)) return false;
  return answers.receive ?? d.plan.receive ?? true;
}

/** "Get email here too" is offered: nobody gets email at the domain yet (or it already comes here). */
export const emailSetupOffersReceiving = (
  d: Pick<EmailSetupDomain, 'mailHost' | 'receiving'>,
): boolean => d.receiving !== 'off' || d.mailHost === 'none' || d.mailHost === 'handsfreeos';

// ---------- what each screen needs ----------

export interface EmailSetupProblem {
  /** Into the answers: "email.domain". */
  readonly path: string;
  readonly message: string;
}

/** What a screen still needs before Next. */
export function emailSetupProblems(
  part: EmailSetupPart,
  answers: EmailSetupAnswers,
  state: Pick<EmailSetupState, 'sharedDomain' | 'domains' | 'mine'>,
): EmailSetupProblem[] {
  const out: EmailSetupProblem[] = [];
  const local = (path: string, value: string, reserved: boolean) => {
    const r = emailLocalPart.safeParse(value);
    if (!r.success) out.push({ path, message: r.error.issues[0]!.message });
    else if (reserved && isReservedLocalPart(r.data))
      out.push({
        path,
        message: `“${r.data}” is kept for HandsFreeOS itself on ${state.sharedDomain}. Pick another name.`,
      });
  };
  if (part === 'sender') {
    if (!answers.name.trim()) out.push({ path: 'email.name', message: W.nameMissing });
    else if (answers.name.trim().length > 120)
      out.push({ path: 'email.name', message: 'Keep it under 120 characters.' });
    if (answers.with === 'free') local('email.freeLocal', answers.freeLocal, true);
    else {
      const r = emailDomainName.safeParse(answers.domain);
      if (!r.success) out.push({ path: 'email.domain', message: r.error.issues[0]!.message });
      else if (isConsumerMailDomain(r.data))
        out.push({ path: 'email.domain', message: W.consumerDomain(r.data) });
      else if (isHandsFreeOsDomain(r.data))
        out.push({
          path: 'email.domain',
          message: 'That domain is HandsFreeOS’s own. Use a domain your business owns.',
        });
      local('email.local', answers.local, false);
    }
  }
  if (part === 'own' && answers.mine && !state.mine) {
    local('email.mineLocal', answers.mineLocal, false);
    if (answers.mineLocal.trim().toLowerCase() === answers.local.trim().toLowerCase())
      out.push({ path: 'email.mineLocal', message: W.mineSameAsTeam(answers.local.trim()) });
  }
  return out;
}

/** The address booking emails will go out from once everything's in. */
export function emailSetupSenderAddress(
  answers: EmailSetupAnswers,
  state: Pick<EmailSetupState, 'sharedDomain'>,
): string {
  return answers.with === 'domain'
    ? `${answers.local.trim().toLowerCase()}@${normalizeEmailDomain(answers.domain)}`
    : `${answers.freeLocal.trim().toLowerCase()}@${state.sharedDomain}`;
}

/** The free address mail goes from until the domain's records are in. */
export const emailSetupFreeAddress = (
  answers: EmailSetupAnswers,
  state: Pick<EmailSetupState, 'sharedDomain'>,
): string => `${answers.freeLocal.trim().toLowerCase()}@${state.sharedDomain}`;

/** The summary's line: "Emails go out from hello@bellassalon.com". */
export function emailSetupLine(
  answers: EmailSetupAnswers,
  state: Pick<EmailSetupState, 'sharedDomain' | 'domains'>,
): string {
  const address = emailSetupSenderAddress(answers, state);
  if (answers.with !== 'domain') return `Emails go out from ${address}`;
  const d = emailSetupDomainOf(state, answers);
  return d?.status === 'verified'
    ? `Emails go out from ${address}`
    : `Emails go out from ${address} once its records are in`;
}

/** The records found so far, not counting the MX record (sending works without it). */
export function emailSetupSendingFound(d: Pick<EmailSetupDomain, 'records'>): {
  readonly found: number;
  readonly of: number;
} {
  const sending = d.records.filter((r) => r.type !== 'MX');
  return { found: sending.filter((r) => r.found).length, of: sending.length };
}

// ---------- Home's card (7a) ----------

export type EmailSetupHome =
  | { readonly kind: 'start'; readonly address: string }
  | {
      readonly kind: 'records';
      readonly domain: string;
      readonly host: string | null;
      readonly found: number;
      readonly of: number;
      readonly from: string;
      readonly to: string;
    };

/**
 * Home's card: "Set up your business email" for a business still sending from the address it was made with, or
 * "Finish your email records" while a domain's records are on their way. Only for someone who can change it.
 */
export function emailSetupHomeOf(state: EmailSetupState): EmailSetupHome | null {
  if (!state.canManage) return null;
  const pending = emailSetupPendingDomain(state);
  if (pending?.plan.team) {
    const { found, of } = emailSetupSendingFound(pending);
    return {
      kind: 'records',
      domain: pending.domain,
      host: dnsHostFor(pending.dnsHost)?.label ?? null,
      found,
      of: of || 3,
      from: state.sender?.address ?? '',
      to: `${pending.plan.team.localPart}@${pending.domain}`,
    };
  }
  if (state.sender && !state.sender.domain && freeAddressLooksRandom(state))
    return { kind: 'start', address: state.sender.address };
  return null;
}

// ---------- words ----------

export const EMAIL_SETUP_WORDS = {
  stop: 'Your business email',
  senderTitle: 'Your business email',
  senderHint:
    'Booking confirmations, reminders, invoices and Ava’s emails go out from it. Customers’ replies come back to your Inbox.',
  which: 'Which address should customers see?',
  ownDomain: 'My own domain',
  best: 'Best',
  ownDomainHint:
    'Most trusted, so fewer emails land in spam. You add a few records where your domain is managed.',
  free: 'A free HandsFreeOS address',
  freeHint: 'Works right now.',
  domainLabel: 'Your domain',
  domainFromWebsite: 'From your website.',
  domainFromEmail: 'From the email you signed up with.',
  addressLabel: 'The address',
  teamReads: 'Your team reads it, in the Inbox.',
  teamReadsNext: 'An address just for you comes next.',
  freeLabel: 'Your free address',
  whyNotGmail:
    'Why not your Gmail? Gmail won’t let another app send as a Gmail address, so emails from it would land in spam. You can still bring your Gmail in on the next screen.',
  nameLabel: 'Name customers see',
  nameMissing: 'Enter the name customers see, like your business’s name.',
  consumerDomain: (d: string) =>
    `${d} is a public email service, so it can’t send for your business. Use a domain your business owns, or pick A free HandsFreeOS address.`,
  recordsTitle: (n: number, host: string | null) =>
    host ? `Add ${n} records at ${host}` : `Add ${n} records to your domain`,
  recordsHint: (domain: string, host: string | null) =>
    host
      ? `${domain} is managed at ${host}. These let HandsFreeOS send as it.`
      : `Add these where ${domain}’s DNS is managed, usually where you bought it. They let HandsFreeOS send as it.`,
  recordsScreenTitle: 'Add your domain’s records',
  recordsScreenHint:
    'They let HandsFreeOS send email as your domain, so it lands in inboxes, not spam.',
  recordsMaking: 'Making your records. This takes a few seconds.',
  receiveLabel: (domain: string) => `Get email at ${domain} here too`,
  receiveHint: 'Nobody gets email there today, so nothing is moved.',
  receiveHere: 'Its mail already comes here.',
  mailElsewhere: (domain: string, where: string) =>
    `Email to ${domain} goes to ${where} today, and it stays there. Bring that mailbox in on the next screen.`,
  stepsAt: (domain: string, host: string, where: string, add: string) =>
    `In ${host}, open ${domain} → ${where}, press ${add} for each one, then come back.`,
  stepsAnywhere: (domain: string) =>
    `Sign in where ${domain} is managed, open its DNS settings, add each one, then come back.`,
  openHost: (host: string) => `Open ${host}`,
  found: 'Found',
  waiting: 'Waiting',
  copy: 'Copy',
  copied: 'Copied',
  checkNow: 'Check now',
  foundOf: (found: number, of: number) => `${found} of ${of} found`,
  until: (free: string, own: string) =>
    `Until they’re found, emails go out from ${free}, then switch to ${own} on their own. You’ll get an email when they do.`,
  verified: (own: string) => `All found. Emails go out from ${own}.`,
  someoneElse: 'Someone else looks after your domain?',
  sendSteps: 'Send the steps',
  sendTo: 'Their email',
  sentTo: (to: string) => `Sent to ${to}.`,
  emailMe: 'Email me the steps',
  sendToSomeone: 'Send to someone',
  easierOnComputer:
    'Easier on a computer. Email yourself these steps, or send them to whoever looks after your domain.',
  goesTo: (to: string) => `Goes to ${to}`,
  later: 'Not done yet? Carry on, and finish it later from Home.',
  ownTitle: 'Your own email',
  ownHint: 'Both are optional, and both can wait for Settings → Email.',
  mineQuestion: 'Do you want an address just for you?',
  mineNo: (local: string) => `No, ${local}@ is enough`,
  mineYes: 'Yes, an address only I read',
  mineLabel: 'Your address',
  mineNote:
    'Only you read it, marked with a lock in your Inbox. Booking emails, reminders and Ava never send from it.',
  mineHave: (address: string) => `You have ${address}, only you read it.`,
  mineSameAsTeam: (local: string) =>
    `${local}@ is your team’s address. Pick another name for yours, like your first name.`,
  bringIn: 'Bring in the email you already use',
  bringInHint: (email: string | null) =>
    email
      ? `Connect ${email} and your emails with customers show in your Inbox and on their timeline. Other mail stays private.`
      : 'Connect it and your emails with customers show in your Inbox and on their timeline. Other mail stays private.',
  connectGmail: 'Connect Gmail',
  gmailSoon: 'Connect Gmail · coming soon',
  connectOutlook: 'Connect Outlook',
  connected: (email: string) => `${email} is connected.`,
  keepsGoing: (address: string) => `Booking emails keep going from ${address} either way.`,
  homeStartTitle: 'Set up your business email',
  homeStartBody: (address: string) =>
    `Booking emails and reminders go out from ${address}. Pick an address your customers will know: your own domain, or a cleaner free one. About 2 minutes, or 10 with your own domain.`,
  homeStart: 'Set it up',
  notNow: 'Not now',
  homeRecordsTitle: 'Finish your email records',
  homeRecordsBody: (found: number, of: number, host: string | null, from: string, to: string) =>
    `${found} of ${of} found${host ? ` at ${host}` : ''}. Emails go out from ${from} until the rest are in, then switch to ${to} on their own.`,
  homeRecords: 'Open the steps',
  done: 'Done',
  notAllowed:
    'Only people who manage this business’s email can set it up. Ask an owner of this business.',
} as const;
const W = EMAIL_SETUP_WORDS;

/** A business with only the free address it was made with, for previews and tests. */
export const NO_EMAIL_SETUP: EmailSetupState = {
  sharedDomain: 'mail.handsfreeos.com',
  inboundMxHost: 'inbound.postmarkapp.com',
  businessName: '',
  websiteDomain: null,
  slug: '',
  myEmail: null,
  myFirstName: null,
  sender: null,
  free: null,
  domains: [],
  mine: null,
  mailboxes: [],
  canManage: true,
};
