/**
 * Links that open the app (M10, "Links that open the app"): the one map from the web's addresses to the phone's
 * screens. A notification's `path`, the links in HandsFreeOS's emails (`https://app.handsfreeos.com/app/…`) and the
 * app's own `handsfreeos://` scheme all go through it.
 *
 * - **Only /app/… is the app's.** Every page a customer opens (an invoice `/i`, an estimate `/e`, a plan `/p`,
 *   booking `/book`, managing a booking `/m`, a held time `/hold`, a waitlist offer `/w`, the website chat `/chat` and
 *   `/embed`, an invitation `/invite`) and anything else outside /app opens nothing here: the phones never claim them
 *   (app.json), and one that reaches the app some other way is left alone.
 * - **A screen the phone has opens there.** One a later step builds opens its tab or list until then, and `later`
 *   names it, so steps 13–16 can fill them in without changing a link.
 * - **The desk work the phone leaves to the web** (the plan's web-only areas: workflow editors, the AI teammate's
 *   settings, knowledge, imports, the audit log, business settings, calendar setup, texting, email and payment setup,
 *   members and invitations, and agency pages) opens the web. The AI teammate's quick setup (/ai-team/setup) is the
 *   phone's too, so a link to it opens the same screens here.
 * - **An add-on's pages** (`/a/<id>/…`, which its alerts open) go by what the add-on declares the phone draws
 *   (`ui.phone`): its screen once this build has it (./addon-screens.ts), the web until then and for the rest.
 * - **An extension sign-in** (`/app/extension-sign-in/<id>`, its push) opens the screen that asks for the number the
 *   extension shows. It belongs to no business.
 * - **Search everything** (`/search#q=…&kind=…`): the web keeps what's typed after `#` (decision 37), and only a rule
 *   that names a pair after `#` reads it; the phone's search keeps it on its own address. A result opens through this
 *   map too: a business's own kinds of records have no screen here, so they open the web.
 * - **The support desk** (the web's /admin, M13) is the one place outside /app the app opens: a new-ticket
 *   notification links to `/admin/tickets/<id>`. Its pages open the phone's Support desk (/app/admin), which asks
 *   HandsFreeOS whether the person works there. The phones don't claim /admin in app.json, so an email's /admin link
 *   still opens the browser.
 */
import { BUILT_ADDONS } from '@hfos/core';
import { ADDON_SCREENS } from './addon-screens';

/** The web app's host: the only one whose links open the app. */
export const APP_LINK_HOST = 'app.handsfreeos.com';

/** The app's own scheme (app.json). */
export const APP_SCHEME = 'handsfreeos';

/** Where a link goes on the phone. */
export type LinkTarget =
  | {
      readonly kind: 'screen';
      /** The phone's route: `/app`, or `/app/w/<business>/…`. */
      readonly href: string;
      /** The business it's in, or null for `/app` itself. */
      readonly businessId: string | null;
      /** The screen a later step builds for it, while the link opens its tab or list. */
      readonly later: string | null;
      /** What the web path named (`conversationId`, `leadId`…) and its query (`item`, `appt`, `filter`). */
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'web';
      /** The web path to open in the browser, query included. */
      readonly path: string;
      readonly businessId: string | null;
      /** An add-on's page the phone will draw: the screen this opens once the build has it. */
      readonly later?: string;
    }
  /** Not the app's: a customer's page, another site, or nothing it knows. */
  | { readonly kind: 'none' };

interface Rule {
  /** The web's path under /app/w/:ws, with `:name` for a part that varies. */
  readonly web: string;
  /**
   * The phone's screen under /app/w/<business> ('' is Home), or 'web'. A `:name` in it is filled with the part of the
   * web path of the same name (`inbox/:conversationId`).
   */
  readonly phone: string | 'web';
  /** The screen a later step builds for this link. */
  readonly later?: string;
  /** Matches deeper paths too (a whole web-only area). */
  readonly deeper?: boolean;
  /** Query parameters the phone's screen reads too (Home's `?item=`), kept on its address. */
  readonly query?: readonly string[];
  /**
   * Pairs after `#` the phone's screen reads, kept on its address as query parameters. The web keeps what's typed into
   * search there (`/search#q=…&kind=…`, decision 37) so it never reaches a server; on the phone it stays on the phone.
   */
  readonly fragment?: readonly string[];
}

