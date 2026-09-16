/**
 * Only a real refusal ends a sign-in. supabase-js keeps a saved sign-in when a refresh can't reach Supabase (no signal,
 * or a 5xx), but deletes it on any other failed answer once the access token has run out: a Wi-Fi login page, a
 * proxy's error page, a 429 or a 408 would each sign someone out in the middle of a job. This `fetch` sits in front
 * of the refresh request and turns every answer that isn't Supabase Auth saying no into a 503, which supabase-js
 * treats as no signal: the sign-in is kept and tried again.
 */

/** Supabase Auth codes that aren't about the sign-in itself: the refresh can be tried again later. */
const NOT_REFUSALS = new Set([
  'over_request_rate_limit',
  'request_timeout',
  'hook_timeout',
  'hook_timeout_after_retry',
  'unexpected_failure',
]);

/** Statuses that never mean the refresh token was refused, whatever the body says. */
const RETRY_STATUSES = new Set([408, 425, 429]);

export function isRefreshRequest(url: string): boolean {
  return /\/auth\/v1\/token\?(?:.*&)?grant_type=refresh_token(?:&|$)/.test(url);
}

/**
 * Whether an answer to a refresh is Supabase Auth refusing it (the token was revoked, already used or its session
 * ended, or the person was removed or banned): a 4xx with Supabase Auth's JSON error body.
 */
export function isRealRefusal(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500 || RETRY_STATUSES.has(status)) return false;
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const code =
    typeof b.code === 'string'
      ? b.code
      : typeof b.error_code === 'string'
        ? b.error_code
        : typeof b.error === 'string'
          ? b.error
          : null;
  return code !== null && !NOT_REFUSALS.has(code);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function unreachable(): Response {
  return new Response(
    JSON.stringify({ code: 'unreachable', message: 'Supabase Auth could not be reached.' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

export function withRefreshGuard(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.ok || !isRefreshRequest(urlOf(input))) return response;
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      // Not JSON: a login page or a proxy, not Supabase Auth.
    }
    return isRealRefusal(response.status, body) ? response : unreachable();
  };
}
