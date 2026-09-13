import {
  onEmailDomainAdded,
  onEmailDomainChecked,
  onEmailDomainRemoved,
  onEmailDomainVerifyRequested,
  onUnmatchedClaimed,
} from './email';
import { onFileDeleted } from './file-removed';
import { onImportRequested } from './import-run';
import { onInvitationCreated, onInvitationResendRequested } from './invitation-email';
import { onMailboxReauthRequired, onMailboxSyncWanted } from './mailbox';
import {
  onConversationLinked,
  onConversationSnoozed,
  onMessageQueued,
  onPurchaseRequested,
  onRegistrationStatusChanged,
  onRegistrationSubmitted,
  onReleaseRequested,
} from './telephony';
import type { HandlerMap } from './types';

/** Event type → handler. Events without a handler are marked done untouched. */
export const handlers: HandlerMap = {
  'invitation.created': onInvitationCreated,
  'invitation.resend_requested': onInvitationResendRequested,
  'file.deleted': onFileDeleted,
  'import.requested': onImportRequested,
  'phone_number.purchase_requested': onPurchaseRequested,
  'phone_number.release_requested': onReleaseRequested,
  'registration.submitted': onRegistrationSubmitted,
  'registration.status_changed': onRegistrationStatusChanged,
  'message.queued': onMessageQueued,
  'conversation.linked': onConversationLinked,
  'conversation.snoozed': onConversationSnoozed,
  'email_domain.added': onEmailDomainAdded,
  'email_domain.verify_requested': onEmailDomainVerifyRequested,
  'email_domain.checked': onEmailDomainChecked,
  'email_domain.removed': onEmailDomainRemoved,
  'email.unmatched_claimed': onUnmatchedClaimed,
  'mailbox.connected': onMailboxSyncWanted,
  'mailbox.resync_requested': onMailboxSyncWanted,
  'mailbox.reauth_required': onMailboxReauthRequired,
};
