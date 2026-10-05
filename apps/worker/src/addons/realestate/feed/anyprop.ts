/**
 * AnyProp (https://api.anyprop.com), a supplier with one RESO Web API across many MLSs (round five, step 3). Its
 * username and password are swapped for a token (`POST /v1/token`, good for about thirty days), then it's asked as any
 * RESO feed is (./reso.ts). Its MLS profiles say each MLS's name, notice and logo, shown with that MLS's listings.
 */
import type { ConnectionTried } from '../../connections';
import { feedJson, httpsUrl, obj, str } from './http';
import { cachedToken, createResoFeed, forgetToken, type MlsProfile } from './reso';
import type { FeedFetch, ListingFeed } from './types';

export const ANYPROP_API = 'https://api.anyprop.com/v1';

const words = {
  supplier: 'AnyProp',
  refused:
    'AnyProp turned that username and password down. Check them with AnyProp, then connect again.',
};

const tokenFor = (
  cacheKey: string,
  fields: Readonly<Record<string, string>>,
  fetchImpl: FeedFetch,
  base: string,
  signal: AbortSignal,
) =>
  cachedToken(
    cacheKey,
    fetchImpl,
    `${base}/token`,
    { username: fields['username'] ?? '', password: fields['password'] ?? '' },
    words,
    signal,
  );

/** Each MLS's name, notice and logo, by its OriginatingSystemName (lowercase). */
async function profilesOf(
  fetchImpl: FeedFetch,
  base: string,
  token: string,
  signal: AbortSignal,
): Promise<Map<string, MlsProfile>> {
  const body = await feedJson(
    fetchImpl,
    `${base}/listings/mls_profiles`,
    { method: 'GET', signal, headers: { authorization: `Bearer ${token}` } },
    words,
  );
  const list = Array.isArray(body) ? body : (obj(body)['value'] ?? obj(body)['data'] ?? []);
  const out = new Map<string, MlsProfile>();
  for (const raw of Array.isArray(list) ? (list as unknown[]) : []) {
    const p = obj(raw);
    const name = str(p['originating_system_name'], 80);
    if (!name) continue;
    const year = str(p['current_year'], 4) ?? String(new Date().getFullYear());
    out.set(name.toLowerCase(), {
      name,
      fullName: str(p['originating_system_full_name'], 200),
      notice: str(p['disclaimer'], 4000)?.replace(/\{\{?\s*current_year\s*\}?\}/gi, year) ?? null,
      logoUrl: httpsUrl(p['mls_logo']),
    });
  }
  return out;
}

/** Profiles kept for an hour: they change rarely. */
const profileCache = new Map<
  string,
  { readonly at: number; readonly profiles: Map<string, MlsProfile> }
>();

export function anypropFromFields(
  fields: Readonly<Record<string, string>>,
  cacheKey: string,
  fetchImpl: FeedFetch = fetch,
  base = ANYPROP_API,
): ListingFeed {
  return createResoFeed({
    provider: 'anyprop',
    label: 'AnyProp',
    serviceUrl: `${base}/listings/data`,
    refused: words.refused,
    fetch: fetchImpl,
    token: (signal) => tokenFor(cacheKey, fields, fetchImpl, base, signal),
    profiles: async (signal) => {
      const held = profileCache.get(cacheKey);
      if (held && held.at > Date.now() - 3_600_000) return held.profiles;
      const token = await tokenFor(cacheKey, fields, fetchImpl, base, signal);
      const profiles = await profilesOf(fetchImpl, base, token, signal);
      profileCache.set(cacheKey, { at: Date.now(), profiles });
      return profiles;
    },
  });
}

/** Tries a pasted AnyProp username and password: a token, and the MLSs the account reads. */
export async function tryAnypropFields(
  fields: Readonly<Record<string, string>>,
  signal: AbortSignal,
  fetchImpl: FeedFetch = fetch,
  base = ANYPROP_API,
): Promise<ConnectionTried> {
  const key = `try:${Math.random()}`;
  try {
    const token = await tokenFor(key, fields, fetchImpl, base, signal);
    const profiles = await profilesOf(fetchImpl, base, token, signal);
    const mlss = [...profiles.values()].map((p) => p.fullName ?? p.name).slice(0, 50);
    return {
      label: fields['username'] ?? 'AnyProp account',
      accountRef: fields['username'] ?? null,
      details: mlss.length ? { mlss } : {},
    };
  } finally {
    forgetToken(key);
  }
}
