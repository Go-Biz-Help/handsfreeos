/**
 * Calling an e-signature service: a time limit, and what each answer means. A refusal (401) is the sign-in, which
 * is renewed or asked for again; anything else that isn't a success is the service's trouble, tried again later,
 * with its own words when it gave some. Nothing here logs a token.
 */
import { ConnectionRefused } from '../../connections';
import { EsignUnreachable, type EsignFetch } from './types';

/** How long one call may take: uploads and downloads of a contract included. */
export const ESIGN_CALL_MS = 60_000;

async function call(
  fetchImpl: EsignFetch,
  url: string,
  init: RequestInit & { readonly signal: AbortSignal },
  words: { readonly service: string },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.any([init.signal, AbortSignal.timeout(ESIGN_CALL_MS)]),
    });
  } catch {
    throw new EsignUnreachable(`${words.service} didn’t answer. HandsFreeOS tries again shortly.`);
  }
  if (res.status === 401)
    throw new ConnectionRefused(
      `${words.service} turned the sign-in down. Someone who runs the deal settings can sign in again under Real Estate → Settings → Connections.`,
    );
  if (!res.ok) {
    const said = await serviceWords(res);
    throw new EsignUnreachable(
      said
        ? `${words.service} said: ${said}`
        : `${words.service} had trouble with that (it said ${res.status}). HandsFreeOS tries again shortly.`,
    );
  }
  return res;
}

/** What a service said went wrong, in its words, briefly. */
async function serviceWords(res: Response): Promise<string | null> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const said = body['message'] ?? body['error_description'] ?? body['errorCode'] ?? body['error'];
    return typeof said === 'string' && said.trim() ? said.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

export async function esignJson(
  fetchImpl: EsignFetch,
  url: string,
  init: RequestInit & { readonly signal: AbortSignal },
  words: { readonly service: string },
): Promise<Record<string, unknown>> {
  const res = await call(
    fetchImpl,
    url,
    {
      ...init,
      headers: { accept: 'application/json', ...(init.headers as Record<string, string>) },
    },
    words,
  );
  const text = await res.text();
  if (!text) return {};
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    throw new EsignUnreachable(`${words.service} sent something HandsFreeOS couldn’t read.`);
  }
}

/** A PDF from the service. */
export async function esignPdf(
  fetchImpl: EsignFetch,
  url: string,
  init: RequestInit & { readonly signal: AbortSignal },
  words: { readonly service: string },
): Promise<Buffer> {
  const res = await call(
    fetchImpl,
    url,
    {
      ...init,
      headers: { accept: 'application/pdf', ...(init.headers as Record<string, string>) },
    },
    words,
  );
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
    throw new EsignUnreachable(`${words.service} sent something that isn’t a PDF.`);
  return bytes;
}

/** A record's field as text, or null. */
export const text = (v: unknown, max = 500): string | null =>
  typeof v === 'string' && v.trim()
    ? v.trim().slice(0, max)
    : typeof v === 'number'
      ? String(v)
      : null;
/** A record's object field, or an empty one. */
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** A record's list field, or an empty one. */
export const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
/** An ISO time from a service's, or null. */
export const isoOf = (v: unknown): string | null => {
  const s = text(v, 100);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
