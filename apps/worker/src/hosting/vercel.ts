/**
 * Vercel, over plain HTTPS (no SDK), because that is where the web app is served from.
 *
 * Three calls and a delete, and the shape of them is the whole reason this file is small: adding a domain to
 * the project is one POST, what the business must put in DNS is one GET, and whether it is actually serving
 * is another. The token and the project come from the worker's environment; nothing here is per-business.
 *
 * **A business's own domain is on our project, not theirs.** They point a CNAME at us and we hold the
 * certificate — the alternative is asking a plumber to manage a Vercel account.
 */
import { resolveTxt } from 'node:dns/promises';
import { HostError, txtValues, type HostedDomain, type SiteHost } from './host';

const API = 'https://api.vercel.com';

interface VercelDomain {
  name?: string;
  verified?: boolean;
  verification?: { type?: string; domain?: string; value?: string; reason?: string }[];
  error?: { code?: string; message?: string };
}

interface VercelConfig {
  /** Vercel's own word for "the DNS does not point here yet". */
  misconfigured?: boolean;
  recommendedCNAME?: { value?: string }[];
}

export function createVercelHost(opts: {
  token: string;
  projectId: string;
  /** Only needed on a team account, which ours is. */
  teamId?: string | null;
}): SiteHost {
  const query = opts.teamId ? `?teamId=${encodeURIComponent(opts.teamId)}` : '';
  const url = (path: string) => `${API}${path}${query}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url(path), {
        method,
        headers: {
          authorization: `Bearer ${opts.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // Nothing was answered. Always worth another try.
      throw new HostError(`Could not reach the host: ${(e as Error).message}`, false);
    }
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as T & { error?: { message?: string } };
    if (res.ok) return json;
    const message = json.error?.message ?? `The host answered ${res.status}.`;
    // 4xx is us or the business; 429 and 5xx are the host, and a job retries those.
    throw new HostError(message, res.status >= 400 && res.status < 500 && res.status !== 429);
  }

  const verificationOf = (d: VercelDomain) => {
    const txt = d.verification?.find((v) => v.type === 'TXT');
    return txt?.domain && txt.value ? { host: txt.domain, value: txt.value } : null;
  };

  async function describe(domain: string): Promise<HostedDomain> {
    const [d, config] = await Promise.all([
      call<VercelDomain>('GET', `/v9/projects/${opts.projectId}/domains/${domain}`),
      call<VercelConfig>('GET', `/v6/domains/${domain}/config`),
    ]);
    const verification = verificationOf(d);
    const cname = {
      host: domain,
      value: config.recommendedCNAME?.[0]?.value ?? 'cname.vercel-dns.com',
    };
    if (!d.verified)
      return {
        status: 'verifying',
        verification,
        cname,
        certificateReady: false,
        error: verification
          ? 'Add the TXT record below, then check again.'
          : 'Waiting for the host to look at your DNS.',
      };
    // Verified but still misconfigured means the CNAME is not pointing here, so nothing is served yet — and
    // a certificate is only issued once it is.
    if (config.misconfigured)
      return {
        status: 'verifying',
        verification: null,
        cname,
        certificateReady: false,
        error: 'The CNAME isn’t pointing here yet. DNS can take a few hours.',
      };
    return { status: 'verified', verification: null, cname, certificateReady: true, error: null };
  }

  return {
    name: 'vercel',
    async add(domain) {
      try {
        await call<VercelDomain>('POST', `/v10/projects/${opts.projectId}/domains`, {
          name: domain,
        });
      } catch (e) {
        // Already on the project is the answer we wanted: a retried job, or somebody adding it twice.
        if (!(e instanceof HostError) || !/already/i.test(e.message)) throw e;
      }
      return describe(domain);
    },
    check: describe,
    async owns(txtHost, token) {
      return (await txtValues(txtHost, resolveTxt)).includes(token);
    },
    async remove(domain) {
      try {
        await call<unknown>('DELETE', `/v9/projects/${opts.projectId}/domains/${domain}`);
      } catch (e) {
        // Already gone is what we were asking for.
        if (!(e instanceof HostError) || !e.permanent) throw e;
      }
    },
  };
}
