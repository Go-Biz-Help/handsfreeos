import type { HostedDomain, SiteHost } from './host';
import { HostError } from './host';

/**
 * An in-memory host, for `pnpm dev` and the tests.
 *
 * It decides from the name, the way the fake carrier decides from the last four digits, so a test can drive
 * every ending without a Vercel account:
 *
 *   contains `taken`    already claimed somewhere else — refused, and not retried
 *   contains `slow`     the records are right but the certificate never issues
 *   contains `missing`  the records are never found
 *   contains `squat`    pointed here, but the business never publishes its claim token
 *   anything else       claimed, then working on the next check
 */
export interface FakeHost extends SiteHost {
  /** Domains added, in order, and the ones given back. */
  readonly added: string[];
  readonly removed: string[];
}

const recordsFor = (domain: string) => ({
  verification: { host: `_handsfreeos.${domain}`, value: `hfos-verify-${domain.length}` },
  cname: { host: domain, value: 'cname.handsfreeos-hosting.test' },
});

export function createFakeHost(): FakeHost {
  const added: string[] = [];
  const removed: string[] = [];
  const seen = new Set<string>();

  const state = (domain: string, first: boolean): HostedDomain => {
    const r = recordsFor(domain);
    if (domain.includes('missing'))
      return {
        status: 'verifying',
        ...r,
        certificateReady: false,
        error: 'We can’t see those records in your DNS yet.',
      };
    if (domain.includes('slow'))
      return { status: 'verified', ...r, certificateReady: false, error: null };
    if (first) return { status: 'verifying', ...r, certificateReady: false, error: null };
    return { status: 'verified', ...r, certificateReady: true, error: null };
  };

  return {
    name: 'fake',
    added,
    removed,
    async add(domain) {
      if (domain.includes('taken'))
        throw new HostError('That domain is already in use somewhere else.', true);
      added.push(domain);
      seen.add(domain);
      return state(domain, true);
    },
    async check(domain) {
      // A domain nobody added is one the host has never heard of, which is a real answer rather than a crash.
      if (!seen.has(domain))
        return {
          status: 'failed',
          verification: null,
          cname: null,
          certificateReady: false,
          error: 'That domain isn’t set up here.',
        };
      return state(domain, false);
    },
    async remove(domain) {
      removed.push(domain);
      seen.delete(domain);
    },
    async owns(txtHost) {
      return !txtHost.includes('squat');
    },
  };
}
