/**
 * Where a business's own domain is actually served from (M17).
 *
 * A seam for the same reason `TelephonyProvider` and `Transcriber` are seams: the thing behind it is an
 * account with a bill and a rate limit, and every test in the repo would otherwise need one. The fake is
 * what `pnpm dev` and the suites use; the real one is Vercel, where the web app lives.
 *
 * **Two records, and only one of them is ours to invent.** The TXT proves the business controls the name
 * before a certificate authority is asked for a certificate in it; the CNAME is what points the name here.
 * Both come back from the host rather than being written down in our code, because the host is what will be
 * checking them.
 */

export type HostedDomainStatus = 'pending' | 'verifying' | 'verified' | 'failed';

export interface HostedRecord {
  readonly host: string;
  readonly value: string;
}

export interface HostedDomain {
  readonly status: HostedDomainStatus;
  /** The TXT that proves they hold the name. Null once the host no longer needs it. */
  readonly verification: HostedRecord | null;
  /** The CNAME that points the name here. Null only when the host has not said yet. */
  readonly cname: HostedRecord | null;
  /**
   * Whether a certificate is issued. Kept apart from `verified` on purpose: a name whose DNS is right but
   * whose certificate has not been issued yet serves a browser warning, which is worse than serving nothing.
   */
  readonly certificateReady: boolean;
  /** Why it is not working, in words a business can act on. Null when it is. */
  readonly error: string | null;
}

export interface SiteHost {
  readonly name: 'vercel' | 'fake';
  /** Claim the name for our project, and say what the business has to put in its DNS. */
  add(domain: string): Promise<HostedDomain>;
  /** Look now: are the records there, and is the certificate issued? */
  check(domain: string): Promise<HostedDomain>;
  /** Give the name back. Removing one that was never added is not an error. */
  remove(domain: string): Promise<void>;
}

/**
 * Trouble worth telling a business about rather than retrying: the name is already claimed somewhere else,
 * or it is not a name we can serve. Everything else is the host having a bad minute, and a job retries it.
 */
export class HostError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'HostError';
    this.permanent = permanent;
  }
}

export const isPermanentHostError = (e: unknown): e is HostError =>
  e instanceof HostError && e.permanent;
