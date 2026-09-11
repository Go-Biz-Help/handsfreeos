import { HfosError } from '../errors';

interface PgLike {
  code?: string;
  detail?: string;
  message?: string;
  constraint_name?: string;
}

function unwrap(e: unknown): PgLike {
  let err: unknown = e;
  while (err instanceof Error && err.cause instanceof Error) err = err.cause;
  return (err ?? {}) as PgLike;
}

const RULES: Record<string, { status: number; message: string }> = {
  last_owner: {
    status: 409,
    message:
      'A workspace or organization must keep at least one Owner. Promote someone else first.',
  },
  invitation_expired: { status: 410, message: 'This invitation has expired.' },
  invitation_used: { status: 409, message: 'This invitation was already used.' },
  invitation_revoked: { status: 410, message: 'This invitation was revoked.' },
  invitation_email_mismatch: {
    status: 403,
    message: 'This invitation was sent to a different email address.',
  },
  invitation_not_found: { status: 404, message: 'Invitation not found.' },
  not_authenticated: { status: 401, message: 'Sign in to continue.' },
  profile_missing: {
    status: 500,
    message: 'Your account profile is missing. Please sign out and back in.',
  },
};

/** Maps a database error to the HfosError a client should see; unknown errors pass through untouched. */
export function translateDbError(e: unknown): unknown {
  if (e instanceof HfosError) return e;
  const pg = unwrap(e);
  if (!pg.code) return e;
  const rule = pg.detail && RULES[pg.detail] ? pg.detail : undefined;
  if (rule) {
    const r = RULES[rule]!;
    return new HfosError(
      rule === 'not_authenticated'
        ? 'unauthenticated'
        : rule === 'invitation_not_found'
          ? 'not_found'
          : 'rule_violation',
      r.status,
      r.message,
      undefined,
      rule,
    );
  }
  switch (pg.code) {
    case '42501':
      return HfosError.forbidden();
    case '23505':
      return HfosError.conflict('That already exists.', pg.constraint_name);
    case '23514':
      return HfosError.validation(undefined, pg.message ?? 'That change is not allowed.');
    case '28000':
      return HfosError.unauthenticated();
    default:
      return e;
  }
}
