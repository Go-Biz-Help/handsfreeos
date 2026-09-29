import { z } from 'zod';
import { displayName, email, isoDateTime, uuid } from './common';
import { ListInput, UserRef } from './crm';

/** Mirrors private.email_local_part_reserved: names that would read as HandsFreeOS itself on the shared subdomain. */
export const RESERVED_LOCAL_PARTS: readonly string[] = [
  'abuse',
  'admin',
  'administrator',
  'alerts',
  'billing',
  'bounce',
  'bounces',
  'hello',
  'help',
  'hostmaster',
  'inbound',
  'info',
  'mail',
  'mailer-daemon',
  'no-reply',
  'noreply',
  'postmaster',
  'replies',
  'reply',
  'root',
  'security',
  'support',
  'team',
  'webmaster',
  'www',
];

/** Free mailbox providers: nobody can verify them, so a business sends from a domain it owns instead. */
export const CONSUMER_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
];

/** How many domains of its own a workspace can add. */
export const MAX_EMAIL_DOMAINS = 3;

// The shapes the SQL checks enforce on email_domains.domain and email_addresses.local_part.
const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** What someone typed in the domain box, reduced to the domain: "https://LoneStarHVAC.com/contact" → "lonestarhvac.com". */
export function normalizeEmailDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
}

export const isHandsFreeOsDomain = (domain: string): boolean =>
  /(^|\.)handsfreeos\.com$/.test(domain);
/** HandsFreeOS's own domain. Only HandsFreeOS's own business may send and receive on it, never a subdomain (M19). */
export const HANDSFREEOS_DOMAIN = 'handsfreeos.com';
/** Where a domain's MX points for its mail to arrive in HandsFreeOS (M19). */
export const INBOUND_MX_HOST = 'inbound.postmarkapp.com';
export const isConsumerMailDomain = (domain: string): boolean =>
  CONSUMER_MAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
export const isReservedLocalPart = (localPart: string): boolean =>
  RESERVED_LOCAL_PARTS.includes(localPart.toLowerCase());

export const emailDomainName = z
  .string()
  .max(300)
  .transform(normalizeEmailDomain)
  .pipe(
    z
      .string()
      .min(1, 'Enter your domain, like lonestarhvac.com.')
      .max(253, 'That domain is too long.')
      .regex(DOMAIN_PATTERN, 'Enter a domain like lonestarhvac.com.'),
  );

export const emailLocalPart = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter the part before the @.')
  .max(64, 'Keep it under 64 characters.')
  .regex(
    LOCAL_PART_PATTERN,
    'Use letters, numbers, dots, dashes and underscores, starting and ending with a letter or number.',
  )
  .refine((v) => !/[._-]{2}/.test(v), {
    error: 'Don’t put two dots, dashes or underscores in a row.',
  });

export const emailDomainStatus = z.enum(['pending', 'verified', 'failed']);
/** Whether a domain's mail arrives here (M19): people ask (pending), the worker says on or lapsed. */
export const emailReceivingStatus = z.enum(['off', 'pending', 'on', 'lapsed']);
export const mailboxProvider = z.enum(['microsoft', 'google']);
export const mailboxStatus = z.enum([
  'pending',
  'active',
  'reauth_required',
  'error',
  'disconnected',
]);
export const suppressionReason = z.enum(['hard_bounce', 'spam_complaint', 'manual']);

// ---------- domains ----------
export const EmailDomainAddInput = z.object({ workspaceId: uuid, domain: emailDomainName });
export const EmailDomainRefInput = z.object({ workspaceId: uuid, emailDomainId: uuid });
export const EmailDomainRefOutput = z.object({ emailDomainId: uuid });

