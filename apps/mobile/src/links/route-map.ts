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
 *   setup, knowledge, imports, the audit log, business settings, calendar setup, texting, email and payment setup,
 *   members and invitations, and agency pages) opens the web.
 * - **An add-on's pages** (`/a/<id>/…`, which its alerts open) go by what the add-on declares the phone draws
 *   (`ui.phone`): its screen once this build has it (./addon-screens.ts), the web until then and for the rest.
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
}

/**
 * The web's pages under /app/w/<business>, first match wins. Everything a notification or an email links to is here;
 * a page the web gains later opens the web until it's added.
 */
export const ROUTES: readonly Rule[] = [
  { web: '', phone: '', query: ['item'] },
  { web: 'inbox', phone: 'inbox' },
  { web: 'inbox/:conversationId', phone: 'inbox/:conversationId' },
  { web: 'pipeline', phone: 'pipeline', query: ['pipeline'] },
  { web: 'leads/:leadId', phone: 'leads/:leadId' },
  { web: 'customers', phone: 'customers' },
  { web: 'customers/people/:personId', phone: 'customers/people/:personId' },
  { web: 'customers/companies/:companyId', phone: 'customers/companies/:companyId' },
  { web: 'tasks', phone: 'tasks' },
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

/** A web path's parts: `/app/w/<ws>/inbox/<id>?x=1` → path and query. */
function splitQuery(pathAndQuery: string): { path: string; query: Record<string, string> } {
  const hash = pathAndQuery.indexOf('#');
  const withoutHash = hash >= 0 ? pathAndQuery.slice(0, hash) : pathAndQuery;
  const mark = withoutHash.indexOf('?');
  const path = mark >= 0 ? withoutHash.slice(0, mark) : withoutHash;
  const query: Record<string, string> = {};
  if (mark >= 0)
    for (const pair of withoutHash.slice(mark + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = decodePart(eq >= 0 ? pair.slice(0, eq) : pair);
      const value = decodePart(eq >= 0 ? pair.slice(eq + 1) : '');
      if (key && /^[A-Za-z][\w-]{0,40}$/.test(key)) query[key] = value;
    }
  return { path, query };
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
 * build has it, the web naming that screen while the build doesn't, and the web for the rest (its settings, say).
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
    const route = `a/${addonId}${declared.path ? `/${declared.path}` : ''}`;
    const href = screenHref(businessId, phonePathOf(route, params), declared.query, query);
    if (!ADDON_SCREENS.has(route))
      return { kind: 'web', path: pathAndQuery, businessId, later: href };
    return { kind: 'screen', href, businessId, later: null, params };
  }
  return { kind: 'web', path: pathAndQuery, businessId };
}

/** Where a web path opens on the phone. */
export function routeFor(pathAndQuery: string): LinkTarget {
  const { path, query } = splitQuery(pathAndQuery);
  const parts = segments(path);
  if (parts[0] !== 'app') return { kind: 'none' };
  if (parts.length === 1)
    return { kind: 'screen', href: '/app', businessId: null, later: null, params: query };
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
      const params = matchParts(segments(rule.web), rest, query, rule.deeper);
      if (!params) continue;
      if (rule.phone === 'web') return { kind: 'web', path: pathAndQuery, businessId };
      return {
        kind: 'screen',
        href: screenHref(businessId, phonePathOf(rule.phone, params), rule.query, query),
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
