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
 */

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
    }
  /** Not the app's: a customer's page, another site, or nothing it knows. */
  | { readonly kind: 'none' };

interface Rule {
  /** The web's path under /app/w/:ws, with `:name` for a part that varies. */
  readonly web: string;
  /** The phone's screen under /app/w/<business> ('' is Home), or 'web'. */
  readonly phone: string | 'web';
  /** The screen a later step builds for this link. */
  readonly later?: string;
  /** Matches deeper paths too (a whole web-only area). */
  readonly deeper?: boolean;
}

/**
 * The web's pages under /app/w/<business>, first match wins. Everything a notification or an email links to is here;
 * a page the web gains later opens the web until it's added.
 */
export const ROUTES: readonly Rule[] = [
  { web: '', phone: '', later: 'An item on Home (?item=), step 13' },
  { web: 'inbox', phone: 'inbox' },
  { web: 'inbox/:conversationId', phone: 'inbox', later: 'The conversation, step 14' },
  { web: 'pipeline', phone: 'pipeline' },
  { web: 'leads/:leadId', phone: 'pipeline', later: 'The lead, step 15' },
  { web: 'customers', phone: 'customers' },
  { web: 'customers/people/:personId', phone: 'customers', later: 'The customer, step 15' },
  { web: 'customers/companies/:companyId', phone: 'customers', later: 'The company, step 15' },
  { web: 'tasks', phone: 'tasks' },
  { web: 'calendar', phone: 'calendar', later: 'The appointment (?appt=), step 16' },
  { web: 'money', phone: 'money' },
  { web: 'money/invoices', phone: 'money', later: 'Invoices, step 16' },
  { web: 'money/invoices/new', phone: 'money', later: 'A new invoice, step 16' },
  { web: 'money/invoices/:invoiceId', phone: 'money', later: 'The invoice, step 16' },
  { web: 'money/estimates', phone: 'money', later: 'Estimates, step 16' },
  { web: 'money/estimates/new', phone: 'money', later: 'A new estimate, step 16' },
  { web: 'money/estimates/:estimateId', phone: 'money', later: 'The estimate, step 16' },
  { web: 'money/payments', phone: 'money', later: 'Payments, step 16' },
  { web: 'money/plans', phone: 'money', later: 'Plans, step 16' },
  { web: 'money/plans/:subscriptionId', phone: 'money', later: 'The plan, step 16' },
  { web: 'workflows/approvals', phone: 'approvals', later: 'Approvals (?filter=ai), step 13' },
  // Settings → Account on the web is you and your notifications: the phone's own Settings.
  { web: 'settings', phone: 'settings' },
  // The desk work the phone leaves to the web.
  { web: 'settings', phone: 'web', deeper: true },
  { web: 'workflows', phone: 'web', deeper: true },
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

/** Where a web path opens on the phone. */
export function routeFor(pathAndQuery: string): LinkTarget {
  const { path, query } = splitQuery(pathAndQuery);
  const parts = segments(path);
  if (parts[0] !== 'app') return { kind: 'none' };
  if (parts.length === 1)
    return { kind: 'screen', href: '/app', businessId: null, later: null, params: query };
  if (parts[1] === 'w') {
    const businessId = parts[2];
    if (!businessId || !UUID.test(businessId)) return { kind: 'none' };
    const rest = parts.slice(3);
    for (const rule of ROUTES) {
      const pattern = segments(rule.web);
      if (rule.deeper ? rest.length < pattern.length : rest.length !== pattern.length) continue;
      const params: Record<string, string> = { ...query };
      const matched = pattern.every((p, i) => {
        const part = rest[i]!;
        if (p.startsWith(':')) {
          if (!UUID.test(part)) return false;
          params[p.slice(1)] = part;
          return true;
        }
        return p === part;
      });
      if (!matched) continue;
      if (rule.phone === 'web') return { kind: 'web', path: pathAndQuery, businessId };
      return {
        kind: 'screen',
        href: `/app/w/${businessId}${rule.phone ? `/${rule.phone}` : ''}`,
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
