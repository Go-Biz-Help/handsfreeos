import { withTeammate } from '../ai-team/index';
import { onChatReplySent } from '../chat/followup';
import { onKnowledgeDocumentAdded } from '../knowledge/document';
import { onKnowledgeScanRequested } from '../knowledge/scan';
import { withWorkflows } from '../workflows/index';
import { onPackPushed, onTemplatePushed } from '../workflows/templates';
import {
  onAddedConfirm,
  onArmReminders,
  onBookedConfirm,
  onBookedTeamEmail,
  onCancelledNotice,
  onCancelledTeamEmail,
  onMovedNotice,
  onReassignedNotice,
} from './appointment-messages';
import {
  onAppointmentChanged,
  onCalendarReauthRequired,
  onCalendarRefreshWanted,
} from './calendar';
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
import { onSeatFreed } from './waitlist';

/**
 * Event type → handler, or several run in order in one transaction (a retry runs them all again). Events
 * without a handler are marked done untouched. withTeammate adds the AI teammate's handlers (a customer's
 * message, a hand-back, an approved draft: ai-team/triggers.ts), then withWorkflows appends the workflow
 * dispatcher last to every event workflows start on, wait for or stop on (workflows/dispatch.ts).
 */
export const handlers: HandlerMap = withWorkflows(
  withTeammate({
    'invitation.created': onInvitationCreated,
    'invitation.resend_requested': onInvitationResendRequested,
    'file.deleted': onFileDeleted,
    'import.requested': onImportRequested,
    'phone_number.purchase_requested': onPurchaseRequested,
    'phone_number.release_requested': onReleaseRequested,
    'registration.submitted': onRegistrationSubmitted,
    'registration.status_changed': onRegistrationStatusChanged,
    'message.queued': onMessageQueued,
    // A reply in a website chat is out: people's are marked sent, and the unread follow-up is armed (chat/).
    'message.sent': onChatReplySent,
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
    'calendar_connection.connected': onCalendarRefreshWanted,
    'calendar_connection.sync_requested': onCalendarRefreshWanted,
    'calendar_connection.reauth_required': onCalendarReauthRequired,
    // Appointments follow into people's own calendars (write-through) first; then the reminders, what the
    // customer hears and the team's email (handlers/appointment-messages.ts).
    'appointment.booked': [
      onAppointmentChanged,
      onArmReminders,
      onBookedConfirm,
      onBookedTeamEmail,
    ],
    'appointment.updated': onAppointmentChanged,
    'appointment.rescheduled': [onAppointmentChanged, onArmReminders, onMovedNotice],
    'appointment.reassigned': [onAppointmentChanged, onReassignedNotice],
    'appointment.cancelled': [onAppointmentChanged, onCancelledNotice, onCancelledTeamEmail],
    'appointment.completed': onAppointmentChanged,
    'appointment.no_show': onAppointmentChanged,
    'attendee.added': [onAppointmentChanged, onArmReminders, onAddedConfirm],
    'attendee.removed': [onAppointmentChanged, onCancelledNotice],
    'attendee.rescheduled': [onAppointmentChanged, onArmReminders, onMovedNotice],
    'attendee.cancelled': [onAppointmentChanged, onCancelledNotice, onCancelledTeamEmail],
    'session.published': onAppointmentChanged,
    'series.created': [onAppointmentChanged, onArmReminders],
    'series.cancelled': onAppointmentChanged,
    'waitlist.seat_freed': onSeatFreed,
    // The knowledge base: website scans and uploaded documents run as jobs (knowledge/scan.ts, document.ts).
    'knowledge_scan.requested': onKnowledgeScanRequested,
    'knowledge_document.added': onKnowledgeDocumentAdded,
    // The agency's pushes (organization-level events): one install job per business (workflows/templates.ts).
    'workflow_template.pushed': onTemplatePushed,
    'knowledge_pack.pushed': onPackPushed,
  }),
);
