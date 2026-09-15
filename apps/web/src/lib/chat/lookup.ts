/**
 * The website chat's public settings, looked up on our own server: for the loader (/embed/v1/<key>.js) and for
 * the chat window's frame rule (proxy.ts). It asks the worker's GET /public/chat/<key>/config, which answers 404
 * for an unknown key and 403 when the site asking isn't one of the widget's.
 *
 * Every lookup comes from this server's address, and the worker limits config reads per address, so answers are
 * kept for a minute in production. Development never keeps them, so a pause or a new key shows at once, and neither
 * does a production build under Playwright (CHAT_LOOKUP_CACHE_MS=0).
 */
import { chatAskForOf, readableTextOn, type ChatAskFor } from '@hfos/core';
import { publicEnv } from '../env';

export interface ChatConfig {
  readonly business: { readonly name: string };
  /** The AI teammate that answers here: its name, nothing else. */
  readonly teammate: { readonly name: string } | null;
  readonly greeting: string | null;
  readonly awayMessage: string | null;
  /** Nobody is answering right now: the AI teammate isn't working and the business is closed. */
  readonly away: boolean;
  readonly look: {
    readonly launcherLabel: string;
    readonly accentColor: string;
    /** White or near-black, whichever reads better on the accent. */
    readonly textColor: string;
    readonly position: 'left' | 'right';
  };
  readonly askFor: ChatAskFor;
  /** The texts box's wording (the booking page's, for a chat); null when the widget doesn't offer it. */
  readonly smsConsent: { readonly text: string } | null;
  /** Cloudflare Turnstile; a null site key means this app's own (NEXT_PUBLIC_TURNSTILE_SITE_KEY). */
  readonly humanCheck: { readonly siteKey: string | null } | null;
  readonly paused: boolean;
  readonly maxMessageLength: number;
}

export type ChatLookup =
  | { readonly state: 'ok'; readonly config: ChatConfig }
  /** No widget has this key: it never did, or the key was replaced. */
  | { readonly state: 'missing' }
  /** The site asking isn't one of the widget's. */
  | { readonly state: 'refused' }
  /** The worker didn't answer. */
  | { readonly state: 'unreachable' };

/** A widget's public key, as the snippet carries it. */
export const CHAT_KEY_RE = /^wk_[A-Za-z0-9]{20}$/;

const DEFAULT_ACCENT = '#2d69d8';
const KEEP_MS = (() => {
  const set = Number(process.env.CHAT_LOOKUP_CACHE_MS);
  if (process.env.CHAT_LOOKUP_CACHE_MS && Number.isFinite(set) && set >= 0) return set;
  return process.env.NODE_ENV === 'production' ? 60_000 : 0;
})();
const MAX_KEPT = 500;
const kept = new Map<string, { readonly until: number; readonly value: ChatLookup }>();

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The worker's answer, read defensively: anything it doesn't say falls back to the widget defaults. */
export function parseChatConfig(raw: unknown): ChatConfig | null {
  if (!isObj(raw) || !isObj(raw.business) || !isObj(raw.look)) return null;
  const look = raw.look;
  const accent =
    typeof look.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(look.accentColor)
      ? look.accentColor.toLowerCase()
      : DEFAULT_ACCENT;
  const teammateName = isObj(raw.teammate) ? text(raw.teammate.name) : null;
  const consent = isObj(raw.smsConsent) ? text(raw.smsConsent.text) : null;
  const check = isObj(raw.humanCheck) ? raw.humanCheck : null;
  const max = typeof raw.maxMessageLength === 'number' ? raw.maxMessageLength : 1000;
  return {
    business: { name: text(raw.business.name) ?? 'Chat' },
    teammate: teammateName ? { name: teammateName } : null,
    greeting: text(raw.greeting),
    awayMessage: text(raw.awayMessage),
    away: raw.away === true,
    look: {
      launcherLabel: text(look.launcherLabel) ?? 'Chat with us',
      accentColor: accent,
      textColor: readableTextOn(accent),
      position: look.position === 'left' ? 'left' : 'right',
    },
    askFor: chatAskForOf(raw.askFor),
    smsConsent: consent ? { text: consent } : null,
    humanCheck: check ? { siteKey: text(check.siteKey) } : null,
    paused: raw.paused === true,
    maxMessageLength: Math.max(1, Math.min(1000, Math.floor(max))),
  };
}

async function ask(key: string, origin: string | null): Promise<ChatLookup> {
  const query = origin ? `?origin=${encodeURIComponent(origin)}` : '';
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}/public/chat/${key}/config${query}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { state: 'unreachable' };
  }
  if (res.status === 404) return { state: 'missing' };
  if (res.status === 403) return { state: 'refused' };
  if (!res.ok) return { state: 'unreachable' };
  const config = parseChatConfig(await res.json().catch(() => null));
  return config ? { state: 'ok', config } : { state: 'unreachable' };
}

/**
 * A widget's public settings. With `origin`, the worker also checks the site is one of the widget's (a 403 is
 * `refused`). Answers other than `unreachable` are kept for a minute in production.
 */
export async function lookupChat(key: string, origin: string | null): Promise<ChatLookup> {
  if (!CHAT_KEY_RE.test(key)) return { state: 'missing' };
  const id = `${key} ${origin ?? ''}`;
  const hit = kept.get(id);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await ask(key, origin);
  if (KEEP_MS > 0 && value.state !== 'unreachable') {
    if (kept.size >= MAX_KEPT) {
      const oldest = kept.keys().next().value;
      if (oldest !== undefined) kept.delete(oldest);
    }
    kept.set(id, { until: Date.now() + KEEP_MS, value });
  }
  return value;
}

/** A page's origin exactly as a browser writes it (https://www.acme.com, http://127.0.0.1:4191), or null. */
export function exactOrigin(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 300) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}
