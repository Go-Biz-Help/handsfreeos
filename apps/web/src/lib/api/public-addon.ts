/**
 * An add-on's public pages' calls to the worker (`/public/addon/:site/…`, Real Estate round three). No token: a visitor
 * is signed in to nothing. The page's look-up is read on the server; a change (leaving a name, signing in at an open
 * house) is sent from the visitor's own browser, so the worker's per-address limits count per visitor.
 */
import { notFound } from 'next/navigation';
import { publicEnv } from '../env';
import { ApiError } from './errors';

export interface PublicBusiness {
  readonly name: string;
  readonly timeZone: string;
}

/** A public look-up's answer, with the business whose page it is and the bot check its forms need. */
export interface PublicAddonAnswer<T = unknown> {
  readonly result: T;
  readonly business: PublicBusiness;
  /** Cloudflare Turnstile; a null site key means this app's own (NEXT_PUBLIC_TURNSTILE_SITE_KEY). */
  readonly botCheck?: { readonly siteKey: string | null } | null;
}

interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly rule?: string;
    readonly details?: unknown;
  };
}

const seg = encodeURIComponent;

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, {
      cache: 'no-store',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'internal', 'We couldn’t reach this page. Check your connection.');
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ErrorBody)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.rule,
      err?.details,
    );
  }
  return json as T;
}

/** A public look-up for the page's server; the 404 page when the worker says there's nothing at that address. */
export async function publicAddonPage<T>(
  site: string,
  query: string,
  input: Record<string, unknown>,
): Promise<PublicAddonAnswer<T>> {
  try {
    return await post<PublicAddonAnswer<T>>(`/public/addon/${seg(site)}/query/${seg(query)}`, {
      input,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

/** A visitor's change, from their browser: the honeypot and the bot check's token go with it. */
export const publicAddonCommand = <T>(
  site: string,
  command: string,
  body: {
    readonly input: Record<string, unknown>;
    readonly website?: string;
    readonly turnstileToken?: string;
  },
) => post<PublicAddonAnswer<T>>(`/public/addon/${seg(site)}/command/${seg(command)}`, body);
