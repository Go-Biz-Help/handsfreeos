/**
 * Real Estate's e-signature adapters (round five, step 7), against scripted answers: what DocuSign's and Dotloop's
 * sign-ins and calls are asked, and what each answer means here. Nothing leaves the test.
 */
import { describe, expect, it } from 'vitest';
import { ConnectionRefused } from '../src/addons/connections';
import {
  createDocusign,
  docusignOAuth,
  docusignUpdates,
} from '../src/addons/realestate/esign/docusign';
import { createDotloop, dotloopOAuth } from '../src/addons/realestate/esign/dotloop';
import { EsignUnreachable, type EsignFetch } from '../src/addons/realestate/esign/types';
import { textPdf } from './pdf-maker';

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit | null | undefined;
}

/** A service that answers from a script, by method and address. */
function scripted(answers: Record<string, () => Response>): { fetch: EsignFetch; asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    fetch: async (url, init) => {
      const method = init.method ?? 'GET';
      asked.push({
        method,
        url,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: init.body,
      });
      const answer = answers[`${method} ${url}`];
      return answer ? answer() : new Response('{"message":"not scripted"}', { status: 404 });
    },
  };
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const signal = () => AbortSignal.timeout(5000);
const APP = { clientId: 'client-1', clientSecret: 'secret-1', environment: 'demo' };