/**
 * The web's pages under /app/w/<business>, first match wins. Everything a notification or an email links to is here;
 * a page the web gains later opens the web until it's added.
 */
export const ROUTES: readonly Rule[] = [
  { web: '', phone: '', query: ['item'] },
  { web: 'inbox', phone: 'inbox' },
  // A search result opens the thread at its message (`?message=&at=`), which rings once it's in the copy.
  { web: 'inbox/:conversationId', phone: 'inbox/:conversationId', query: ['message', 'at'] },
  { web: 'pipeline', phone: 'pipeline', query: ['pipeline'] },
  { web: 'leads/:leadId', phone: 'leads/:leadId' },
  { web: 'customers', phone: 'customers' },
  // A note found by search (`?activity=`) opens its customer; Text (`?compose=sms`) opens their text thread.
  {
    web: 'customers/people/:personId',
    phone: 'customers/people/:personId',
    query: ['activity', 'compose'],
  },
  { web: 'customers/companies/:companyId', phone: 'customers/companies/:companyId' },
  // A task found by search (`?task=`) opens from the Tasks screen once it's in the copy.
  { web: 'tasks', phone: 'tasks', query: ['task'] },
  // Forms the phone fills in, and one response's answers (asked of HandsFreeOS: answers never sync, M17).
  { web: 'forms', phone: 'forms' },
  { web: 'forms/:formId', phone: 'forms/:formId' },
  { web: 'forms/:formId/answers/:responseId', phone: 'forms/:formId/answers/:responseId' },
  // Search everything, by address: what's typed is after `#` on the web, and a query parameter on the phone.
  { web: 'search', phone: 'search', fragment: ['q', 'kind'] },
  // The Calendar tab opens the appointment itself when the link names one (?appt=<id>).
  { web: 'calendar', phone: 'calendar', query: ['appt', 'date'] },
  { web: 'money', phone: 'money' },
  { web: 'money/invoices', phone: 'money' },
  { web: 'money/invoices/:invoiceId', phone: 'money/invoices/:invoiceId' },
  { web: 'money/estimates', phone: 'money' },
  { web: 'money/estimates/:estimateId', phone: 'money/estimates/:estimateId' },
  { web: 'money/payments', phone: 'money' },
  { web: 'money/plans', phone: 'money' },
  // Raising a document (`…/new`) and one plan's own page have no rule, so the map's own fallback opens the web:
  // making and editing documents, and managing a plan, are the web's in M10.
  { web: 'workflows/approvals', phone: 'approvals', query: ['filter'] },
  // Ask HandsFreeOS. The web has no page of its own for it (it's a panel over whatever page you're on), so this is
  // for the app's own links — `handsfreeos://app/w/<business>/assistant` opens the Assistant full screen.
  { web: 'assistant', phone: 'ask' },
  // Settings → Account on the web is you and your notifications: the phone's own Settings.
  { web: 'settings', phone: 'settings' },
  // Settings → Usage & balance: the phone has it too, so the wallet's emails, its notifications and the Action
  // Center's three balance cards open the Balance screen rather than a browser. `?card=` comes with it: it is
  // how the payment provider sends somebody back to the app once they have typed a card.
  { web: 'settings/usage', phone: 'settings/usage', query: ['card'] },
  // Settings → Main offer: the phone has its Review step and the live version too
  // (HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md), so a link to the page opens it here. The builder
  // (`main-offer/build`) stays the web's.
  { web: 'settings/main-offer', phone: 'settings/main-offer' },
  // Add-ons (0108): owners and admins manage them on the phone too, so a link to the page opens the phone's own
  // screen, and `?addon=` (the web's link to one add-on) opens that add-on's. Anyone else who follows one is told who
  // looks after add-ons. It was a Settings tab once, and links sent then still open it.
  { web: 'add-ons', phone: 'add-ons', query: ['addon'] },
  { web: 'settings/add-ons', phone: 'add-ons', query: ['addon'] },
  // Ideas, the roadmap and What's new (0102): the phone has all four, so a link to any of them opens it here.
  { web: 'ideas', phone: 'ideas' },
  { web: 'ideas/roadmap', phone: 'ideas/roadmap' },
  { web: 'ideas/whats-new', phone: 'ideas/whats-new' },
  { web: 'ideas/:ideaId', phone: 'ideas/:ideaId' },
  // The AI teammate's quick setup: the same screens on the phone, and `?at=try` opens its test chat after Save.
  { web: 'ai-team/setup', phone: 'ai-setup', query: ['at'] },
  // The desk work the phone leaves to the web.
  { web: 'settings', phone: 'web', deeper: true },
  { web: 'workflows', phone: 'web', deeper: true },
  { web: 'campaigns', phone: 'web', deeper: true },
  { web: 'ai-team', phone: 'web', deeper: true },
  { web: 'knowledge', phone: 'web', deeper: true },
  { web: 'imports', phone: 'web', deeper: true },
  { web: 'audit', phone: 'web', deeper: true },
  { web: 'members', phone: 'web', deeper: true },
];

