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
  // Milestone 2 rules raised by the CRM triggers (detail = rule id).
  stage_has_leads: {
    status: 409,
    message: 'Move the leads out of this stage before changing what it means.',
  },
  last_stage_of_kind: {
    status: 409,
    message: 'A pipeline needs at least one open, one won and one lost stage.',
  },
  pipeline_has_open_leads: {
    status: 409,
    message: 'This pipeline still has open leads. Move or close them first.',
  },
  lost_reason_required: { status: 400, message: 'Add a reason to mark this lead lost.' },
  stage_pipeline_mismatch: { status: 400, message: 'That stage belongs to a different pipeline.' },
  stage_not_found: { status: 404, message: 'Stage not found.' },
  company_workspace_mismatch: { status: 400, message: 'That company is not in this workspace.' },
  record_workspace_mismatch: { status: 400, message: 'That record is not in this workspace.' },
  archive_forbidden: { status: 403, message: 'Only owners and admins archive or restore records.' },
  system_activity_immutable: { status: 403, message: 'System timeline entries cannot be changed.' },
  file_confirm_forbidden: { status: 403, message: 'Only the uploader can confirm a file.' },
  file_delete_forbidden: { status: 403, message: 'You cannot delete this file.' },
  file_status_transition: { status: 409, message: 'This file was already confirmed.' },
  file_not_uploaded: { status: 409, message: 'The file has not finished uploading.' },
  import_not_ready: { status: 409, message: 'This import cannot start yet.' },
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
  // Milestone 3 rules raised by the messaging triggers.
  phone_number_provider_fields: {
    status: 403,
    message: 'Only HandsFreeOS changes a number’s carrier details.',
  },
  phone_number_status_transition: {
    status: 409,
    message: 'That number can’t change to that status.',
  },
  registration_provider_fields: {
    status: 403,
    message: 'Only HandsFreeOS records the carrier’s answer.',
  },
  registration_in_review: {
    status: 409,
    message: 'The carriers are reviewing this registration. Changes wait until they answer.',
  },
  registration_status_transition: {
    status: 409,
    message: 'A registration can only be saved or sent.',
  },
  message_status_transition: {
    status: 409,
    message: 'Only a message that did not go out can be sent again.',
  },
  conversation_mismatch: {
    status: 400,
    message: 'That message belongs to a different conversation.',
  },
  // Email (0012): the address and domain guards.
  email_local_part_reserved: {
    status: 400,
    message: 'That name is reserved on the shared address. Pick another.',
  },
  email_domain_unverified: { status: 409, message: 'Verify the domain before sending from it.' },
  email_address_in_use: {
    status: 409,
    message: 'This address has sent mail, so it keeps its name. Add a new address instead.',
  },
  email_domain_in_use: { status: 409, message: 'Make another address the default first.' },
  mailbox_status_transition: { status: 409, message: 'People can only disconnect a mailbox.' },
  not_authenticated: { status: 401, message: 'Sign in to continue.' },
  profile_missing: {
    status: 500,
    message: 'Your account profile is missing. Please sign out and back in.',
  },
};

/** True when a statement hit a unique index (the named one, if given), so a handler can raise its own rule. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const pg = unwrap(e);
  return pg.code === '23505' && (!constraint || pg.constraint_name === constraint);
}

/** Maps a database error to the HfosError a client should see; unknown errors pass through untouched. */
export function translateDbError(e: unknown): unknown {
  if (e instanceof HfosError) return e;
  const pg = unwrap(e);
  if (!pg.code) return e;
  const rule = pg.detail && RULES[pg.detail] ? pg.detail : undefined;
  if (rule) {
    const r = RULES[rule]!;
    // Rule violations keep their own code so clients can branch on `rule`; only sign-in and existence differ.
    return new HfosError(
      r.status === 401 ? 'unauthenticated' : r.status === 404 ? 'not_found' : 'rule_violation',
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
