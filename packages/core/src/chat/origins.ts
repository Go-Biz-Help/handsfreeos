/**
 * Website chat, browser-safe: turning what people type into the exact sites a widget may show on, and the
 * text colour that reads on a widget's accent. Settings runs these live as people type; chat_widget.create
 * and chat_widget.update run them again before saving (the database checks the result once more).
 */

/** A widget shows on at most this many sites, counting the www versions added automatically. */
export const MAX_CHAT_ORIGINS = 10;

export type ChatOriginResult =
  | {
      readonly ok: true;
      /** The exact origin, like https://acme.com or http://localhost:4191. */
      readonly origin: string;
      /** The www version of a bare domain, or the bare version of a www host; null when there is none. */
      readonly twin: string | null;
    }
  | { readonly ok: false; readonly message: string };

export interface ChatOriginIssue {
  /** Which typed entry it's about; null for the list as a whole. */
  readonly index: number | null;
  readonly message: string;
}

/** Hosts kept on plain http, for trying the widget on your own computer. */
const LOOPBACK = new Set(['localhost', '127.0.0.1']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Second-level endings like co.uk and com.au, so acme.co.uk gets a www twin and shop.acme.com doesn't. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

const refuse = (message: string): ChatOriginResult => ({ ok: false, message });
const LOCAL_HINT = 'To try the chat on your own computer, use http://localhost with its port.';

/** Whether a host is a registrable name (acme.com, acme.co.uk) rather than a subdomain of one. */
function isBareDomain(labels: readonly string[]): boolean {
  return (
    labels.length === 2 ||
    (labels.length === 3 && SECOND_LEVEL.has(labels[1]!) && labels[2]!.length === 2)
  );
}

/**
 * One typed site as an exact origin. Takes a bare domain, a full URL with a path, or upper case, and keeps
 * only the scheme, host and port. Plain http becomes https, except on your own computer (localhost,
 * 127.0.0.1), which stays http for testing. Number addresses and one-word hosts are refused, in plain words.
 */
export function normalizeChatOrigin(raw: string): ChatOriginResult {
  const typed = raw.trim();
  if (!typed) return refuse('Type the website, like acme.com.');
  if (typed.includes('*'))
    return refuse('Wildcards like *.acme.com don’t work here. List each site instead.');
  const typedScheme = HAS_SCHEME.test(typed);
  let url: URL;
  try {
    url = new URL(typedScheme ? typed : `https://${typed}`);
  } catch {
    return refuse(`“${typed}” doesn’t look like a web address. Type it like acme.com.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return refuse('Use your website’s address, like https://acme.com.');
  const host = url.hostname.replace(/\.$/, '');
  const port = url.port ? `:${url.port}` : '';
  if (LOOPBACK.has(host)) {
    // Your own computer: plain http (what a local dev server speaks), never https.
    if (url.protocol === 'https:' && typedScheme)
      return refuse(`For testing on your own computer, use http://${host}${port}.`);
    return { ok: true, origin: `http://${host}${port}`, twin: null };
  }
  if (host.startsWith('[') || IPV4.test(host))
    return refuse(`Use your website’s name, like acme.com, not a number address. ${LOCAL_HINT}`);
  const labels = host.split('.');
  if (labels.length < 2)
    return refuse(`“${host}” isn’t a full web address. Add its ending, like ${host}.com.`);
  if (host.length > 253 || !labels.every((l) => LABEL.test(l)))
    return refuse('Web addresses use letters, numbers, dots and dashes, like acme.com.');
  // Every real site is https; http:// typed from habit is taken to mean the same site.
  const origin = `https://${host}${port}`;
  let twin: string | null = null;
  if (labels[0] === 'www' && labels.length >= 3)
    twin = `https://${labels.slice(1).join('.')}${port}`;
  else if (labels[0] !== 'www' && isBareDomain(labels)) twin = `https://www.${host}${port}`;
  return { ok: true, origin, twin };
}

/**
 * Every typed site as exact origins, each followed by its www (or bare) twin, without repeats. Blank entries
 * are skipped. Refusals name the entry they're about; the list itself needs 1 to MAX_CHAT_ORIGINS sites once
 * the twins are in.
 */
export function normalizeChatOrigins(inputs: readonly string[]): {
  readonly origins: string[];
  readonly issues: ChatOriginIssue[];
} {
  const origins: string[] = [];
  const issues: ChatOriginIssue[] = [];
  const add = (o: string) => {
    if (!origins.includes(o)) origins.push(o);
  };
  inputs.forEach((raw, index) => {
    if (!raw.trim()) return;
    const r = normalizeChatOrigin(raw);
    if (!r.ok) issues.push({ index, message: r.message });
    else {
      add(r.origin);
      if (r.twin) add(r.twin);
    }
  });
  if (issues.length === 0 && origins.length === 0)
    issues.push({ index: null, message: 'Add the website the chat goes on, like acme.com.' });
  if (origins.length > MAX_CHAT_ORIGINS)
    issues.push({
      index: null,
      message: `A chat can show on up to ${MAX_CHAT_ORIGINS} sites, counting the www versions added for you. This list makes ${origins.length}.`,
    });
  return { origins, issues };
}

/** A widget's name in lists: the first site it shows on ("lonestarhvac.com"). */
/** What a chat is called: the name the business gave it, or else its first site. */
export const chatShownName = (
  name: string | null | undefined,
  origins: readonly string[],
): string => name?.trim() || chatWidgetName(origins);

export function chatWidgetName(origins: readonly string[]): string {
  const first = origins[0];
  if (!first) return 'Website chat';
  try {
    return new URL(first).host;
  } catch {
    return first;
  }
}

export const CHAT_TEXT_ON_DARK = '#ffffff';
export const CHAT_TEXT_ON_LIGHT = '#111111';

/** WCAG relative luminance of a #rrggbb (or #rgb) colour; null when it isn't one. */
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two colours (1 to 21); 1 when either isn't a colour. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return 1;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The text colour for labels on a widget's accent (its button, the visitor's bubbles): white or near-black,
 * whichever has more WCAG contrast. White when the accent isn't a colour.
 */
export function readableTextOn(
  accentHex: string,
): typeof CHAT_TEXT_ON_DARK | typeof CHAT_TEXT_ON_LIGHT {
  if (luminance(accentHex) === null) return CHAT_TEXT_ON_DARK;
  return contrastRatio(accentHex, CHAT_TEXT_ON_DARK) >= contrastRatio(accentHex, CHAT_TEXT_ON_LIGHT)
    ? CHAT_TEXT_ON_DARK
    : CHAT_TEXT_ON_LIGHT;
}