const segments = (path: string) => path.split('/').filter(Boolean);

/** `a=1&b=2`'s pairs, keys that aren't plain words left out. */
function pairsOf(text: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodePart(eq >= 0 ? pair.slice(0, eq) : pair);
    const value = decodePart(eq >= 0 ? pair.slice(eq + 1) : '');
    if (key && /^[A-Za-z][\w-]{0,40}$/.test(key)) pairs[key] = value;
  }
  return pairs;
}

/**
 * A web path's parts: `/app/w/<ws>/inbox/<id>?x=1` → path and query, and the pairs after `#` (`/search#q=…`), which
 * only a rule that names them reads.
 */
function splitQuery(pathAndQuery: string): {
  path: string;
  query: Record<string, string>;
  fragment: Record<string, string>;
} {
  const hash = pathAndQuery.indexOf('#');
  const withoutHash = hash >= 0 ? pathAndQuery.slice(0, hash) : pathAndQuery;
  const mark = withoutHash.indexOf('?');
  const path = mark >= 0 ? withoutHash.slice(0, mark) : withoutHash;
  return {
    path,
    query: mark >= 0 ? pairsOf(withoutHash.slice(mark + 1)) : {},
    fragment: hash >= 0 ? pairsOf(pathAndQuery.slice(hash + 1)) : {},
  };
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/**
 * The web path a link names, or null when it isn't a link to HandsFreeOS's web app or the app's scheme:
 * - `/app/w/<ws>/inbox/<id>` (a notification's `path`) as it is;
 * - `https://app.handsfreeos.com/app/…`, and the build's own web address (a local stack's, in test builds);
 * - `handsfreeos://app/w/<ws>/…` and `handsfreeos:///app/w/<ws>/…`.
 */
export function webPathOf(link: string, webOrigins: readonly string[] = []): string | null {
  const value = link.trim();
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(value);
  if (!scheme) return null;
  const [, protocol, authority, rest] = scheme as unknown as [string, string, string, string];
  const tail = rest.startsWith('/') || rest === '' ? rest : `/${rest}`;
  if (protocol.toLowerCase() === APP_SCHEME)
    return authority ? `/${authority}${tail === '/' ? '' : tail}` : tail || '/';
  if (!/^https?$/i.test(protocol)) return null;
  const origin = `${protocol.toLowerCase()}://${authority.toLowerCase()}`;
  const allowed = [
    `https://${APP_LINK_HOST}`,
    ...webOrigins.map((o) => o.replace(/\/+$/, '').toLowerCase()),
  ];
  return allowed.includes(origin) ? tail || '/' : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A rule's phone path with each `:name` filled from what the web path named (`inbox/:conversationId` → `inbox/<id>`). */
export function phonePathOf(phone: string, params: Readonly<Record<string, string>>): string {
  return segments(phone)
    .map((part) => (part.startsWith(':') ? encodeURIComponent(params[part.slice(1)] ?? '') : part))
    .join('/');
}

/** What a web path's parts name when they fit a pattern (`inbox/:conversationId`), query included; null when not. */
function matchParts(
  pattern: readonly string[],
  parts: readonly string[],
  query: Readonly<Record<string, string>>,
  deeper = false,
): Record<string, string> | null {
  if (deeper ? parts.length < pattern.length : parts.length !== pattern.length) return null;
  const params: Record<string, string> = { ...query };
  const matched = pattern.every((p, i) => {
    const part = parts[i]!;
    if (p.startsWith(':')) {
      if (!UUID.test(part)) return false;
      params[p.slice(1)] = part;
      return true;
    }
    return p === part;
  });
  return matched ? params : null;
}

/** A screen's address: the business, the screen, and the query parameters it reads. */
function screenHref(
  businessId: string,
  screen: string,
  keys: readonly string[] | undefined,
  query: Readonly<Record<string, string>>,
): string {
  const kept = (keys ?? [])
    .filter((key) => query[key])
    .map((key) => `${key}=${encodeURIComponent(query[key]!)}`)
    .join('&');
  return `/app/w/${businessId}${screen ? `/${screen}` : ''}${kept ? `?${kept}` : ''}`;
}

/**
 * An add-on's page (`a/<id>/…`): the screen for it when the add-on declares the phone draws it (`ui.phone`) and this
 * build has it, the web naming that screen while the build doesn't, and the web for the rest (its settings, say). A
 * query value the add-on lists under `web` (a tab with too much to look through on a phone) opens the web too.
 */
function addonTarget(
  businessId: string,
  rest: readonly string[],
  query: Readonly<Record<string, string>>,
  pathAndQuery: string,
): LinkTarget {
  const [addonId, ...page] = rest;
  const manifest = BUILT_ADDONS.find((m) => m.id === addonId);
  for (const declared of manifest?.ui?.phone ?? []) {
    const params = matchParts(segments(declared.path), page, query);
    if (!params) continue;
    // A tab of the page the add-on leaves to the web (Social Outreach's `?view=activity`) opens there.
    const webOnly = Object.entries(declared.web ?? {}).some(
      ([key, values]) => query[key] !== undefined && values.includes(query[key]),
    );
    if (webOnly) return { kind: 'web', path: pathAndQuery, businessId };
    const route = `a/${addonId}${declared.path ? `/${declared.path}` : ''}`;
    const href = screenHref(businessId, phonePathOf(route, params), declared.query, query);
    if (!ADDON_SCREENS.has(route))
      return { kind: 'web', path: pathAndQuery, businessId, later: href };
    return { kind: 'screen', href, businessId, later: null, params };
  }
  return { kind: 'web', path: pathAndQuery, businessId };
}

/** The support desk's pages the phone has, under /admin: a section, or one ticket, business or idea. */
const DESK_PAGES = [
  'tickets',
  'tickets/:id',
  'ideas',
  'ideas/:id',
  'ideas/whats-new',
  'ideas/areas',
  'add-ons',
  'businesses',
  'businesses/:id',
  'getting-started',
  'health',
  'problems',
  'rates',
  'founding',
  'replies',
  'staff',
];

/** Where one of the support desk's web paths opens: the phone's Support desk, or the web for a page it hasn't got. */
function deskRoute(rest: readonly string[], query: Readonly<Record<string, string>>): LinkTarget {
  const known =
    rest.length === 0 ||
    DESK_PAGES.some((page) => {
      const pattern = segments(page);
      return (
        pattern.length === rest.length &&
        pattern.every((p, i) => (p === ':id' ? UUID.test(rest[i]!) : p === rest[i]))
      );
    });
  // The page's own settings go with it (Health's `?hours=`, the directory's `?sort=&q=`), as the screens read them.
  const search = Object.entries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const tail = `${rest.length ? `/${rest.map(encodeURIComponent).join('/')}` : ''}${search ? `?${search}` : ''}`;
  // A desk page the phone hasn't got opens the web's own, at /admin, whichever address the link used.
  if (!known) return { kind: 'web', path: `/admin${tail}`, businessId: null };
  return {
    kind: 'screen',
    href: `/app/admin${tail}`,
    businessId: null,
    later: null,
    params: query,
  };
}

/** Where a web path opens on the phone. */
export function routeFor(pathAndQuery: string): LinkTarget {
  const { path, query, fragment } = splitQuery(pathAndQuery);
  const parts = segments(path);
  if (parts[0] === 'admin') return deskRoute(parts.slice(1), query);
  if (parts[0] !== 'app') return { kind: 'none' };
  if (parts[1] === 'admin') return deskRoute(parts.slice(2), query);
  if (parts.length === 1)
    return { kind: 'screen', href: '/app', businessId: null, later: null, params: query };
  // An extension sign-in waiting for the person's number (its push, 20261027002910): about no business.
  if (parts[1] === 'extension-sign-in' && parts.length === 3 && UUID.test(parts[2]!))
    return {
      kind: 'screen',
      href: `/app/extension-sign-in/${parts[2]!}`,
      businessId: null,
      later: null,
      params: { ...query, requestId: parts[2]! },
    };
  // An email about an idea (`/app/ideas/<id>`) names no business, since the board is every business's: it opens in
  // the one the phone had open last (app/ideas/[ideaId].tsx), as the web's own page does.
  if (parts[1] === 'ideas' && parts.length === 3 && UUID.test(parts[2]!))
    return {
      kind: 'screen',
      href: `/app/ideas/${parts[2]!}`,
      businessId: null,
      later: null,
      params: { ...query, ideaId: parts[2]! },
    };
  if (parts[1] === 'w') {
    const businessId = parts[2];
    if (!businessId || !UUID.test(businessId)) return { kind: 'none' };
    const rest = parts.slice(3);
    if (rest[0] === 'a') return addonTarget(businessId, rest.slice(1), query, pathAndQuery);
    for (const rule of ROUTES) {
      // The pairs after `#` count only for a rule that names them, and win over the query's.
      const named = Object.fromEntries(
        (rule.fragment ?? [])
          .filter((key) => fragment[key] !== undefined)
          .map((key) => [key, fragment[key]!]),
      );
      const params = matchParts(segments(rule.web), rest, { ...query, ...named }, rule.deeper);
      if (!params) continue;
      if (rule.phone === 'web') return { kind: 'web', path: pathAndQuery, businessId };
      return {
        kind: 'screen',
        href: screenHref(
          businessId,
          phonePathOf(rule.phone, params),
          [...(rule.query ?? []), ...(rule.fragment ?? [])],
          { ...query, ...named },
        ),
        businessId,
        later: rule.later ?? null,
        params,
      };
    }
    // A page of the business the phone doesn't know: the web has it.
    return { kind: 'web', path: pathAndQuery, businessId };
  }
  // Agency pages (/app/org/…) and anything else under /app: the web's.
  return { kind: 'web', path: pathAndQuery, businessId: null };
}

/** Where a link opens: its web path through the map, or nothing when it isn't one of HandsFreeOS's. */
export function targetOfLink(link: string, webOrigins: readonly string[] = []): LinkTarget {
  const path = webPathOf(link, webOrigins);
  return path === null ? { kind: 'none' } : routeFor(path);
}
