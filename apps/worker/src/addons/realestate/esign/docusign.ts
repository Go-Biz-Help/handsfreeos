/**
 * DocuSign (round five, step 7), signed in to by the brokerage: its eSignature REST API, v2.1.
 *
 * - **The sign-in** is DocuSign's Authorization Code Grant with PKCE, as HandsFreeOS's app there
 *   (`ADDON_PLATFORM_KEYS` `realestate.docusign`: `clientId`, `clientSecret`, and `environment` `demo` while it's
 *   tried on DocuSign's developer accounts). Who signed in, and the account it sends from, come from `userinfo`:
 *   its default account, and that account's own address (`base_uri`), kept with the connection.
 * - **An envelope** is made as a draft (`status: created`) with the document and its signers in order, and its
 *   updates sent to the connection's own address (Connect, JSON). The agent places the fields and sends it in
 *   DocuSign's sending page, made fresh each time it's opened.
 * - **Its updates** aren't signed with a key HandsFreeOS holds, so each only says which envelope to look at: where
 *   it stands is read back from DocuSign.
 * - **Done**, the combined signed PDF and the certificate of completion are fetched.
 */
import type { EsignSigner } from '@hfos/core/addons/realestate/esign';
import { ConnectionRefused } from '../../connections';
import type { AddonOAuthProvider, OAuthApp } from '../../sign-ins';
import type { AddonWebhookRequest, AddonWebhookUpdate } from '../../webhooks';
import { esignJson, esignPdf, isoOf, list, obj, text } from './http';
import { EsignUnreachable, type EsignFetch, type EsignService, type EsignStanding } from './types';

const WORDS = { service: 'DocuSign' };

/** Where DocuSign signs people in: its developer accounts while it's tried, else its own. */
export const docusignAuthHost = (app: OAuthApp) =>
  app['environment'] === 'demo' ? 'https://account-d.docusign.com' : 'https://account.docusign.com';

const basic = (app: OAuthApp) =>
  `Basic ${Buffer.from(`${app['clientId'] ?? ''}:${app['clientSecret'] ?? ''}`).toString('base64')}`;

