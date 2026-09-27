/**
 * Is a booking from a person? Cloudflare Turnstile when TURNSTILE_SECRET_KEY is set, a pass-through when it
 * isn't (local development; production refuses to start without it unless ALLOW_NO_BOT_CHECK=1), and a fake
 * for tests. Cloudflare's always-pass test keys are site
 * 1x00000000000000000000AA and secret 1x0000000000000000000000000000000AA.
 */

export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
export const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** `unavailable`: Cloudflare didn't answer, so nobody can tell; the booking is refused with a retry message. */
export type BotVerdict = 'pass' | 'fail' | 'unavailable';

export interface BotCheck {
  /** The page shows the widget and sends its token. */
  readonly enabled: boolean;
  /**
   * The widget's public site key when the worker knows it (Cloudflare's test secret); otherwise null and the
   * page uses NEXT_PUBLIC_TURNSTILE_SITE_KEY.
   */
  readonly siteKey: string | null;
  verify(token: string | undefined, ip: string): Promise<BotVerdict>;
}

export const passThroughBotCheck: BotCheck = {
  enabled: false,
  siteKey: null,
  verify: () => Promise.resolve('pass'),
};

/** Cloudflare Turnstile's siteverify, with a short timeout. */
export function turnstileBotCheck(
  secret: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): BotCheck {
  const doFetch = opts.fetch ?? fetch;
  return {
    enabled: true,
    siteKey: secret === TURNSTILE_TEST_SECRET_KEY ? TURNSTILE_TEST_SITE_KEY : null,
    async verify(token, ip) {
      if (!token) return 'fail';
      try {
        const res = await doFetch(SITEVERIFY, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        });
        if (!res.ok) return 'unavailable';
        const body = (await res.json()) as { success?: unknown };
        return body.success === true ? 'pass' : 'fail';
      } catch {
        return 'unavailable';
      }
    },
  };
}

export function createBotCheck(secret: string | null): BotCheck {
  return secret ? turnstileBotCheck(secret) : passThroughBotCheck;
}

export interface FakeBotCheck extends BotCheck {
  /** Every token and address it was asked about, oldest first. */
  readonly seen: { token: string | undefined; ip: string }[];
}

/** Tests: the widget is on, the token `pass` passes, anything else fails. */
export function fakeBotCheck(siteKey = 'fake-site-key'): FakeBotCheck {
  const seen: FakeBotCheck['seen'] = [];
  return {
    enabled: true,
    siteKey,
    seen,
    verify(token, ip) {
      seen.push({ token, ip });
      return Promise.resolve(token === 'pass' ? 'pass' : 'fail');
    },
  };
}
