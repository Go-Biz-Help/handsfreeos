import { expect, test } from '@playwright/test';

/**
 * The files that let the phone app open links (M10): served as JSON from /.well-known with no redirect and no session,
 * claiming only /app/… for the iPhone app after excluding every page a customer opens, and naming the Android app
 * (with no certificate fingerprint unless one is configured).
 */

test('apple-app-site-association claims only /app/*, after every customer page', async ({
  request,
}) => {
  const res = await request.get('/.well-known/apple-app-site-association', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(res.headers()['set-cookie']).toBeUndefined();
  const body = (await res.json()) as {
    applinks: {
      details: { appIDs: string[]; components: { '/': string; exclude?: boolean }[] }[];
    };
  };
  expect(body.applinks.details).toHaveLength(1);
  const [details] = body.applinks.details;
  expect(details!.appIDs).toEqual(['8246H5FJ42.com.gobizhelp.handsfreeos']);
  const claimed = details!.components.filter((c) => !c.exclude).map((c) => c['/']);
  expect(claimed).toEqual(['/app/*']);
  // Every customer page is excluded before the claim, so it always opens in the browser.
  const excluded = details!.components.filter((c) => c.exclude).map((c) => c['/']);
  for (const page of [
    '/i/*',
    '/e/*',
    '/p/*',
    '/book/*',
    '/m/*',
    '/hold/*',
    '/w/*',
    '/chat/*',
    '/invite/*',
  ])
    expect(excluded).toContain(page);
  expect(details!.components.at(-1)!['/']).toBe('/app/*');
});

test('assetlinks.json names the Android app, with no fingerprint until one is set', async ({
  request,
}) => {
  const res = await request.get('/.well-known/assetlinks.json', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(await res.json()).toEqual([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.gobizhelp.handsfreeos',
        sha256_cert_fingerprints: [],
      },
    },
  ]);
});
