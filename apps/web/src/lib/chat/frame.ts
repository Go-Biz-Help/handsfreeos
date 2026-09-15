/**
 * The chat window's frame rule. /chat/<key> runs inside businesses' own sites, so its response carries
 * `Content-Security-Policy: frame-ancestors 'self' <the site it's on>`, and browsers refuse to show it anywhere
 * else.
 *
 * The loader passes the page's origin (`o`) and path (`p`) in the window's address. The origin is written into
 * the rule only once the worker confirms it's one of this widget's sites (GET config?origin=, kept for a minute
 * in production), so the rule never names more than the one site the window is on. A page that lies about `o`
 * gains nothing: the browser compares the rule with the real page and refuses. So once the window is showing,
 * `o` is known to be its page's origin, and the window can talk to it (postMessage) and report it to the worker.
 *
 * The preview page (a manager trying the chat on our own site) passes `preview=<workspace id>` with our own
 * origin: then the rule is 'self' alone. Unknown keys, paused widgets and refused sites keep 'self' alone too.
 *
 * proxy.ts runs this for /chat/* instead of its session work, and hands the answer to the page in a request
 * header (read with chatWindowFrom), so the page doesn't ask the worker a second time.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { CHAT_KEY_RE, exactOrigin, lookupChat, type ChatLookup } from './lookup';

export const CHAT_WINDOW_HEADER = 'x-hfos-chat-window';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatWindowContext {
  readonly key: string;
  /** The page the window is on, once the worker confirmed it's one of the widget's sites; otherwise null. */
  readonly origin: string | null;
  /** That page's path, like /services/ac-repair. */
  readonly path: string | null;
  /** The preview page's workspace: a signed-in manager trying the chat on our own site. Null for visitors. */
  readonly preview: string | null;
  readonly lookup: ChatLookup;
}

/** What the chat window at this address may do, and the widget's public settings. */
export async function chatWindowContext(url: URL): Promise<ChatWindowContext> {
  const key = decodeURIComponent(url.pathname.split('/')[2] ?? '');
  const params = url.searchParams;
  const rawPath = params.get('p');
  const path = rawPath && rawPath.startsWith('/') && rawPath.length <= 2000 ? rawPath : null;
  const host = exactOrigin(params.get('o'));
  const asked = params.get('preview');
  const preview = asked && UUID.test(asked) ? asked.toLowerCase() : null;
  const none = (lookup: ChatLookup): ChatWindowContext => ({
    key,
    origin: null,
    path,
    preview: null,
    lookup,
  });
  if (!CHAT_KEY_RE.test(key)) return none({ state: 'missing' });
  if (preview) {
    // Only ever on our own site (the rule below allows nothing else), and never checked against the widget's.
    if (host !== url.origin) return none({ state: 'refused' });
    return { key, origin: null, path, preview, lookup: await lookupChat(key, null) };
  }
  // Opened on its own, not from a site: nothing to chat from.
  if (!host) return none({ state: 'refused' });
  const lookup = await lookupChat(key, host);
  return { key, origin: lookup.state === 'ok' ? host : null, path, preview: null, lookup };
}

/** Our own site, plus the page it's on when that's one of the widget's sites. */
export const frameAncestors = (ctx: Pick<ChatWindowContext, 'origin'>): string =>
  `frame-ancestors 'self'${ctx.origin ? ` ${ctx.origin}` : ''}`;

/** proxy.ts: the frame rule on the response, and the answer handed to the page. */
export async function chatWindowProxy(request: NextRequest): Promise<NextResponse> {
  const ctx = await chatWindowContext(request.nextUrl);
  const headers = new Headers(request.headers);
  // Always replaced, never passed through from the visitor.
  headers.set(CHAT_WINDOW_HEADER, encodeURIComponent(JSON.stringify(ctx)));
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', frameAncestors(ctx));
  return response;
}

/** The page's copy of what proxy.ts worked out; null when the header is missing or unreadable. */
export function chatWindowFrom(raw: string | null): ChatWindowContext | null {
  if (!raw) return null;
  try {
    const ctx = JSON.parse(decodeURIComponent(raw)) as ChatWindowContext;
    return typeof ctx?.key === 'string' && ctx.lookup ? ctx : null;
  } catch {
    return null;
  }
}