const dnsHost = z.string().trim().max(255).nullable().optional();
/** Worker-only: what Postmark said about a domain. Omitted fields keep what is stored. */
export const EmailDomainRecordInput = z.object({
  workspaceId: uuid,
  emailDomainId: uuid,
  providerDomainId: z.string().trim().min(1).max(64).optional(),
  dkimHost: dnsHost,
  dkimValue: z.string().trim().max(4000).nullable().optional(),
  returnPathHost: dnsHost,
  returnPathValue: dnsHost,
  dkimVerified: z.boolean().optional(),
  returnPathVerified: z.boolean().optional(),
  error: z.string().trim().min(1).max(2000).nullable().optional(),
});
export const EmailDomainRecordOutput = z.object({
  emailDomainId: uuid,
  status: emailDomainStatus,
  changed: z.boolean(),
});

/** Turning receiving on or off, or what the worker saw of the MX. `changed` is false for a repeat. */
export const EmailDomainReceivingOutput = z.object({
  emailDomainId: uuid,
  receiving: emailReceivingStatus,
  changed: z.boolean(),
});
/** Worker-only: whether the domain's MX points at Postmark. Null when DNS didn't answer, which changes nothing. */
export const EmailDomainRecordReceivingInput = z.object({
  workspaceId: uuid,
  emailDomainId: uuid,
  mxFound: z.boolean().nullable(),
});

// ---------- sending addresses ----------
export const EmailAddressCreateInput = z.object({
  workspaceId: uuid,
  localPart: emailLocalPart,
  /** Absent or null: the shared subdomain. */
  emailDomainId: uuid.nullable().optional(),
  displayName,
  isDefault: z.boolean().default(false),
  /** The person whose own address it is (M19): only they send from it, and its mail is theirs alone. */
  ownerUserId: uuid.nullable().optional(),
});
export const EmailAddressCreateOutput = z.object({ emailAddressId: uuid, address: z.string() });
export const EmailAddressUpdateInput = z.object({
  workspaceId: uuid,
  emailAddressId: uuid,
  displayName: displayName.optional(),
  isDefault: z.boolean().optional(),
  localPart: emailLocalPart.optional(),
  /** Give a team address to one person (M19). Taking one from its person is email_address.reassign's. */
  ownerUserId: uuid.nullable().optional(),
});
export const EmailAddressUpdateOutput = z.object({
  emailAddressId: uuid,
  address: z.string(),
  updated: z.array(z.string()),
});

/**
 * What becomes of the address of someone who has left, and of their mail on it (M19): the team's, another
 * person's, or removed with it.
 */
export const EmailAddressReassignInput = z
  .object({
    workspaceId: uuid,
    emailAddressId: uuid,
    to: z.enum(['team', 'person', 'remove']),
    /** Who gets it, when `to` is person. */
    userId: uuid.optional(),
  })
  .refine((v) => (v.to === 'person') === !!v.userId, {
    path: ['userId'],
    message: 'Pick who gets the address.',
  });
export const EmailAddressReassignOutput = z.object({
  emailAddressId: uuid,
  to: z.enum(['team', 'person', 'remove']),
  /** How many threads went with it. */
  threads: z.number().int(),
});

// ---------- connected mailboxes ----------
export const MailboxConnectInput = z.object({
  workspaceId: uuid,
  provider: mailboxProvider,
  /** A team mailbox (info@) rather than one person's. */
  shared: z.boolean().default(false),
});
/** `state` goes to the worker's /oauth/<provider>/start once; only its hash is stored. */
export const MailboxConnectOutput = z.object({ connectionId: uuid, state: z.string() });
export const MailboxRefInput = z.object({ workspaceId: uuid, connectionId: uuid });
export const MailboxRefOutput = z.object({ connectionId: uuid });

// worker-only (system actor)
export const MailboxActivateInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  accountEmail: email,
  displayName: z.string().trim().max(200).nullable().optional(),
  scopes: z.array(z.string().trim().min(1).max(200)).max(50),
  /** Sealed by the worker; stored as is and never echoed. */
  tokenEnc: z.string().min(1).max(20_000),
  tokenKeyId: z.string().trim().min(1).max(100),
  tokenExpiresAt: isoDateTime.nullable(),
});
export const MailboxFailInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  status: z.enum(['reauth_required', 'error']),
  error: z.string().trim().min(1).max(2000),
});
export const MailboxSystemOutput = z.object({
  connectionId: uuid,
  status: mailboxStatus,
  changed: z.boolean(),
});

