/**
 * The files that let the phone app open links (M10, "Links that open the app"): Apple's apple-app-site-association
 * and Android's assetlinks.json, served from /.well-known on the web's own domain. Only /app/… opens the app. Every
 * page a customer opens (an invoice, an estimate, a plan, booking, the website chat, a held time, an invitation,
 * a waitlist offer, managing a booking) stays in the browser, so a customer tapping their invoice never lands in a
 * business's app.
 */

/** Go Biz Help LLC's Apple team, and the app's bundle id (also its Android package). */
export const APPLE_TEAM_ID = '8246H5FJ42';
export const APP_ID = 'com.gobizhelp.handsfreeos';

/** The pages customers open, each excluded before /app/* is claimed. */
export const CUSTOMER_PATHS: readonly { readonly path: string; readonly comment: string }[] = [
  { path: '/i/*', comment: 'Invoices customers pay' },
  { path: '/e/*', comment: 'Estimates customers accept' },
  { path: '/p/*', comment: 'Payment plans customers sign up to' },
  { path: '/book/*', comment: 'Online booking' },
  { path: '/m/*', comment: 'A customer managing their booking' },
  { path: '/hold/*', comment: 'A time held for a deposit' },
  { path: '/w/*', comment: 'Waitlist offers' },
  { path: '/v/*', comment: 'A customer sending a video through a video link' },
  { path: '/chat/*', comment: 'The website chat window' },
  { path: '/embed/*', comment: 'The website chat loader' },
  { path: '/invite/*', comment: 'Invitations to join a business, accepted on the web' },
];

/** apple-app-site-association, in the `appIDs` / `components` form (iOS 13 and later). */
export function appleAppSiteAssociation() {
  return {
    applinks: {
      details: [
        {
          appIDs: [`${APPLE_TEAM_ID}.${APP_ID}`],
          components: [
            ...CUSTOMER_PATHS.map((p) => ({ '/': p.path, exclude: true, comment: p.comment })),
            { '/': '/app/*', comment: 'The business’s own screens open the app' },
          ],
        },
      ],
    },
  };
}

/** A SHA-256 certificate fingerprint as assetlinks.json wants it: 32 upper-case hex pairs joined by colons. */
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * The Android signing certificates' SHA-256 fingerprints, from `ANDROID_SHA256_CERT_FINGERPRINTS`: one or more,
 * separated by commas or spaces (Google Play's app signing key, and EAS's upload key while testing outside Play).
 * Anything that isn't a fingerprint is left out. None by default.
 */
export function androidFingerprints(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((f) => f.trim().toUpperCase())
    .filter((f, i, all) => FINGERPRINT.test(f) && all.indexOf(f) === i);
}

/** assetlinks.json: the app may open this site's links (Android verifies the fingerprints before it does). */
export function assetLinks(fingerprints: readonly string[]) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: APP_ID,
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ];
}

/** Both are JSON, served as themselves: no redirect, and kept an hour by browsers and the CDN. */
export function associationResponse(body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600, s-maxage=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
