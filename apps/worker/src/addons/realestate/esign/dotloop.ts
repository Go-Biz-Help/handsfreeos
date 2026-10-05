/**
 * Dotloop (round five, step 7), signed in to by the brokerage: its Public API, v2.
 *
 * - **The sign-in** is Dotloop's Authorization Code Grant, as HandsFreeOS's app there (`ADDON_PLATFORM_KEYS`
 *   `realestate.dotloop`: `clientId`, `clientSecret`). Who signed in, and the profile loops are made in, come from
 *   `/account`: its default profile, kept with the connection.
 * - **A document goes for signing** in a loop made for the deal with Loop-It (a purchase on a buyer's deal, a
 *   listing on a seller's), its signers added as the deal's clients, and the PDF uploaded to a "HandsFreeOS" folder.
 *   The agent opens the loop, places the fields and sends it from there.
 * - **Dotloop says nothing about signing**, so its agent presses “It's signed” here once everyone has, and the
 *   document is fetched from the loop as it is now, signatures and all.
 */
import { ConnectionRefused } from '../../connections';
import type { AddonOAuthProvider, OAuthApp } from '../../sign-ins';
import { esignJson, esignPdf, list, obj, text } from './http';
import { EsignUnreachable, type EsignFetch, type EsignService } from './types';

const WORDS = { service: 'Dotloop' };
export const DOTLOOP_AUTH = 'https://auth.dotloop.com';
export const DOTLOOP_API = 'https://api-gateway.dotloop.com/public/v2';

const basic = (app: OAuthApp) =>
  `Basic ${Buffer.from(`${app['clientId'] ?? ''}:${app['clientSecret'] ?? ''}`).toString('base64')}`;

async function token(
  app: OAuthApp,
  params: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: EsignFetch,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
  const res = await fetchImpl(
    `${DOTLOOP_AUTH}/oauth/token?${new URLSearchParams(params).toString()}`,
    {
      method: 'POST',
      headers: { authorization: basic(app), accept: 'application/json' },
      signal,
    },
  ).catch(() => {
    throw new EsignUnreachable('Dotloop didn’t answer. Try again in a minute.');
  });
  if (res.status === 400 || res.status === 401)
    throw new ConnectionRefused(
      'Dotloop didn’t accept that sign-in. Choose Connect under Real Estate → Settings → Connections and sign in again.',
    );
  if (!res.ok)
    throw new EsignUnreachable(
      `Dotloop had trouble signing in (it said ${res.status}). Try again in a minute.`,
    );
  const body = obj(await res.json().catch(() => null));
  const accessToken = text(body['access_token'], 8000);
  if (!accessToken) throw new EsignUnreachable('Dotloop sent a sign-in HandsFreeOS couldn’t read.');
  const seconds = Number(body['expires_in']);
  return {
    accessToken,
    refreshToken: text(body['refresh_token'], 8000),
    expiresAt: Number.isFinite(seconds)
      ? new Date(Date.now() + seconds * 1000).toISOString()
      : null,
  };
}

