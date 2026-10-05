/**
 * Calling a listing supplier: JSON, a time limit, and what each answer means. A refusal (401, 403) is the account's
 * key, a 400 is a question the supplier can't answer, and anything else that isn't a success is the supplier's
 * trouble, tried again later. Nothing here logs a key or a token.
 */
import { ConnectionRefused } from '../../connections';
import { FeedUnreachable, FeedUnsupported, type FeedFetch } from './types';

/** How long one call to a supplier may take. */
export const FEED_CALL_MS = 20_000;

export async function feedJson(
  fetchImpl: FeedFetch,
  url: string,
  init: RequestInit & { readonly signal: AbortSignal },
  words: { readonly supplier: string; readonly refused: string },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.any([init.signal, AbortSignal.timeout(FEED_CALL_MS)]),
      headers: { accept: 'application/json', ...(init.headers as Record<string, string>) },
    });
  } catch {
    throw new FeedUnreachable(`${words.supplier} didn’t answer. HandsFreeOS tries again shortly.`);
  }
  if (res.status === 401 || res.status === 403) throw new ConnectionRefused(words.refused);
  if (res.status === 400 || res.status === 404 || res.status === 501) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new FeedUnsupported(
      `${words.supplier} couldn’t answer that question${text ? `: ${text.replace(/\s+/g, ' ')}` : '.'}`,
    );
  }
  if (!res.ok)
    throw new FeedUnreachable(
      `${words.supplier} had trouble answering (it said ${res.status}). HandsFreeOS tries again shortly.`,
    );
  try {
    return await res.json();
  } catch {
    throw new FeedUnreachable(`${words.supplier} sent something HandsFreeOS couldn’t read.`);
  }
}

/** A record's field as text, or null. */
export const str = (v: unknown, max = 500): string | null =>
  typeof v === 'string' && v.trim()
    ? v.trim().slice(0, max)
    : typeof v === 'number'
      ? String(v)
      : null;
/** A record's field as a number, or null. */
export const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** A record's object field, or an empty one. */
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** An https address, or null. */
export const httpsUrl = (v: unknown): string | null => {
  const s = str(v, 2000);
  return s && /^https:\/\/[^\s]+$/i.test(s) ? s : null;
};