async function token(
  app: OAuthApp,
  form: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: EsignFetch,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
  const res = await fetchImpl(`${docusignAuthHost(app)}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: basic(app),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
    signal,
  }).catch(() => {
    throw new EsignUnreachable('DocuSign didn’t answer. Try again in a minute.');
  });
  if (res.status === 400 || res.status === 401)
    throw new ConnectionRefused(
      'DocuSign didn’t accept that sign-in. Choose Connect under Real Estate → Settings → Connections and sign in again.',
    );
  if (!res.ok)
    throw new EsignUnreachable(
      `DocuSign had trouble signing in (it said ${res.status}). Try again in a minute.`,
    );
  const body = obj(await res.json().catch(() => null));
  const accessToken = text(body['access_token'], 8000);
  if (!accessToken)
    throw new EsignUnreachable('DocuSign sent a sign-in HandsFreeOS couldn’t read.');
  const seconds = Number(body['expires_in']);
  return {
    accessToken,
    refreshToken: text(body['refresh_token'], 8000),
    expiresAt: Number.isFinite(seconds)
      ? new Date(Date.now() + seconds * 1000).toISOString()
      : null,
  };
}

/** HandsFreeOS's app at DocuSign: the sign-in, the code swapped, the tokens renewed. */
export function docusignOAuth(fetchImpl: EsignFetch = fetch): AddonOAuthProvider {
  return {
    authorizeUrl({ app, state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        response_type: 'code',
        scope: 'signature extended',
        client_id: app['clientId'] ?? '',
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${docusignAuthHost(app)}/oauth/auth?${q.toString()}`;
    },
    async exchange({ app, code, codeVerifier, redirectUri }, signal) {
      const t = await token(
        app,
        {
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        },
        signal,
        fetchImpl,
      );
      const who = await esignJson(
        fetchImpl,
        `${docusignAuthHost(app)}/oauth/userinfo`,
        { headers: { authorization: `Bearer ${t.accessToken}` }, signal },
        WORDS,
      );
      const accounts = list(who['accounts']);
      const account = accounts.find((a) => a['is_default'] === true) ?? accounts[0];
      const accountId = text(account?.['account_id'], 100);
      const baseUri = text(account?.['base_uri'], 300);
      if (!account || !accountId || !baseUri || !/^https:\/\/[^\s/]+/.test(baseUri))
        throw new ConnectionRefused(
          'That DocuSign sign-in has no eSignature account to send from. Sign in with the account your brokerage sends from.',
        );
      const email = text(who['email'], 200);
      const accountName = text(account['account_name'], 120);
      return {
        tokens: {
          accessToken: t.accessToken,
          ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
        },
        expiresAt: t.expiresAt,
        label: [accountName, email ? `(${email})` : null].filter(Boolean).join(' ') || 'DocuSign',
        accountRef: accountId,
        details: { accountId, accountName, baseUri: baseUri.replace(/\/+$/, '') },
      };
    },
    async refresh({ app, tokens }, signal) {
      const refreshToken = tokens['refreshToken'];
      if (!refreshToken)
        throw new ConnectionRefused(
          'DocuSign needs signing in to again. Choose Connect under Real Estate → Settings → Connections.',
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

/** What DocuSign calls each signer's step, in ours. */
function signerState(status: string | null): EsignSigner['state'] {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'opened';
    case 'signed':
    case 'completed':
      return 'signed';
    case 'declined':
      return 'declined';
    default:
      return 'waiting';
  }
}

/** What DocuSign calls an envelope's state, in ours. */
function envelopeState(status: string | null): EsignStanding['state'] {
  switch (status) {
    case 'created':
      return 'draft';
    case 'completed':
      return 'completed';
    case 'declined':
      return 'declined';
    case 'voided':
    case 'deleted':
      return 'voided';
    default:
      // sent, delivered, signed (not yet everyone), correct
      return 'sent';
  }
}

/** An envelope's events DocuSign tells the connection's address about. */
const CONNECT_EVENTS = [
  'envelope-sent',
  'envelope-delivered',
  'envelope-completed',
  'envelope-declined',
  'envelope-voided',
  'recipient-delivered',
  'recipient-completed',
  'recipient-declined',
];

export function createDocusign(opts: {
  readonly accessToken: string;
  readonly accountId: string;
  readonly baseUri: string;
  readonly fetch?: EsignFetch;
}): EsignService {
  const fetchImpl = opts.fetch ?? fetch;
  const api = `${opts.baseUri}/restapi/v2.1/accounts/${encodeURIComponent(opts.accountId)}`;
  const auth = { authorization: `Bearer ${opts.accessToken}` };
  const send = (path: string, method: string, body: unknown, signal: AbortSignal) =>
    esignJson(
      fetchImpl,
      `${api}${path}`,
      {
        method,
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
      WORDS,
    );
  const envelope = (id: string) => `/envelopes/${encodeURIComponent(id)}`;
  return {
    provider: 'docusign',
    async prepare(req, signal) {
      const made = await send(
        '/envelopes',
        'POST',
        {
          emailSubject: req.subject.slice(0, 100),
          ...(req.message ? { emailBlurb: req.message } : {}),
          status: 'created',
          documents: [
            {
              documentId: '1',
              name: req.document.name,
              fileExtension: 'pdf',
              documentBase64: req.document.bytes.toString('base64'),
            },
          ],
          recipients: {
            signers: req.signers.map((s, i) => ({
              recipientId: String(i + 1),
              name: s.name,
              email: s.email,
              routingOrder: String(s.order),
            })),
          },
          ...(req.webhookUrl
            ? {
                eventNotification: {
                  url: req.webhookUrl,
                  requireAcknowledgment: 'true',
                  loggingEnabled: 'true',
                  deliveryMode: 'SIM',
                  events: CONNECT_EVENTS,
                  eventData: { version: 'restv2.1', format: 'json', includeData: [] },
                },
              }
            : {}),
        },
        signal,
      );
      const id = text(made['envelopeId'], 100);
      if (!id) throw new EsignUnreachable('DocuSign didn’t say what it made. Try again.');
      return { externalId: id, openUrl: null };
    },
    async openUrl(externalId, state, returnUrl, signal) {
      const view =
        state === 'draft'
          ? await send(`${envelope(externalId)}/views/sender`, 'POST', { returnUrl }, signal)
          : await send('/views/console', 'POST', { envelopeId: externalId, returnUrl }, signal);
      const url = text(view['url'], 2000);
      if (!url) throw new EsignUnreachable('DocuSign didn’t give a page to open. Try again.');
      return url;
    },
    async status(externalId, signal) {
      const e = await esignJson(
        fetchImpl,
        `${api}${envelope(externalId)}?include=recipients`,
        { headers: auth, signal },
        WORDS,
      );
      const signers = list(obj(e['recipients'])['signers']).map((s, i) => ({
        name: text(s['name'], 120) ?? 'Signer',
        email: text(s['email'], 254) ?? '',
        order: Math.min(10, Math.max(1, Number(s['routingOrder']) || i + 1)),
        state: signerState(text(s['status'], 40)),
        signedAt: isoOf(s['signedDateTime']),
      }));
      return {
        state: envelopeState(text(e['status'], 40)),
        signers: signers.length ? signers : null,
        sentAt: isoOf(e['sentDateTime']),
        completedAt: isoOf(e['completedDateTime']),
      };
    },
    async copies(externalId, signal) {
      const [signed, certificate] = await Promise.all([
        esignPdf(
          fetchImpl,
          `${api}${envelope(externalId)}/documents/combined?certificate=false`,
          { headers: auth, signal },
          WORDS,
        ),
        esignPdf(
          fetchImpl,
          `${api}${envelope(externalId)}/documents/certificate`,
          { headers: auth, signal },
          WORDS,
        ),
      ]);
      return { signed, certificate };
    },
    async void(externalId, reason, draft, signal) {
      // A draft was never sent: it goes to DocuSign's deleted folder. One that's out is voided with the reason.
      if (draft) await send('/folders/recyclebin', 'PUT', { envelopeIds: [externalId] }, signal);
      else
        await send(
          envelope(externalId),
          'PUT',
          { status: 'voided', voidedReason: reason.slice(0, 200) },
          signal,
        );
    },
  };
}

/** What a Connect update says: which envelope to look at, once per update. */
export function docusignUpdates(request: AddonWebhookRequest): readonly AddonWebhookUpdate[] {
  let body: Record<string, unknown>;
  try {
    body = obj(JSON.parse(request.rawBody));
  } catch {
    throw new Error('A DocuSign update that isn’t JSON.');
  }
  const data = obj(body['data']);
  const envelopeId = text(data['envelopeId'], 100) ?? text(body['envelopeId'], 100);
  if (!envelopeId) return [];
  const event = text(body['event'], 60) ?? 'envelope-update';
  const at = text(body['generatedDateTime'], 60) ?? '';
  const recipient = text(data['recipientId'], 20) ?? '';
  return [
    {
      id: `${envelopeId}:${event}:${recipient}:${at}`.slice(0, 200),
      kind: event,
      data: { envelopeId },
    },
  ];
}