// ---------- mail from people we don't know ----------
export const EmailClaimUnmatchedInput = z.object({
  workspaceId: uuid,
  unmatchedId: uuid,
  personId: uuid,
});
export const EmailClaimUnmatchedOutput = z.object({ unmatchedId: uuid, personId: uuid });
export const EmailUnmatchedRefInput = z.object({ workspaceId: uuid, unmatchedId: uuid });
export const EmailUnmatchedRefOutput = z.object({ unmatchedId: uuid });

// ---------- suppressions ----------
export const EmailSuppressionAddInput = z.object({ workspaceId: uuid, address: email });
export const EmailSuppressionReleaseInput = z.object({ workspaceId: uuid, suppressionId: uuid });
export const EmailSuppressionRefOutput = z.object({ suppressionId: uuid });

// ---------- queries ----------
export const EmailAddressOut = z.object({
  id: uuid,
  address: z.string(),
  localPart: z.string(),
  displayName: z.string(),
  isDefault: z.boolean(),
  emailDomainId: uuid.nullable(),
  /** Null for the shared subdomain. */
  domain: z.string().nullable(),
  /** Mail can go out from it now: the shared subdomain, or a verified domain. */
  usable: z.boolean(),
});
export const EmailDomainOut = z.object({
  id: uuid,
  domain: z.string(),
  status: emailDomainStatus,
  dkimHost: z.string().nullable(),
  dkimValue: z.string().nullable(),
  returnPathHost: z.string().nullable(),
  returnPathValue: z.string().nullable(),
  dkimVerifiedAt: isoDateTime.nullable(),
  returnPathVerifiedAt: isoDateTime.nullable(),
  lastCheckedAt: isoDateTime.nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDateTime,
});
export const MailboxOut = z.object({
  id: uuid,
  provider: mailboxProvider,
  accountEmail: z.string().nullable(),
  displayName: z.string().nullable(),
  userId: uuid.nullable(),
  userName: z.string().nullable(),
  shared: z.boolean(),
  status: mailboxStatus,
  lastSyncedAt: isoDateTime.nullable(),
  lastError: z.string().nullable(),
  connectedAt: isoDateTime.nullable(),
});
export const EmailSetupStatusInput = z.object({ workspaceId: uuid });
export const EmailSetupStatusOutput = z.object({
  sharedDomain: z.string(),
  addresses: z.array(EmailAddressOut),
  domains: z.array(EmailDomainOut),
  mailboxes: z.array(MailboxOut),
  counts: z.object({
    /** Addresses mail cannot go to right now. */
    suppressions: z.number().int(),
    /** Mail from unknown senders waiting to be claimed or dismissed. */
    unmatched: z.number().int(),
  }),
});

export const EmailSuppressionListInput = ListInput.extend({
  workspaceId: uuid,
  includeReleased: z.boolean().default(false),
});
export const EmailSuppressionOut = z.object({
  id: uuid,
  address: z.string(),
  reason: suppressionReason,
  origin: z.string().nullable(),
  createdAt: isoDateTime,
  createdBy: UserRef,
  releasedAt: isoDateTime.nullable(),
  releasedBy: UserRef,
});
export const EmailSuppressionListOutput = z.object({
  items: z.array(EmailSuppressionOut),
  nextCursor: z.string().nullable(),
});

export const EmailUnmatchedListInput = ListInput.extend({ workspaceId: uuid });
export const EmailUnmatchedOut = z.object({
  id: uuid,
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  receivedAt: isoDateTime,
  /** Which of the workspace's addresses it was sent to. */
  toAddress: z.string().nullable(),
});
export const EmailUnmatchedListOutput = z.object({
  items: z.array(EmailUnmatchedOut),
  nextCursor: z.string().nullable(),
});
