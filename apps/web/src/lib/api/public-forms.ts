/**
 * The public form page's calls to the worker's /public routes. No token: whoever fills a form in is signed
 * out. The form itself is read on the server; counting the visit, starting, saving and sending happen from the
 * customer's own browser, so the worker's per-address limits count per customer rather than per page.
 */
import { uploadTypeOf, type AnswerFile, type AnswerSheet, type FormDefinition } from '@hfos/core';
import { notFound } from 'next/navigation';
import { publicEnv } from '../env';
import { ApiError } from './errors';

export interface PublicFormPage {
  readonly business: {
    readonly name: string;
    readonly timeZone: string;
    /** Its logo and colour (the worker's PublicLook), which a form follows until its design says otherwise. */
    readonly look?: {
      readonly logo: {
        readonly url: string;
        readonly width: number;
        readonly height: number;
      } | null;
      readonly color: string | null;
    };
  };
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
  /** The separate box for offers, under "Text me", for a business that sends them. */
  readonly offersConsent?: { readonly title: string; readonly detail: string } | null;
  /** The "OK to call" box under those, for a business that asks for one (core's callConsentWords). */
  readonly callConsent?: { readonly title: string; readonly detail: string } | null;
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

/**
 * The form is the same for everyone who opens it, so the web keeps the worker's answer for half a minute, as the
 * booking pages do (the speed audit, Nov 2026). Those reads all come from the web server's address, which the worker
 * limits as one caller: asked afresh on every visit, a form an email had just gone out for could use the whole
 * allowance, and every form's page failed with it. What's published shows within that half minute. Anything about
 * one person (their own link, a sheet to finish) is asked fresh.
 */
const PAGE_CACHE: RequestInit =
  process.env.NODE_ENV === 'production' ? { next: { revalidate: 30 } } : { cache: 'no-store' };
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
  call<PublicFormPage>(formPath(site, slug), PAGE_CACHE);

/** Somebody opened the form: its count of who looked, said from their own browser, since the page is a kept copy. */
export const countFormView = (site: string, slug: string) =>
  post<{ counted: boolean }>(`${formPath(site, slug)}/view`, {});

export const startSheet = (
  site: string,
  slug: string,
  body: { website?: string; source?: 'link' | 'embed' | 'qr'; key?: string; ref?: string },
) => post<StartedSheet>(`${formPath(site, slug)}/start`, body);

export const saveSheet = (
  site: string,
  slug: string,
  responseId: string,
  body: { token: string; answers: Record<string, unknown>; askAgain?: boolean; pageId?: string },
) => post<{ responseId: string }>(`${formPath(site, slug)}/${seg(responseId)}/save`, body);

/** The answers and the details they give on the page that saves them, part way through (funnels). */
export const saveContactSheet = (
  site: string,
  slug: string,
  responseId: string,
  body: {
    token: string;
    answers: Record<string, unknown>;
    smsConsent: boolean;
    offersConsent?: boolean;
    callConsent?: boolean;
    askAgain?: boolean;
    website?: string;
    turnstileToken?: string;
  },
) => post<{ responseId: string }>(`${formPath(site, slug)}/${seg(responseId)}/contact`, body);

export const sendSheet = (
  site: string,
  slug: string,
  responseId: string,
  body: {
    token: string;
    answers: Record<string, unknown>;
    smsConsent: boolean;
    offersConsent?: boolean;
    callConsent?: boolean;
    askAgain?: boolean;
    website?: string;
    turnstileToken?: string;
  },
) => post<SentForm>(`${formPath(site, slug)}/${seg(responseId)}/submit`, body);

/** What a confirmed file came to: Storage's measure of it, or why it wasn't kept. */
interface ConfirmedUpload {
  readonly fileId: string;
  readonly accepted: boolean;
  readonly refusal: { readonly rule: string; readonly message: string } | null;
  readonly name: string;
  readonly bytes: number;
}

const STOPPED = 'Your file didn’t finish uploading. Check your connection and try again.';

/** Puts a file at its one-time link, saying how far along it is. */
function putFile(
  url: string,
  file: File,
  type: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', type);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.floor((e.loaded / e.total) * 100)));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, 'internal', STOPPED));
    xhr.onerror = () => reject(new ApiError(0, 'internal', STOPPED));
    xhr.onabort = () => reject(new ApiError(0, 'internal', STOPPED));
    xhr.send(file);
  });
}

/**
 * A file for a file question (product sellers, 5a): its place kept on the sheet, put there, then checked. Resolves
 * to what the answer keeps; a file the question doesn't take is refused with the words to show beside it.
 */
export async function uploadFormFile(
  site: string,
  slug: string,
  responseId: string,
  token: string,
  questionId: string,
  file: File,
  onProgress: (percent: number) => void = () => {},
): Promise<AnswerFile> {
  const path = `${formPath(site, slug)}/${seg(responseId)}/uploads`;
  const type = uploadTypeOf(file.name, file.type);
  const begun = await post<{ fileId: string; uploadUrl: string }>(path, {
    token,
    questionId,
    name: file.name,
    mimeType: type,
    sizeBytes: file.size,
  });
  await putFile(begun.uploadUrl, file, type, onProgress);
  const done = await post<ConfirmedUpload>(`${path}/${seg(begun.fileId)}/confirm`, { token });
  if (!done.accepted)
    throw new ApiError(
      422,
      'rule',
      done.refusal?.message ?? 'That file can’t be added here.',
      done.refusal?.rule,
    );
  onProgress(100);
  return { fileId: done.fileId, name: done.name, bytes: done.bytes };
}

export const resumeSheet = (site: string, slug: string, token: string) =>
  call<{ responseId: string; answers: AnswerSheet }>(
    `${formPath(site, slug)}/resume/${seg(token)}`,
    FRESH,
  );

/** What a personal link (`?k=`) tells the page: who to greet, what not to ask, and their sheet so far. */
export interface PersonalSheet {
  readonly firstName: string;
  /** The contact details we have for them, as answer targets: questions filling these are skipped. */
  readonly known: readonly string[];
  readonly sheet: { readonly responseId: string; readonly answers: AnswerSheet } | null;
}

export const personalSheet = (site: string, slug: string, key: string) =>
  call<PersonalSheet>(`${formPath(site, slug)}/personal/${seg(key)}`, FRESH);

/** The open times for a form's "Book a time" question (funnels). */
export interface FormTimes {
  /** False when its calendar isn't taking bookings from the form just now. */
  readonly open: boolean;
  readonly timezone: string;
  readonly slots: readonly {
    readonly startsAt: string;
    readonly sessionId: string | null;
    readonly seatsLeft: number | null;
  }[];
}

export const formTimes = (site: string, slug: string, questionId: string) =>
  call<FormTimes>(`${formPath(site, slug)}/times/${seg(questionId)}`, FRESH);
