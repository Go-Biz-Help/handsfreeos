/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { decideLink, NOT_YOURS } from '../decide';
import { ROUTES, routeFor, targetOfLink, webPathOf } from '../route-map';

/**
 * The one map from the web's addresses to the phone's screens: every route in it, the web-only areas, the three ways a
 * link arrives (a notification's path, an email's https link, the app's scheme), and customer pages never being the
 * app's, here or in what the phones claim (app.json).
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROOT = resolve(__dirname, '../../../../..');

/** A web path for a rule, with a uuid for each part that varies. */
const exampleOf = (web: string) => `/app/w/${WS}${web ? `/${web.replace(/:[A-Za-z]+/g, ID)}` : ''}`;

describe('the route map', () => {
  it('opens each of the web’s pages the phone has on its screen, or its tab until a later step builds it', () => {
    const expected: Record<string, { href: string; later: boolean }> = {
      '': { href: '', later: true },
      inbox: { href: 'inbox', later: false },
      'inbox/:conversationId': { href: 'inbox', later: true },
      pipeline: { href: 'pipeline', later: false },
      'leads/:leadId': { href: 'pipeline', later: true },
      customers: { href: 'customers', later: false },
      'customers/people/:personId': { href: 'customers', later: true },
      'customers/companies/:companyId': { href: 'customers', later: true },
      tasks: { href: 'tasks', later: false },
      calendar: { href: 'calendar', later: true },
      money: { href: 'money', later: false },
      'money/invoices': { href: 'money', later: true },
      'money/invoices/new': { href: 'money', later: true },
      'money/invoices/:invoiceId': { href: 'money', later: true },
      'money/estimates': { href: 'money', later: true },
      'money/estimates/new': { href: 'money', later: true },
      'money/estimates/:estimateId': { href: 'money', later: true },
      'money/payments': { href: 'money', later: true },
      'money/plans': { href: 'money', later: true },
      'money/plans/:subscriptionId': { href: 'money', later: true },
      'workflows/approvals': { href: 'approvals', later: true },
      settings: { href: 'settings', later: false },
    };
    const screens = ROUTES.filter((r) => r.phone !== 'web');
    expect(screens.map((r) => r.web).sort()).toEqual(Object.keys(expected).sort());
    for (const rule of screens) {
      const want = expected[rule.web]!;
      const target = routeFor(exampleOf(rule.web));
      expect({ web: rule.web, target }).toEqual({
        web: rule.web,
        target: expect.objectContaining({
          kind: 'screen',
          href: `/app/w/${WS}${want.href ? `/${want.href}` : ''}`,
          businessId: WS,
          later: want.later ? expect.any(String) : null,
        }),
      });
    }
  });

  it('keeps what a path names and its query for the screen a later step opens', () => {
    expect(routeFor(`/app/w/${WS}/inbox/${ID}`)).toMatchObject({
      params: { conversationId: ID },
    });
    expect(routeFor(`/app/w/${WS}?item=${ID}`)).toMatchObject({
      href: `/app/w/${WS}`,
      params: { item: ID },
    });
    expect(routeFor(`/app/w/${WS}/calendar?appt=${ID}`)).toMatchObject({
      href: `/app/w/${WS}/calendar`,
      params: { appt: ID },
    });
    expect(routeFor(`/app/w/${WS}/workflows/approvals?filter=ai`)).toMatchObject({
      href: `/app/w/${WS}/approvals`,
      params: { filter: 'ai' },
    });
  });

  it('opens every page a notification links to', () => {
    // apps/worker/src/push/README.md, "Kinds of push": each kind's Opens.
    const opens: [string, string][] = [
      [`/app/w/${WS}/inbox/${ID}`, `/app/w/${WS}/inbox`],
      [`/app/w/${WS}?item=${ID}`, `/app/w/${WS}`],
      [`/app/w/${WS}/workflows/approvals?filter=ai`, `/app/w/${WS}/approvals`],
      [`/app/w/${WS}/workflows/approvals`, `/app/w/${WS}/approvals`],
      [`/app/w/${WS}/calendar?appt=${ID}`, `/app/w/${WS}/calendar`],
      [`/app/w/${WS}/leads/${ID}`, `/app/w/${WS}/pipeline`],
      [`/app/w/${WS}/tasks`, `/app/w/${WS}/tasks`],
      [`/app/w/${WS}/money/invoices/${ID}`, `/app/w/${WS}/money`],
    ];
    for (const [path, href] of opens)
      expect(routeFor(path)).toMatchObject({ kind: 'screen', href });
  });

  it('opens the web for the desk work the phone leaves out', () => {
    const webOnly = [
      'workflows',
      'workflows/new',
      `workflows/${ID}`,
      `workflows/runs/${ID}`,
      'workflows/runs?workflow=abc',
      'ai-team',
      'ai-team/activity',
      'knowledge',
      `knowledge/items/${ID}`,
      'knowledge/profile',
      'imports/new',
      `imports/${ID}`,
      'audit',
      'members',
      'settings/workspace',
      'settings/pipelines',
      `settings/calendars/${ID}`,
      'settings/calendars/booking-site',
      'settings/texting',
      'settings/email',
      'settings/payments',
      'settings/payments/products',
      'settings/website-chat',
      'settings/action-center',
      'settings/my-calendar',
      'settings/imports',
      // A page the web gains later: the web has it until the phone does.
      'something-new',
    ];
    for (const page of webOnly)
      expect({ page, target: routeFor(`/app/w/${WS}/${page}`) }).toEqual({
        page,
        target: { kind: 'web', path: `/app/w/${WS}/${page}`, businessId: WS },
      });
    expect(routeFor(`/app/org/${ID}/businesses`)).toEqual({
      kind: 'web',
      path: `/app/org/${ID}/businesses`,
      businessId: null,
    });
    // Every web-only rule is a whole area of the web.
    for (const rule of ROUTES.filter((r) => r.phone === 'web')) expect(rule.deeper).toBe(true);
  });

  it('opens /app itself on the phone’s own choice of business', () => {
    expect(routeFor('/app')).toMatchObject({ kind: 'screen', href: '/app', businessId: null });
  });

  it('never handles a customer’s page, or anything else outside /app', () => {
    const customerPages = [
      '/i/abc123',
      '/e/abc123',
      '/p/abc123',
      '/b/abc123',
      '/book/lonestar',
      '/book/lonestar/ac-tune-up',
      '/m/abc123',
      '/hold/abc123',
      '/w/abc123',
      '/chat/key123',
      '/embed/v1/chat.js',
      '/invite/abc123',
      '/',
      '/sign-in',
      '/delete-account',
      '/apps/w/x',
      `/application/w/${WS}`,
    ];
    for (const path of customerPages) {
      expect({ path, target: routeFor(path) }).toEqual({ path, target: { kind: 'none' } });
      expect(targetOfLink(`https://app.handsfreeos.com${path}`)).toEqual({ kind: 'none' });
      expect(targetOfLink(`handsfreeos://${path.slice(1)}`)).toEqual({ kind: 'none' });
    }
    // A business path whose business isn't an id isn't the app's either.
    expect(routeFor('/app/w/not-an-id/inbox')).toEqual({ kind: 'none' });
  });

  it('reads a notification’s path, an email’s link and the app’s scheme alike', () => {
    const path = `/app/w/${WS}/inbox/${ID}`;
    expect(webPathOf(path)).toBe(path);
    expect(webPathOf(`https://app.handsfreeos.com${path}`)).toBe(path);
    expect(webPathOf(`https://APP.handsfreeos.com${path}?x=1`)).toBe(`${path}?x=1`);
    expect(webPathOf(`handsfreeos://app/w/${WS}/inbox/${ID}`)).toBe(path);
    expect(webPathOf(`handsfreeos:///app/w/${WS}/inbox/${ID}`)).toBe(path);
    // A local stack's web address, in test builds.
    expect(webPathOf(`http://localhost:3000${path}`, ['http://localhost:3000'])).toBe(path);
    // Another site, or a plain http link to HandsFreeOS: not a link the app opens.
    expect(webPathOf(`https://evil.example${path}`)).toBeNull();
    expect(webPathOf(`http://app.handsfreeos.com${path}`)).toBeNull();
    expect(webPathOf(`https://app.handsfreeos.com.evil.example${path}`)).toBeNull();
    expect(webPathOf(`//app.handsfreeos.com${path}`)).toBeNull();
    expect(webPathOf(`exp+handsfreeos://expo-development-client/?url=x`)).toBeNull();
  });

  it('says plainly when a link is for a business the person isn’t part of', () => {
    const link = `https://app.handsfreeos.com/app/w/${OTHER}/inbox/${ID}`;
    expect(decideLink(link, { businessIds: [WS] })).toEqual({
      kind: 'not-yours',
      message: NOT_YOURS,
    });
    expect(
      decideLink(`https://app.handsfreeos.com/app/w/${OTHER}/workflows`, { businessIds: [WS] }),
    ).toEqual({
      kind: 'not-yours',
      message: NOT_YOURS,
    });
    expect(decideLink(link, { businessIds: [WS, OTHER] })).toEqual({
      kind: 'screen',
      href: `/app/w/${OTHER}/inbox`,
      later: expect.any(String),
    });
    expect(decideLink(`handsfreeos://app/w/${WS}/audit`, { businessIds: [WS] })).toEqual({
      kind: 'web',
      path: `/app/w/${WS}/audit`,
    });
    expect(decideLink('https://app.handsfreeos.com/i/abc', { businessIds: [WS] })).toEqual({
      kind: 'ignore',
    });
  });
});

