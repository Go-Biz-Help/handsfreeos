export type HfosErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rule_violation'
  | 'internal';

export interface HfosErrorBody {
  readonly error: {
    readonly code: HfosErrorCode;
    readonly message: string;
    readonly rule?: string;
    readonly details?: unknown;
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

  toBody(): HfosErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.rule ? { rule: this.rule } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
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
  static internal(message = 'Something went wrong on our side.'): HfosError {
    return new HfosError('internal', 500, message);
  }
}

export function isHfosError(e: unknown): e is HfosError {
  return e instanceof HfosError;
}
