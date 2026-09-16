export type HfosErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rule_violation'
  | 'upgrade_required'
  | 'internal';

/**
 * What a client that keeps a queue of changes (the phone) does with a refusal:
 * - `final`: as sent, it never goes through. Say why, and hold whatever depends on it.
 * - `retry`: nothing was wrong with it. Send it again later, unchanged (after signing in again on a 401, and
 *   after updating the app on a 426).
 * - `ask`: a person can answer it ("Still send?", texting in quiet hours, booking despite a warning, adding a
 *   likely duplicate), and then it goes again.
 */
export type Disposition = 'final' | 'retry' | 'ask';

/** The refusals a person can answer, each with how. Every other refusal of a change is final. */
const ASK_RULES: ReadonlySet<string> = new Set([
  // Made too long ago to go out on its own: "Still send?" (x-hfos-confirmed-at).
  'stale_action',
  // Texting in quiet hours: "Send now, or when quiet hours end?" (acknowledgeQuietHours or sendAfterQuietHours).
  'quiet_hours',
  // A booking's warnings: buffers, hours, busy, time off, a time in the past (acknowledgeWarnings).
  'needs_confirmation',
  // Someone like this already exists (ignoreDuplicates).
  'duplicate',
  // Archiving a customer with open leads or tasks (force).
  'has_open_work',
  // Disconnecting a payment account that plans still bill through (acknowledgeSubscriptions).
  'payment_connection_has_plans',
  // The Assistant before the person's OK to send what they ask about to Anthropic's Claude (assistant.consent).
  'assistant_consent_required',
]);

/** A refusal's disposition, from its status and rule (the same answer for the API, the worker and the phone). */
export function dispositionOf(status: number, rule?: string): Disposition {
  // Server trouble, too many at once, a session to refresh, an app to update: the change itself is fine.
  if (status >= 500 || status === 429 || status === 426 || status === 401) return 'retry';
  return rule && ASK_RULES.has(rule) ? 'ask' : 'final';
}

export interface HfosErrorBody {
  readonly error: {
    readonly code: HfosErrorCode;
    readonly message: string;
    readonly rule?: string;
    readonly details?: unknown;
    readonly disposition: Disposition;
  };
}

/** The one error type the API returns to clients. Everything else is a 500 with no detail. */
export class HfosError extends Error {
  constructor(
    readonly code: HfosErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly rule?: string,
  ) {
    super(message);
    this.name = 'HfosError';
  }

  get disposition(): Disposition {
    return dispositionOf(this.status, this.rule);
  }

  toBody(): HfosErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.rule ? { rule: this.rule } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
        disposition: this.disposition,
      },
    };
  }

  static unauthenticated(message = 'Sign in to continue.'): HfosError {
    return new HfosError('unauthenticated', 401, message);
  }
  static forbidden(message = 'You do not have permission to do that.', rule?: string): HfosError {
    return new HfosError('forbidden', 403, message, undefined, rule);
  }
  static notFound(message = 'Not found.'): HfosError {
    return new HfosError('not_found', 404, message);
  }
  static validation(details: unknown, message = 'Some fields need attention.'): HfosError {
    return new HfosError('validation', 400, message, details);
  }
  static conflict(message: string, rule?: string): HfosError {
    return new HfosError('conflict', 409, message, undefined, rule);
  }
  static rule(rule: string, status: number, message: string): HfosError {
    return new HfosError('rule_violation', status, message, undefined, rule);
  }
  /** An app build older than the API accepts: it pauses, keeps its unsent changes and asks to be updated. */
  static upgradeRequired(minVersion: string): HfosError {
    return new HfosError(
      'upgrade_required',
      426,
      'Update the HandsFreeOS app to keep going. Nothing you did is lost.',
      { minVersion },
    );
  }
  static internal(message = 'Something went wrong on our side.'): HfosError {
    return new HfosError('internal', 500, message);
  }
}

export function isHfosError(e: unknown): e is HfosError {
  return e instanceof HfosError;
}