describe('what the phones claim', () => {
  const app = JSON.parse(readFileSync(join(__dirname, '../../../app.json'), 'utf8')) as {
    expo: {
      scheme: string;
      ios: { associatedDomains: string[] };
      android: {
        intentFilters: {
          action: string;
          autoVerify: boolean;
          data: { scheme: string; host: string; pathPrefix?: string }[];
          category: string[];
        }[];
      };
    };
  };

  it('claims only app.handsfreeos.com/app/… on Android, verified, and the same domain on iPhone', () => {
    expect(app.expo.scheme).toBe('handsfreeos');
    expect(app.expo.ios.associatedDomains).toEqual(['applinks:app.handsfreeos.com']);
    expect(app.expo.android.intentFilters).toEqual([
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: 'app.handsfreeos.com', pathPrefix: '/app/' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ]);
  });

  it('never claims a page the web keeps for customers', () => {
    // The web's own list of customer pages, which its apple-app-site-association excludes.
    const source = readFileSync(join(ROOT, 'apps/web/src/lib/app-links.ts'), 'utf8');
    const customerPaths = [...source.matchAll(/path: '(\/[a-z-]+)\/\*'/g)].map((m) => m[1]!);
    expect(customerPaths).toEqual(
      expect.arrayContaining([
        '/i',
        '/e',
        '/p',
        '/book',
        '/m',
        '/hold',
        '/w',
        '/chat',
        '/embed',
        '/invite',
      ]),
    );
    const prefixes = app.expo.android.intentFilters.flatMap((f) => f.data.map((d) => d.pathPrefix));
    for (const path of customerPaths) {
      expect(
        prefixes.some((prefix) => prefix !== undefined && `${path}/x`.startsWith(prefix)),
      ).toBe(false);
      expect(targetOfLink(`https://app.handsfreeos.com${path}/abc`)).toEqual({ kind: 'none' });
    }
  });
});
