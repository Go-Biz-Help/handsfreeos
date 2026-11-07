/**
 * The DNS records a business adds for its own email domain, as Settings → Email → Use your own domain lists them, and
 * as the Assistant reads them out: each with its type, what it is for, the host to type at the DNS provider (relative
 * to the domain, as most providers want it) and the value. Browser-safe.
 */

/** Where bounces go when Postmark hasn't named its own yet, as the screen shows it. */
export const RETURN_PATH_DEFAULT = 'pm.mtasv.net';

/** The DNS name to type at the provider: relative to the domain, as most providers want it. */
export const relativeHost = (host: string, domain: string): string =>
  host.toLowerCase().endsWith(`.${domain.toLowerCase()}`)
    ? host.slice(0, -(domain.length + 1))
    : host;

/** One domain as email.setup_status gives it: only what its records are made from. */
export interface EmailDomainRecordsLike {
  readonly domain: string;
  readonly dkimHost: string | null;
  readonly dkimValue: string | null;
  readonly returnPathHost: string | null;
  readonly returnPathValue: string | null;
  readonly dkimVerifiedAt: string | null;
  readonly returnPathVerifiedAt: string | null;
  readonly ownershipHost: string | null;
  readonly ownershipToken: string;
  readonly ownershipProvedAt: string | null;
  readonly receiving: string;
  readonly mxVerifiedAt: string | null;
}

export interface EmailDnsRecord {
  readonly type: 'TXT' | 'CNAME' | 'MX';
  readonly purpose: string;
  /** What to type in the host box: `@` for the domain itself. */
  readonly host: string;
  readonly fullHost: string;
  readonly value: string;
  readonly priority?: number;
  /** Seen at the DNS provider by the last check. */
  readonly found: boolean;
}

/**
 * The records in the screen's order: DKIM, Return-Path and the ownership TXT once they're made, then the MX record
 * while the domain receives or waits for it (Receive mail here too). Empty while the records are still being made.
 */
export function emailDomainRecords(
  d: EmailDomainRecordsLike,
  inboundMxHost: string,
): EmailDnsRecord[] {
  const out: EmailDnsRecord[] = [];
  if (d.dkimHost && d.dkimValue && d.returnPathHost) {
    out.push(
      {
        type: 'TXT',
        purpose: 'Proves the mail is yours (DKIM)',
        host: relativeHost(d.dkimHost, d.domain),
        fullHost: d.dkimHost,
        value: d.dkimValue,
        found: !!d.dkimVerifiedAt,
      },
      {
        type: 'CNAME',
        purpose: 'Handles bounces (Return-Path)',
        host: relativeHost(d.returnPathHost, d.domain),
        fullHost: d.returnPathHost,
        value: d.returnPathValue ?? RETURN_PATH_DEFAULT,
        found: !!d.returnPathVerifiedAt,
      },
    );
    if (d.ownershipHost)
      out.push({
        type: 'TXT',
        purpose: 'Says the domain is this business’s',
        host: relativeHost(d.ownershipHost, d.domain),
        fullHost: d.ownershipHost,
        value: d.ownershipToken,
        found: !!d.ownershipProvedAt,
      });
  }
  if (d.receiving !== 'off')
    out.push({
      type: 'MX',
      purpose: 'Brings your mail here (priority 10)',
      host: '@',
      fullHost: d.domain,
      value: inboundMxHost,
      priority: 10,
      found: !!d.mxVerifiedAt && d.receiving === 'on',
    });
  return out;
}
