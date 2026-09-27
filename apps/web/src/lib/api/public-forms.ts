/**
 * The public form page's calls to the worker's /public routes. No token: whoever fills a form in is signed
 * out. The form itself is read on the server; starting, saving and sending happen from the customer's own
 * browser, so the worker's per-address limits count per customer rather than per page.
 */
import type { AnswerSheet, FormDefinition } from '@hfos/core';
import { notFound } from 'next/navigation';
import { publicEnv } from '../env';
import { ApiError } from './errors';

export interface PublicFormPage {
  readonly business: { readonly name: string; readonly timeZone: string };
  readonly form: {
    readonly formId: string;
    readonly slug: string;
    readonly name: string;
    readonly mode: 'form' | 'survey' | 'quiz';
    readonly versionId: string;
  };
  readonly definition: FormDefinition;
  /** It still opens, but it isn't taking answers. */
  readonly closed: boolean;
  readonly closedMessage: string;
  /** Set when they arrived on an old link: the form's name today. */
  readonly redirected: string | null;
  /** Cloudflare Turnstile; a null site key means this app's own (NEXT_PUBLIC_TURNSTILE_SITE_KEY). */
  readonly botCheck: { readonly siteKey: string | null } | null;
}

export interface StartedSheet {
  readonly responseId: string;
  readonly token: string;
  readonly canResume: boolean;
}

export interface SentForm {
  readonly responseId: string;
  readonly resultId: string | null;
  readonly headline: string;
  readonly body: string;
  readonly buttonLabel?: string;
  readonly buttonUrl?: string | null;
  readonly redirectUrl?: string | null;
  readonly score?: number | null;
  readonly scorePercent?: number | null;
  readonly passed?: boolean | null;
  readonly showScore?: boolean;
  readonly dueCents: number;
}

interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly rule?: string;
    readonly details?: unknown;
  };
}

const FRESH: RequestInit = { cache: 'no-store' };
const seg = encodeURIComponent;
const formPath = (site: string, slug: string) => `/public/form/${seg(site)}/${seg(slug)}`;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, init);
  } catch {
    throw new ApiError(0, 'internal', 'We couldn’t reach the form. Check your connection.');
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
    ...FRESH,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The 404 page when the worker says there is no form at that address. */
export async function formPageData<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

export const getPublicForm = (site: string, slug: string) =>
  call<PublicFormPage>(formPath(site, slug), FRESH);

export const startSheet = (
  site: string,
  slug: string,
  body: { website?: string; source?: 'link' | 'embed' | 'qr' },
) => post<StartedSheet>(`${formPath(site, slug)}/start`, body);

export const saveSheet = (
  site: string,
  slug: string,
  responseId: string,
  body: { token: string; answers: Record<string, unknown> },
) => post<{ responseId: string }>(`${formPath(site, slug)}/${seg(responseId)}/save`, body);

export const sendSheet = (
  site: string,
  slug: string,
  responseId: string,
  body: {
    token: string;
    answers: Record<string, unknown>;
    smsConsent: boolean;
    website?: string;
    turnstileToken?: string;
  },
) => post<SentForm>(`${formPath(site, slug)}/${seg(responseId)}/submit`, body);

export const resumeSheet = (site: string, slug: string, token: string) =>
  call<{ responseId: string; answers: AnswerSheet }>(
    `${formPath(site, slug)}/resume/${seg(token)}`,
    FRESH,
  );
