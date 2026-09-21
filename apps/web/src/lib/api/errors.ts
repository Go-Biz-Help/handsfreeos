import { isApiErrorBody } from '@hfos/api-client';
import { NO_SUCH_ROUTE } from '@hfos/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly rule?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turns an openapi-fetch result into data or a thrown ApiError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    const body = result.error;
    if (isApiErrorBody(body))
      throw new ApiError(
        result.response.status,
        body.error.code,
        body.error.message,
        body.error.rule,
        body.error.details,
      );
    throw new ApiError(
      result.response.status,
      'internal',
      'The server did not respond as expected.',
    );
  }
  return result.data;
}

/** Past this many, the list stops reading as a sentence and the generic line is kinder. */
const MAX_SHOWN = 3;

/**
 * The sentences a validation error actually wanted to say.
 *
 * `HfosError.validation()` puts the reason in `details` — one `{ path, message }` per field — and leaves
 * `message` as the generic "Some fields need attention.". Showing only the generic one turns a written
 * answer like "That is one of our own addresses" into a shrug, so the field messages come out first.
 *
 * Anything else carried in `details` is left alone: `upgradeRequired` puts an object there, not an array,
 * and falls through to its own message.
 */
function fieldMessages(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const said = details
    .map((d) =>
      typeof d === 'object' &&
      d !== null &&
      typeof (d as { message?: unknown }).message === 'string'
        ? (d as { message: string }).message.trim()
        : '',
    )
    .filter((m) => m.length > 0);
  return [...new Set(said)];
}

export function errorMessage(
  e: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  // A route this API build does not serve yet — one of ours, caught between the web deploy and the API's.
  // "No such route." is plumbing and reads like the person did something wrong; the caller's own fallback
  // is both kinder and truer, because a minute later the same button works.
  if (e instanceof ApiError && e.rule === NO_SUCH_ROUTE) return fallback;
  if (e instanceof ApiError) {
    const fields = fieldMessages(e.details);
    if (fields.length > 0 && fields.length <= MAX_SHOWN) return fields.join(' ');
    return e.message;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