/** HandsFreeOS's app at Dotloop: the sign-in, the code swapped, the tokens renewed. */
export function dotloopOAuth(fetchImpl: EsignFetch = fetch): AddonOAuthProvider {
  return {
    authorizeUrl({ app, state, codeChallenge, redirectUri }) {
      // Dotloop doesn't take PKCE; the challenge rides along unused, and the state does the work.
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: app['clientId'] ?? '',
        redirect_uri: redirectUri,
        state,
        redirect_on_deny: 'true',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${DOTLOOP_AUTH}/oauth/authorize?${q.toString()}`;
    },
    async exchange({ app, code, redirectUri }, signal) {
      const t = await token(
        app,
        { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
        signal,
        fetchImpl,
      );
      const headers = { authorization: `Bearer ${t.accessToken}` };
      const account = obj(
        (await esignJson(fetchImpl, `${DOTLOOP_API}/account`, { headers, signal }, WORDS))['data'],
      );
      let profileId = text(account['defaultProfileId'], 40);
      if (!profileId) {
        const profiles = list(
          (await esignJson(fetchImpl, `${DOTLOOP_API}/profile`, { headers, signal }, WORDS))[
            'data'
          ],
        );
        profileId = text((profiles.find((p) => p['default'] === true) ?? profiles[0])?.['id'], 40);
      }
      if (!profileId)
        throw new ConnectionRefused(
          'That Dotloop sign-in has no profile to make loops in. Sign in with the account your brokerage uses.',
        );
      const name = [text(account['firstName'], 60), text(account['lastName'], 60)]
        .filter(Boolean)
        .join(' ');
      const email = text(account['email'], 200);
      return {
        tokens: {
          accessToken: t.accessToken,
          ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
        },
        expiresAt: t.expiresAt,
        label: [name || null, email ? `(${email})` : null].filter(Boolean).join(' ') || 'Dotloop',
        accountRef: text(account['id'], 40),
        details: { profileId },
      };
    },
    async refresh({ app, tokens }, signal) {
      const refreshToken = tokens['refreshToken'];
      if (!refreshToken)
        throw new ConnectionRefused(
          'Dotloop needs signing in to again. Choose Connect under Real Estate → Settings → Connections.',
        );
      const t = await token(
        app,
        { grant_type: 'refresh_token', refresh_token: refreshToken },
        signal,
        fetchImpl,
      );
      return {
        tokens: { accessToken: t.accessToken, refreshToken: t.refreshToken ?? refreshToken },
        expiresAt: t.expiresAt,
      };
    },
  };
}

/** A document in a loop, as one id: `<profile>:<loop>:<folder>:<document>`. */
export const dotloopId = (parts: {
  readonly profileId: string;
  readonly loopId: string;
  readonly folderId: string;
  readonly documentId: string;
}) => `${parts.profileId}:${parts.loopId}:${parts.folderId}:${parts.documentId}`;

function partsOf(externalId: string) {
  const [profileId, loopId, folderId, documentId] = externalId.split(':');
  if (!profileId || !loopId || !folderId || !documentId)
    throw new EsignUnreachable('HandsFreeOS lost track of that loop in Dotloop. Send it again.');
  return { profileId, loopId, folderId, documentId };
}

export function createDotloop(opts: {
  readonly accessToken: string;
  readonly profileId: string;
  readonly fetch?: EsignFetch;
}): EsignService {
  const fetchImpl = opts.fetch ?? fetch;
  const auth = { authorization: `Bearer ${opts.accessToken}` };
  const loopPath = (p: { profileId: string; loopId: string }) =>
    `${DOTLOOP_API}/profile/${encodeURIComponent(p.profileId)}/loop/${encodeURIComponent(p.loopId)}`;
  return {
    provider: 'dotloop',
    async prepare(req, signal) {
      const listing = req.deal.side === 'listing';
      const loop = obj(
        (
          await esignJson(
            fetchImpl,
            `${DOTLOOP_API}/loop-it?profile_id=${encodeURIComponent(opts.profileId)}`,
            {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify({
                name: `${req.deal.name}: ${req.subject}`.slice(0, 200),
                transactionType: listing ? 'LISTING_FOR_SALE' : 'PURCHASE_OFFER',
                status: listing ? 'PRE_LISTING' : 'PRE_OFFER',
                participants: req.signers.map((s) => ({
                  fullName: s.name,
                  email: s.email,
                  role: listing ? 'SELLER' : 'BUYER',
                })),
              }),
              signal,
            },
            WORDS,
          )
        )['data'],
      );
      const loopId = text(loop['id'], 40);
      if (!loopId) throw new EsignUnreachable('Dotloop didn’t say what loop it made. Try again.');
      const at = { profileId: opts.profileId, loopId };
      const folder = obj(
        (
          await esignJson(
            fetchImpl,
            `${loopPath(at)}/folder`,
            {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify({ name: 'HandsFreeOS' }),
              signal,
            },
            WORDS,
          )
        )['data'],
      );
      const folderId = text(folder['id'], 40);
      if (!folderId) throw new EsignUnreachable('Dotloop didn’t make the folder. Try again.');
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(req.document.bytes)], { type: 'application/pdf' }),
        req.document.name,
      );
      const doc = obj(
        (
          await esignJson(
            fetchImpl,
            `${loopPath(at)}/folder/${encodeURIComponent(folderId)}/document`,
            { method: 'POST', headers: auth, body: form, signal },
            WORDS,
          )
        )['data'],
      );
      const documentId = text(doc['id'], 40);
      if (!documentId) throw new EsignUnreachable('Dotloop didn’t keep the document. Try again.');
      const loopUrl = text(loop['loopUrl'], 2000);
      return {
        externalId: dotloopId({ ...at, folderId, documentId }),
        openUrl: loopUrl && /^https:\/\//.test(loopUrl) ? loopUrl : null,
      };
    },
    async openUrl(externalId, _state, _returnUrl, signal) {
      const p = partsOf(externalId);
      const loop = obj(
        (await esignJson(fetchImpl, loopPath(p), { headers: auth, signal }, WORDS))['data'],
      );
      const url = text(loop['loopUrl'], 2000);
      if (!url) throw new EsignUnreachable('Dotloop didn’t give the loop’s page. Try again.');
      return url;
    },
    async status() {
      return null;
    },
    async copies(externalId, signal) {
      const p = partsOf(externalId);
      const signed = await esignPdf(
        fetchImpl,
        `${loopPath(p)}/folder/${encodeURIComponent(p.folderId)}/document/${encodeURIComponent(p.documentId)}`,
        { headers: auth, signal },
        WORDS,
      );
      return { signed, certificate: null };
    },
    async void() {
      // Nothing to stop at Dotloop: the agent archives the loop there.
    },
  };
}
