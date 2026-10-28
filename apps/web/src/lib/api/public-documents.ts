/**
 * The signing page (`/d/<token>`) talking to the worker's `/public/sign` routes (apps/worker/src/documents/routes.ts).
 * No session: the token in the address is the whole of the permission, so every call is made from the signer's own
 * browser (the worker's per-address limits then count per signer), and every one is `no-store` with `no-referrer`.
 *
 * As on the money pages, **anything that changes something is a POST**, "they opened it" included, because mail
 * scanners follow links.
 */
import type { DocumentEdit, DocumentPage, DocumentValueInput } from '@hfos/core';
import { publicEnv } from '../env';
import { ApiError } from './errors';
import type { PublicBusiness } from './public-booking';

export type { PublicBusiness };

const PRIVATE: RequestInit = { cache: 'no-store', referrerPolicy: 'no-referrer' };

type ErrorBody = {
  error?: { code?: string; message?: string; rule?: string; details?: unknown };
} | null;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, init);
  } catch {
    throw new ApiError(
      0,
      'internal',
      'We couldn’t reach the signing service just now. Check your connection and try again.',
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

const post = <T>(path: string, body: unknown) =>
  call<T>(path, {
    ...PRIVATE,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const signPath = (token: string) => `/public/sign/${encodeURIComponent(token)}`;

/** A field as the signer sees it: theirs to fill in (`mine`), or someone else's, shown as they filled it. */
export interface SigningField {
  readonly id: string;
  readonly type: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly required: boolean;
  readonly label: string;
  readonly options: readonly string[];
  readonly fontSize: number;
  readonly mine: boolean;
  readonly roleLabel: string;
}

export type SigningDocumentStatus = 'out' | 'completed' | 'declined' | 'voided' | 'expired';

export interface SigningView {
  readonly business: PublicBusiness;
  readonly document: {
    readonly name: string;
    readonly status: SigningDocumentStatus;
    readonly message: string | null;
    readonly expiresAt: string;
    readonly allSigned: boolean;
    readonly signedCopy: boolean;
  };
  readonly signer: {
    readonly name: string;
    readonly kind: 'signer' | 'copy';
    readonly roleLabel: string | null;
    readonly status: string;
    readonly yourTurn: boolean;
    readonly askCode: boolean;
    readonly codeChecked: boolean;
    /** Where a code goes, partly hidden: "your phone ending in 0100". Null when it can't go anywhere. */
    readonly codeTo: string | null;
    readonly signedAt: string | null;
  };
  /** Word for word what ticking the box agrees to, and what's kept with their signature. */
  readonly consent: string;
  /** The document itself: null until their code is checked, and once it's voided or out of time. */
  readonly content: {
    readonly pages: readonly DocumentPage[];
    readonly sourceUrl: string | null;
    readonly edits: readonly DocumentEdit[];
    readonly fields: readonly SigningField[];
    readonly values: Readonly<Record<string, DocumentValueInput>>;
  } | null;
}

export const getSigning = (token: string) =>
  call<SigningView>(signPath(token), { ...PRIVATE, method: 'GET' });

export const markSigningOpened = (token: string) =>
  post<{ ok: true }>(`${signPath(token)}/opened`, {});

export const sendSigningCode = (token: string) =>
  post<{ sent: boolean; to: string | null }>(`${signPath(token)}/code`, {});

export const checkSigningCode = (token: string, code: string) =>
  post<SigningView>(`${signPath(token)}/code/check`, { code });

export const signDocument = (
  token: string,
  body: { values: Record<string, DocumentValueInput>; website: string },
) => post<SigningView>(`${signPath(token)}/sign`, { agreed: true, ...body });

export const declineDocument = (token: string, body: { reason: string | null; website: string }) =>
  post<SigningView>(`${signPath(token)}/decline`, body);

/** The signed copy: a plain link, which the worker turns into a short-lived one to the file. */
export const signedCopyUrl = (token: string) => `${publicEnv.workerUrl}${signPath(token)}/download`;
