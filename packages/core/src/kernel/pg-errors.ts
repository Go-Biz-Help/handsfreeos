import { HfosError } from '../errors';
import { missingPermissionMessage } from '../permissions';

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
    message:
      'This stage still has leads in it, so it can’t change between open, won and lost. Move its leads to another stage on the Pipeline first.',
  },
  last_stage_of_kind: {
    status: 409,
    message:
      'A pipeline needs at least one open, one won and one lost stage. Add another stage of that kind in Settings → Pipelines first.',
  },
  pipeline_has_open_leads: {
    status: 409,
    message:
      'This pipeline still has open leads. Move them to another pipeline, or mark them won or lost, first.',
  },
  lost_reason_required: { status: 400, message: 'Add a reason to mark this lead lost.' },
  stage_pipeline_mismatch: {
    status: 400,
    message: 'That stage is in a different pipeline. Pick one of this pipeline’s stages.',
  },
  stage_not_found: {
    status: 404,
    message:
      'That stage isn’t there anymore. It may have been deleted. Refresh and pick another stage.',
  },
  company_workspace_mismatch: {
    status: 400,
    message: 'That company isn’t in this business. Pick one of this business’s companies.',
  },
  record_workspace_mismatch: {
    status: 400,
    message: 'Something you picked belongs to another business. Refresh and pick again.',
  },
  archive_forbidden: {
    status: 403,
    message: missingPermissionMessage('records.archive', 'member'),
  },
  // Two records for the same customer merged into one (person.merge). It takes the archive permission.
  person_merge_forbidden: {
    status: 403,
    message:
      'Merging customers takes the “Archive and restore” permission. An owner of this business can turn it on for you in Settings → Permissions.',
  },
  person_merge_self: {
    status: 400,
    message: 'That’s the same customer twice. Pick a different customer to merge with.',
  },
  person_missing: {
    status: 404,
    message:
      'One of those customers isn’t there anymore. It may have been deleted or merged. Refresh and try again.',
  },
  person_already_merged: {
    status: 409,
    message:
      'That customer was already merged into another one. Open the customer it was merged into instead.',
  },
  person_merge_into_archived: {
    status: 409,
    message:
      'The customer you’re keeping is archived. Restore them from the menu on their page, then merge.',
  },
  person_merge_mark: { status: 403, message: 'Only a merge marks a customer merged.' },
  person_merged: {
    status: 409,
    message: 'This customer was merged into another one and can’t be brought back.',
  },
  // 0104: being on a customer shows a member its bills and threads, so who is on one is the managers' call.
  customer_team_managers_only: {
    status: 403,
    message: missingPermissionMessage('records.assign', 'member'),
  },
  // 0105: an account kept to other people on the team.
  payment_account_not_yours: {
    status: 403,
    message: 'That payment account is kept for other people on the team. Pick one of yours.',
  },
  system_activity_immutable: {
    status: 403,
    message: 'HandsFreeOS wrote this timeline entry, so it can’t be changed. Add a note instead.',
  },
  file_confirm_forbidden: { status: 403, message: 'Only the uploader can confirm a file.' },
  file_delete_forbidden: {
    status: 403,
    message:
      'Only the person who added this file can delete it, or someone with the “Delete files” permission. An owner of this business can turn it on for you in Settings → Permissions.',
  },
  file_status_transition: { status: 409, message: 'This file was already confirmed.' },
  file_not_uploaded: {
    status: 409,
    message: 'The file hasn’t finished uploading. Wait for it to finish, then try again.',
  },
  import_not_ready: {
    status: 409,
    message:
      'This import isn’t ready to start. Upload the spreadsheet first, or refresh if it has already started.',
  },
  last_owner: {
    status: 409,
    message:
      'A business or agency needs at least one owner. Make someone else an owner on the Members page first.',
  },
  invitation_expired: {
    status: 410,
    message: 'This invitation has expired. Ask whoever invited you to send a new one.',
  },
  invitation_used: {
    status: 409,
    message:
      'This invitation was already accepted, and each link works once. If you’re not in the business yet, ask for a new one.',
  },
  invitation_revoked: {
    status: 410,
    message: 'This invitation was cancelled. Ask whoever invited you to send a new one.',
  },
  invitation_email_mismatch: {
    status: 403,
    message:
      'This invitation was sent to a different email address. Sign in with that address and open the link again.',
  },
  invitation_not_found: {
    status: 404,
    message: 'That invitation link doesn’t work. Ask whoever invited you to send a new one.',
  },
  // Milestone 3 rules raised by the messaging triggers.
  phone_number_provider_fields: {
    status: 403,
    message: 'Only HandsFreeOS changes a number’s carrier details.',
  },
  phone_number_status_transition: {
    status: 409,
    message:
      'That number is already being released, or it’s gone. Refresh Settings → Texting & calls to see where it stands.',
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
    message: missingPermissionMessage('channels.manage', 'member'),
  },
  number_already_moving: {
    status: 409,
    message:
      'That number is already with another business, and only one can be moving it at a time. If the number is yours, use Get help at the bottom of the menu and we’ll look into it.',
  },
  number_already_yours: {
    status: 409,
    message: 'You already have this number, so there is nothing to move.',
  },
  no_number_port: {
    status: 404,
    message:
      'That number transfer isn’t there anymore. Refresh Settings → Texting & calls and try again.',
  },
  // 20261010000900: a number coming over from Twilio or HighLevel. What arrived is the worker's to say.
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
    message:
      'Only a message that didn’t go out can be sent again. This one went out, or it’s already being tried again. Refresh the conversation to see where it stands.',
  },
  conversation_mismatch: {
    status: 400,
    message: 'That message belongs to a different conversation.',
  },
  // Email (0012): the address and domain guards.
  email_local_part_reserved: {
    status: 400,
    message:
      'That name is kept for HandsFreeOS itself, for its support desk or its own mail. Pick another.',
  },
  // M19: handsfreeos.com, receiving mail, and HandsFreeOS's own business.
  email_domain_ours: {
    status: 400,
    message:
      'That domain is HandsFreeOS’s own. Use a domain your business owns, like lonestarhvac.com.',
  },
  email_domain_provider_fields: {
    status: 403,
    message:
      'HandsFreeOS says when a domain’s mail starts arriving, once it finds the MX record. Turn receiving on or off in Settings → Email instead.',
  },
  // M19: a person's own address and mailbox.
  email_address_private: {
    status: 403,
    message:
      'That address is one person’s own, so only they can send from it. Pick a team address instead.',
  },
  email_address_owner_is_theirs: {
    status: 409,
    message:
      'That address is one person’s own, and its mail is theirs. Once they’ve left the business, an owner can make it the team’s or give it to someone else.',
  },
  email_address_owner_not_here: {
    status: 400,
    message:
      'That person isn’t on this business’s team. Invite them in Settings → Team first, then give them the address.',
  },
  private_thread_is_theirs: {
    status: 403,
    message: 'That mail is one person’s own. Only they can open it or share it with the team.',
  },
  email_address_reassign_owner: {
    status: 403,
    message:
      'Only an owner of the business decides what becomes of someone’s own address. Ask an owner to do it.',
  },
  email_address_not_owned: {
    status: 409,
    message: 'That address is the team’s already, so there’s nothing to decide.',
  },
  email_address_owner_still_here: {
    status: 409,
    message:
      'The person whose address this is still works here, so it stays theirs. Once they’ve left, an owner can decide what becomes of it.',
  },
  no_email_address: {
    status: 404,
    message:
      'That address isn’t there anymore. It may have been removed. Refresh Settings → Email and try again.',
  },
  no_workspace: {
    status: 404,
    message:
      'That business isn’t there anymore. It may have been deleted. Refresh the list and pick another.',
  },
  platform_holds_our_domain: {
    status: 409,
    message:
      'This business still uses handsfreeos.com for its email. Remove handsfreeos.com under Use your own domain in its Settings → Email first.',
  },
  email_domain_unverified: {
    status: 409,
    message:
      'That domain isn’t verified yet, so you can’t send from it. Finish verifying it in Settings → Email, then try again.',
  },
  email_address_in_use: {
    status: 409,
    message: 'This address has sent mail, so it keeps its name. Add a new address instead.',
  },
  email_domain_in_use: {
    status: 409,
    message:
      'The default address is on this domain, so the domain can’t be removed. Make another address the default in Settings → Email first.',
  },
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
    message:
      'A new AI teammate starts off or in training. Set it up that way, then switch it to automatic once it’s ready.',
  },
  teammate_decision_forbidden: {
    status: 403,
    message: missingPermissionMessage('inbox.use', 'member'),
  },
  teammate_decision_invalid: { status: 400, message: 'A draft is approved or rejected.' },
  teammate_not_found: {
    status: 404,
    message:
      'That AI teammate isn’t there anymore. It may have been removed. Refresh and try again.',
  },
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
    message:
      'That record already has as many of these as it can have. Remove the one it has first, or allow more in Settings → Relationships.',
  },
  relationship_end_mismatch: {
    status: 400,
    message:
      'That record is the wrong kind for this relationship. Pick one of the kind it links to.',
  },
  relationship_to_itself: {
    status: 400,
    message: 'A record can’t be related to itself. Pick a different record.',
  },
  relationship_type_archived: {
    status: 409,
    message: 'That relationship type is archived. Restore it in Settings → Relationships first.',
  },
  relationship_cardinality_conflict: {
    status: 409,
    message:
      'Some records already have more than one of these. Remove the extra relationships before saying “one”.',
  },
  too_many_record_types: {
    status: 409,
    message:
      'That is as many kinds of records as a business can keep (30). Archive one you no longer use in Settings → Relationships first.',
  },
  too_many_relationship_types: {
    status: 409,
    message:
      'That is as many relationship types as a business can keep (50). Archive one you no longer use in Settings → Relationships first.',
  },
  too_many_custom_fields: {
    status: 409,
    message:
      'That is as many fields as a record can carry (200). Archive one you no longer use in Settings → Fields first.',
  },
  unknown_custom_field: {
    status: 400,
    message:
      'That field isn’t on this kind of record anymore. It may have been archived. Refresh and try again.',
  },
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
  idea_merge_itself: {
    status: 400,
    message: 'An idea can’t be merged into itself. Pick a different idea to merge it into.',
  },
  idea_not_found: {
    status: 404,
    message: 'That idea isn’t on the board anymore. Refresh and try again.',
  },
  idea_already_merged: { status: 409, message: 'That idea was already merged.' },
  idea_merge_target_gone: {
    status: 409,
    message: 'Merge it into an idea that is still on the board.',
  },
  not_authenticated: { status: 401, message: 'Sign in to continue.' },
  profile_missing: {
    status: 500,
    message: 'Your account’s profile is missing. Sign out and sign back in to set it up again.',
  },
  // Add-ons (0108): the rules the database holds whoever writes.
  addon_inactive: {
    status: 403,
    message:
      'That add-on is turned off for this business. Someone who manages add-ons can turn it back on in Settings → Add-ons.',
  },
  addon_needs_person: { status: 401, message: 'Sign in to change add-ons.' },
  addon_needs_manage: { status: 403, message: missingPermissionMessage('addons.manage', 'member') },
  addon_purge_owner_only: {
    status: 403,
    message:
      'Only an owner of this business can permanently delete an add-on’s data. Ask one of them.',
  },
  addon_not_installed: {
    status: 409,
    message: 'That add-on isn’t installed here. Install it from Settings → Add-ons first.',
  },
  addon_bad_move: {
    status: 409,
    message:
      'That add-on is partway through another change, so it can’t do that yet. Refresh Settings → Add-ons to see where it is, then try again.',
  },
  addon_installation_is_ours: {
    status: 403,
    message: 'Add-ons are installed and removed through their own commands.',
  },
  addon_settings_forbidden: {
    status: 403,
    message:
      'You don’t have permission to change this add-on’s settings. An owner of this business can give it to you in Settings → Permissions.',
  },
  addon_bad_permission: { status: 403, message: 'That isn’t a permission of this add-on.' },
  addon_override_forbidden: {
    status: 403,
    message: 'Only HandsFreeOS staff who manage add-ons can do that.',
  },
  addon_meter_not_its_own: { status: 400, message: 'A meter belongs to its own add-on.' },
  managed_by_addon: {
    status: 403,
    message: 'An add-on looks after this, so it can’t be changed by hand.',
  },
  managed_record_forbidden: {
    status: 403,
    message:
      'You don’t have permission to change these records. An owner of this business can give it to you in Settings → Permissions.',
  },
  record_purged: {
    status: 409,
    message: 'This record’s add-on data was deleted, so it can’t be changed.',
  },
  // 0109: voting on what's next.
  addon_pick_is_ours: {
    status: 403,
    message: 'Only the HandsFreeOS team chooses what comes next.',
  },
  addon_week_unknown: { status: 404, message: 'There is no such week.' },
  addon_week_decided: { status: 409, message: 'That week already has its pick.' },
  addon_not_tied: { status: 409, message: 'Choose one of the add-ons that tied.' },
  addon_already_picked: { status: 409, message: 'That add-on is already coming soon.' },
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
      return HfosError.conflict(
        'That already exists. Give it a different name or details, or use the one that’s already there.',
        pg.constraint_name,
      );
    case '23P01':
      // An exclusion constraint; the only one (appointment_staff_no_overlap) means that person was just
      // booked at that time by someone else.
      return HfosError.conflict('That time was just taken. Pick another time.', 'slot_taken');
    case '23514':
      return HfosError.validation(
        undefined,
        pg.message ?? 'That change isn’t allowed. Check what you entered and try again.',
      );
    case '28000':
      return HfosError.unauthenticated();
    default:
      return e;
  }
}