describe('DocuSign', () => {
  it('signs in with PKCE and keeps the account it sends from', async () => {
    const svc = scripted({
      'POST https://account-d.docusign.com/oauth/token': () =>
        json({ access_token: 'at', refresh_token: 'rt', expires_in: 28800 }),
      'GET https://account-d.docusign.com/oauth/userinfo': () =>
        json({
          email: 'kim@brokerage.example',
          accounts: [
            { account_id: 'other', is_default: false, base_uri: 'https://na2.docusign.net' },
            {
              account_id: 'acc-9',
              is_default: true,
              account_name: 'Hill Country Realty',
              base_uri: 'https://na3.docusign.net/',
            },
          ],
        }),
    });
    const oauth = docusignOAuth(svc.fetch);
    const url = new URL(
      oauth.authorizeUrl({
        app: APP,
        state: 'st',
        codeChallenge: 'ch',
        redirectUri: 'https://w.test/oauth/addon/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://account-d.docusign.com/oauth/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      scope: 'signature extended',
      client_id: 'client-1',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
    const account = await oauth.exchange(
      { app: APP, code: 'c', codeVerifier: 'v', redirectUri: 'https://w.test/cb' },
      signal(),
    );
    expect(account).toMatchObject({
      tokens: { accessToken: 'at', refreshToken: 'rt' },
      label: 'Hill Country Realty (kim@brokerage.example)',
      accountRef: 'acc-9',
      details: { accountId: 'acc-9', baseUri: 'https://na3.docusign.net' },
    });
    const token = svc.asked[0]!;
    expect(token.headers['authorization']).toBe(
      `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
    );
    expect(new URLSearchParams(String(token.body)).get('code_verifier')).toBe('v');
  });

  it('asks for the sign-in again when a renewal is turned down', async () => {
    const svc = scripted({
      'POST https://account-d.docusign.com/oauth/token': () =>
        json({ error: 'invalid_grant' }, 400),
    });
    await expect(
      docusignOAuth(svc.fetch).refresh({ app: APP, tokens: { refreshToken: 'old' } }, signal()),
    ).rejects.toBeInstanceOf(ConnectionRefused);
  });

  it('says where an envelope stands in its own words, and throws a draft away rather than voiding it', async () => {
    const api = 'https://na3.docusign.net/restapi/v2.1/accounts/acc-9';
    const svc = scripted({
      [`GET ${api}/envelopes/e1?include=recipients`]: () =>
        json({
          status: 'delivered',
          sentDateTime: '2026-10-02T15:00:00Z',
          recipients: {
            signers: [
              { name: 'A', email: 'a@x.test', routingOrder: '1', status: 'completed' },
              { name: 'B', email: 'b@x.test', routingOrder: '2', status: 'delivered' },
              { name: 'C', email: 'c@x.test', routingOrder: '3', status: 'created' },
            ],
          },
        }),
      [`PUT ${api}/folders/recyclebin`]: () => json({}),
      [`PUT ${api}/envelopes/e2`]: () => json({}),
      [`GET ${api}/envelopes/e3?include=recipients`]: () => json({ message: 'x' }, 401),
    });
    const ds = createDocusign({
      accessToken: 't',
      accountId: 'acc-9',
      baseUri: 'https://na3.docusign.net',
      fetch: svc.fetch,
    });
    expect(await ds.status('e1', signal())).toMatchObject({
      state: 'sent',
      sentAt: '2026-10-02T15:00:00.000Z',
      signers: [{ state: 'signed' }, { state: 'opened' }, { state: 'waiting', order: 3 }],
    });
    await ds.void('e1', 'Not needed', true, signal());
    expect(JSON.parse(String(svc.asked.at(-1)!.body))).toEqual({ envelopeIds: ['e1'] });
    await ds.void('e2', 'Wrong version', false, signal());
    expect(JSON.parse(String(svc.asked.at(-1)!.body))).toEqual({
      status: 'voided',
      voidedReason: 'Wrong version',
    });
    await expect(ds.status('e3', signal())).rejects.toBeInstanceOf(ConnectionRefused);
    await expect(ds.status('e4', signal())).rejects.toBeInstanceOf(EsignUnreachable);
  });

  it('takes only a PDF back as the signed copy', async () => {
    const api = 'https://na3.docusign.net/restapi/v2.1/accounts/acc-9';
    const svc = scripted({
      [`GET ${api}/envelopes/e1/documents/combined?certificate=false`]: () =>
        new Response('<html>oops</html>'),
      [`GET ${api}/envelopes/e1/documents/certificate`]: () => new Response(textPdf([['ok']])),
    });
    const ds = createDocusign({
      accessToken: 't',
      accountId: 'acc-9',
      baseUri: 'https://na3.docusign.net',
      fetch: svc.fetch,
    });
    await expect(ds.copies('e1', signal())).rejects.toThrow(/isn’t a PDF/);
  });

  it('reads an update for its envelope only, never its claims', () => {
    expect(
      docusignUpdates({
        rawBody: JSON.stringify({
          event: 'recipient-completed',
          generatedDateTime: '2026-10-02T16:00:00Z',
          data: { envelopeId: 'e1', recipientId: '2', envelopeSummary: { status: 'completed' } },
        }),
        headers: {},
        url: 'https://w.test/webhooks/addon/t',
      }),
    ).toEqual([
      {
        id: 'e1:recipient-completed:2:2026-10-02T16:00:00Z',
        kind: 'recipient-completed',
        data: { envelopeId: 'e1' },
      },
    ]);
    expect(docusignUpdates({ rawBody: '{}', headers: {}, url: 'u' })).toEqual([]);
    expect(() => docusignUpdates({ rawBody: '<xml/>', headers: {}, url: 'u' })).toThrow();
  });
});

describe('Dotloop', () => {
  const API = 'https://api-gateway.dotloop.com/public/v2';

  it('signs in and keeps the profile loops are made in', async () => {
    const svc = scripted({
      'POST https://auth.dotloop.com/oauth/token?grant_type=authorization_code&code=c&redirect_uri=https%3A%2F%2Fw.test%2Fcb':
        () => json({ access_token: 'at', refresh_token: 'rt', expires_in: 43199 }),
      [`GET ${API}/account`]: () =>
        json({
          data: {
            id: 77,
            firstName: 'Kim',
            lastName: 'Lee',
            email: 'kim@brokerage.example',
            defaultProfileId: 4711,
          },
        }),
    });
    const account = await dotloopOAuth(svc.fetch).exchange(
      { app: APP, code: 'c', codeVerifier: 'v', redirectUri: 'https://w.test/cb' },
      signal(),
    );
    expect(account).toMatchObject({
      tokens: { accessToken: 'at', refreshToken: 'rt' },
      label: 'Kim Lee (kim@brokerage.example)',
      accountRef: '77',
      details: { profileId: '4711' },
    });
  });

  it('makes a loop for the deal, puts the document in its folder, and fetches it back signed', async () => {
    const loop = `${API}/profile/4711/loop/900`;
    const pdf = textPdf([['Signed']]);
    const svc = scripted({
      [`POST ${API}/loop-it?profile_id=4711`]: () =>
        json({ data: { id: 900, loopUrl: 'https://www.dotloop.com/m/loop?loopId=900' } }),
      [`POST ${loop}/folder`]: () => json({ data: { id: 31 } }),
      [`POST ${loop}/folder/31/document`]: () => json({ data: { id: 5555 } }),
      [`GET ${loop}/folder/31/document/5555`]: () => new Response(pdf),
    });
    const dl = createDotloop({ accessToken: 't', profileId: '4711', fetch: svc.fetch });
    const made = await dl.prepare(
      {
        subject: 'Please sign: Listing agreement',
        message: null,
        signers: [{ name: 'Pat Seller', email: 'pat@example.com', order: 1 }],
        document: { name: 'Listing agreement.pdf', bytes: textPdf([['Listing agreement']]) },
        webhookUrl: null,
        deal: { name: 'Elm St listing', side: 'listing' },
      },
      signal(),
    );
    expect(made).toEqual({
      externalId: '4711:900:31:5555',
      openUrl: 'https://www.dotloop.com/m/loop?loopId=900',
    });
    expect(JSON.parse(String(svc.asked[0]!.body))).toEqual({
      name: 'Elm St listing: Please sign: Listing agreement',
      transactionType: 'LISTING_FOR_SALE',
      status: 'PRE_LISTING',
      participants: [{ fullName: 'Pat Seller', email: 'pat@example.com', role: 'SELLER' }],
    });
    expect(svc.asked[2]!.body).toBeInstanceOf(FormData);
    expect(await dl.status(made.externalId, signal())).toBeNull();
    expect((await dl.copies(made.externalId, signal())).signed.equals(pdf)).toBe(true);
  });
});
