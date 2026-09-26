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
  // 0104: being on a customer shows a member its bills and threads, so who is on one is the managers' call.
  customer_team_managers_only: {
    status: 403,
    message: 'Only owners and admins change who a customer is assigned to.',
  },
  // 0105: an account kept to other people on the team.
  payment_account_not_yours: {
    status: 403,
    message: 'That payment account is kept for other people on the team. Pick one of yours.',
  },
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
  // M17's port guards. Their absence here is what made a whole round of debugging guesswork: an untagged
  // 42501 becomes a bare `HfosError.forbidden()`, so a guard that fires and a policy that refuses are
  // indistinguishable in the failure. These are the twins of the three above, and say the same kind of thing.
  number_port_provider_fields: {
    status: 403,
    message: 'Only HandsFreeOS records what the carrier said about a port.',
  },
  number_port_with_carrier: {
    status: 409,
    message:
      'This port is already with the carrier, so it can’t be changed. Call it off to start again.',
  },
  number_port_status_transition: {
    status: 409,
    message: 'A port can only be saved, sent or called off.',
  },
  number_port_not_yours: {
    status: 403,
    message: 'You need to be able to manage this business’s numbers to move one.',
  },
  number_already_moving: {
    status: 409,
    message: 'That number is already with another business. Only one can be moving it at a time.',
  },
  number_already_yours: {
    status: 409,
    message: 'You already have this number, so there is nothing to move.',
  },
  no_number_port: { status: 404, message: 'That port no longer exists.' },
  // 20261011000100: a number coming over from Twilio or HighLevel. What arrived is the worker's to say.
  number_import_provider_fields: {
    status: 403,
    message: 'Only HandsFreeOS records where a number is and whether it has arrived.',
  },
  number_import_status_transition: {
    status: 409,
    message: 'A number on its way here can only be called off before it arrives.',
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
  // Milestone 5: calendars, appointments and calendar connections (0015-0017).
  booking_slug_reserved: { status: 400, message: 'That link name is reserved. Pick another.' },
  timezone_invalid: { status: 400, message: 'Pick a time zone from the list.' },
  waitlist_status_transition: {
    status: 409,
    message: 'Only HandsFreeOS offers a waitlist spot or lets one expire.',
  },
  calendar_connection_status_transition: {
    status: 409,
    message: 'People can only disconnect a calendar.',
  },
  // Milestone 7: the AI teammate and website chat (0031-0033).
  teammate_counts_protected: {
    status: 403,
    message: 'Training progress is counted by HandsFreeOS.',
  },
  teammate_status_transition: {
    status: 409,
    message: 'The AI teammate can’t change to that status.',
  },
  teammate_decision_forbidden: {
    status: 403,
    message: 'Only the business’s own team decides its teammate’s drafts.',
  },
  teammate_decision_invalid: { status: 400, message: 'A draft is approved or rejected.' },
  teammate_not_found: { status: 404, message: 'AI teammate not found.' },
  revision_immutable: { status: 403, message: 'Earlier versions can’t be changed.' },
  chat_conversation_mismatch: {
    status: 400,
    message: 'That chat belongs to a different visitor.',
  },
  // The trigger behind `platform.claimable_hosts`. `branded_domain.add` says this first and in the same
  // words; this is for anything that reaches the table by another road.
  branded_domain_is_ours: {
    status: 403,
    message: 'That is one of our own addresses. Use a domain your business owns.',
  },
  // Relationships (0101): what the database says when a pair or a type breaks its rules.
  relationship_end_full: {
    status: 409,
    message: 'That record already has as many of these as it can have. Remove one first.',
  },
  relationship_end_mismatch: {
    status: 400,
    message: 'That record can’t go on that end of this relationship.',
  },
  relationship_to_itself: { status: 400, message: 'A record can’t be related to itself.' },
  relationship_type_archived: {
    status: 409,
    message: 'That relationship type is archived. Restore it in Settings first.',
  },
  relationship_cardinality_conflict: {
    status: 409,
    message:
      'Some records already have more than one of these. Remove the extra relationships before saying “one”.',
  },
  too_many_record_types: {
    status: 409,
    message: 'That is as many kinds of records as a business can keep (30). Archive one first.',
  },
  too_many_relationship_types: {
    status: 409,
    message: 'That is as many relationship types as a business can keep (50). Archive one first.',
  },
  too_many_custom_fields: {
    status: 409,
    message: 'That is as many fields as a record can carry (200). Archive one first.',
  },
  unknown_custom_field: { status: 400, message: 'That field isn’t on this record.' },
  // Ideas, the roadmap and What's new (0102): the board's guards and limits.
  too_many_ideas: { status: 429, message: 'That is ten ideas today. Share the next one tomorrow.' },
  too_many_idea_comments: {
    status: 429,
    message: 'That is a lot of comments in an hour. Give it a little while.',
  },
  idea_roadmap_is_ours: {
    status: 403,
    message: 'Only the HandsFreeOS team moves an idea along the roadmap.',
  },
  idea_protected: { status: 403, message: 'Only the HandsFreeOS team changes that about an idea.' },
  idea_comment_protected: { status: 403, message: 'A comment can be taken down, not changed.' },
  idea_merge_itself: { status: 400, message: 'An idea cannot be merged into itself.' },
  idea_not_found: { status: 404, message: 'No idea with that id.' },
  idea_already_merged: { status: 409, message: 'That idea was already merged.' },
  idea_merge_target_gone: {
    status: 409,
    message: 'Merge it into an idea that is still on the board.',
  },
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
    case '23P01':
      // An exclusion constraint; the only one (appointment_staff_no_overlap) means that person was just
      // booked at that time by someone else.
      return HfosError.conflict('That time was just taken. Pick another time.', 'slot_taken');
    case '23514':
      return HfosError.validation(undefined, pg.message ?? 'That change is not allowed.');
    case '28000':
      return HfosError.unauthenticated();
    default:
      return e;
  }
}
