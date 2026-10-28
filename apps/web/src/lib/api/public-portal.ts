/**
 * A customer's portal (`/c/<token>`, Real Estate round two, core) talking to the worker's `/public/portal` routes,
 * modelled on `public-money.ts`. The link in the address says whose portal it is; a device is signed in once its
 * owner types the 6-digit code emailed to them, and then carries a bearer the worker made for it. The bearer lives
 * in this browser's localStorage under the link (like the website chat's), and goes only to the worker.
 *
 * Every call is made from the customer's own browser, `no-store` and `no-referrer`, and **anything that changes
 * something is a POST**, because mail scanners follow links.
 */
import { publicEnv } from '../env';
import { ApiError } from './errors';

const PRIVATE: RequestInit = { cache: 'no-store', referrerPolicy: 'no-referrer' };

type ErrorBody = {
  error?: { code?: string; message?: string; rule?: string; details?: unknown };
} | null;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, { ...PRIVATE, ...init });
  } catch {
    throw new ApiError(
      0,
      'internal',
      'We couldn’t reach us just now. Check your connection and try again.',
    );
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

const headers = (bearer: string | null): HeadersInit => ({
  'content-type': 'application/json',
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
});

const post = <T>(path: string, body: unknown, bearer: string | null = null) =>
  call<T>(path, { method: 'POST', headers: headers(bearer), body: JSON.stringify(body) });

const linkPath = (token: string) => `/public/portal/${encodeURIComponent(token)}`;

// ---- This device's sign-in, kept per link ----

const storageKey = (token: string) => `hfos.portal.${token}`;

export function savedBearer(token: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(token));
  } catch {
    return null;
  }
}

export function saveBearer(token: string, bearer: string | null): void {
  try {
    if (bearer) window.localStorage.setItem(storageKey(token), bearer);
    else window.localStorage.removeItem(storageKey(token));
  } catch {
    // Private windows can refuse storage: the device just asks for a code next time.
  }
}

// ---- The link and signing in ----

export interface PortalLink {
  readonly business: { readonly name: string };
  readonly person: { readonly firstName: string };
  /** The email the code goes to, partly hidden: "l•••@example.com". */
  readonly sentTo: string | null;
  /** This device is signed in to this portal. */
  readonly signedIn: boolean;
}

export const portalLink = (token: string, bearer: string | null) =>
  call<PortalLink>(linkPath(token), { method: 'GET', headers: headers(bearer) });

/** Emails a 6-digit code to the address on file. `website` is the honeypot, always empty from a person. */
export const sendPortalCode = (token: string) =>
  post<{ sentTo: string; minutes: number }>(`${linkPath(token)}/code`, { website: '' });

export type PortalVerify =
  | { readonly verified: true; readonly bearer: string; readonly expiresAt: string }
  | { readonly verified: false; readonly triesLeft: number };

export const verifyPortalCode = (token: string, code: string, device: string) =>
  post<PortalVerify>(`${linkPath(token)}/verify`, { code, device, website: '' });

export const signOutPortal = (token: string, bearer: string) =>
  post<{ signedOut: boolean }>(`${linkPath(token)}/sign-out`, {}, bearer);

// ---- What a signed-in customer does ----

/** One of the operations open to a customer (`portal.*`, `<addon>.portal.*`). The business comes from the device. */
export const portalOp = <T>(bearer: string, name: string, input: Record<string, unknown> = {}) =>
  post<T>(`/public/portal/op/${encodeURIComponent(name)}`, input, bearer);

/**
 * A partner setting up their bank at Stripe from their page (the partners plan's stage 3): Stripe's form to go to,
 * what Stripe says of it on their way back, or their Stripe page. On their own link only.
 */
export const portalPartnerPayouts = (
  token: string,
  bearer: string,
  action: 'start' | 'check' | 'stripe',
  country?: string,
) =>
  post<{ url?: string; ready?: boolean }>(
    `${linkPath(token)}/partner/payouts`,
    { action, ...(country ? { country } : {}) },
    bearer,
  );

/** A file of theirs, kept on one of their records (or on them): reserved, put in place, then checked. */
export async function uploadPortalFile(
  bearer: string,
  file: File,
  recordId: string | null,
): Promise<{ fileId: string; accepted: boolean; refusal: string | null }> {
  const begun = await post<{ fileId: string; uploadUrl: string }>(
    '/public/portal/uploads',
    {
      recordId,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    },
    bearer,
  );
  let put: Response;
  try {
    put = await fetch(begun.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    put = new Response(null, { status: 0 });
  }
  if (!put.ok)
    throw new ApiError(
      put.status,
      'internal',
      'Your file didn’t finish uploading. Check your connection and try again.',
    );
  const done = await portalOp<{ accepted: boolean; refusal: { message: string } | null }>(
    bearer,
    'portal.upload_confirm',
    { fileId: begun.fileId },
  );
  return { fileId: begun.fileId, accepted: done.accepted, refusal: done.refusal?.message ?? null };
}

/** A five-minute link to one of the files in their portal. */
export const portalFileUrl = (bearer: string, fileId: string) =>
  call<{ name: string; url: string }>(`/public/portal/files/${encodeURIComponent(fileId)}`, {
    method: 'GET',
    headers: headers(bearer),
  });
