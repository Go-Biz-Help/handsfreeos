/**
 * A business's own domain on the pages its customers see (M17).
 *
 * `go.lonestarhvac.com` rather than `handsfreeos.com`, for the forms, payment links, estimates, invoices and
 * booking page alike. Shaped like the email sending
 * domain's schemas on purpose (`schemas/email.ts`): same statuses, same "here are the records to add", same
 * split between what a person may write and what only the worker may.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const brandedDomainStatus = z.enum(['pending', 'verifying', 'verified', 'failed']);
export type BrandedDomainStatus = z.infer<typeof brandedDomainStatus>;

/**
 * One of our own names.
 *
 * Whether a name of ours may be claimed is not a question about the name — it is a question about who is
 * asking, and `platform.claimable_hosts` holds the answer. So this only says "that one is ours"; the
 * handler asks the database whether this workspace is the one it was written down for, and a trigger on
 * `app.branded_domains` refuses anything that gets past the handler.
 */
export const isOurHost = (d: string): boolean =>
  /(^|\.)handsfreeos\.com$/.test(d.trim().toLowerCase());

/** A hostname a business can point at us: the right shape, with no scheme and no path on it. */
export const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'Enter a domain like go.yourbusiness.com — no https:// and no slash.',
  );

/**
 * Where a business publishes its claim's token (a TXT record) to prove the name is its own. The shared CNAME
 * only proves the name points at HandsFreeOS; this says at which business.
 */
export const ownershipHost = (domain: string): string => `_hfos-verify.${domain}`;

export const BrandedDomainAddInput = z.object({ workspaceId: uuid, domain: hostname });
export const BrandedDomainRefInput = z.object({ workspaceId: uuid, domainId: uuid });
export const BrandedDomainRefOutput = z.object({ domainId: uuid, status: brandedDomainStatus });

/** Worker only: what the host said. */
export const BrandedDomainRecordInput = z.object({
  workspaceId: uuid,
  domainId: uuid,
  status: brandedDomainStatus,
  verificationHost: z.string().trim().max(253).nullable(),
  verificationValue: z.string().trim().max(500).nullable(),
  cnameHost: z.string().trim().max(253).nullable(),
  cnameValue: z.string().trim().max(253).nullable(),
  /** A verified domain with no certificate still serves nothing, so the two are recorded apart. */
  certificateReady: z.boolean(),
  lastError: z.string().trim().max(2000).nullable(),
  nextCheckAt: isoDateTime.nullable(),
  /** The claim's token was found at `ownershipHost(domain)`. Until it has been, the domain is not verified. */
  ownershipProved: z.boolean().default(false),
});

/** One DNS record, as a business has to type it into wherever its domain lives. */
export const DnsRecordOut = z.object({
  kind: z.enum(['TXT', 'CNAME']),
  host: z.string(),
  value: z.string(),
  /** Why this one is needed, in a sentence somebody at a domain registrar can act on. */
  why: z.string(),
});

export const BrandedDomainOut = z.object({
  id: uuid,
  domain: z.string(),
  status: brandedDomainStatus,
  /** What is left to do, in order. Empty once it is serving. */
  records: z.array(DnsRecordOut),
  certificateReady: z.boolean(),
  lastError: z.string().nullable(),
  verifiedAt: isoDateTime.nullable(),
  lastCheckedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

export const BrandedDomainGetInput = z.object({ workspaceId: uuid });
export const BrandedDomainGetOutput = z.object({ domain: BrandedDomainOut.nullable() });
