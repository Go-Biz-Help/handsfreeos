import { isApiErrorBody } from '@hfos/api-client';

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

export function errorMessage(
  e: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
