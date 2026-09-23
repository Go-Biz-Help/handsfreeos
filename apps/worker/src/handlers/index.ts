import { onAccountDeletionRequested } from '../account/delete';
import { onWorkspaceDeletionRequested } from '../workspace/delete';
import { withTeammate } from '../ai-team/index';
import { withAttention } from '../attention/index';
import { onChatReplySent } from '../chat/followup';
import { onKnowledgeDocumentAdded } from '../knowledge/document';
import { onKnowledgeScanRequested } from '../knowledge/scan';
import { onScheduleCancelled, onTextScheduled } from '../messaging/scheduled';
import { withPush } from '../push/moments';
import { withWorkflows } from '../workflows/index';
import { onPackPushed, onTemplatePushed } from '../workflows/templates';
import {
  onAddedConfirm,
  onArmReminders,
  onBookedConfirm,
  onBookedTeamEmail,
  onCancelledNotice,
  onCancelledTeamEmail,
  onConfirmedThanks,
  onMovedNotice,
  onReassignedNotice,
} from './appointment-messages';
import { onJobStatusChanged } from '../booking/job-texts';
import {
  onAppointmentChanged,
  onCalendarReauthRequired,
  onCalendarRefreshWanted,
} from './calendar';
import { onCampaignCreated, onCampaignPace, onCampaignSending } from '../automations/campaigns';
import { onExpiringArm } from '../automations/expiring';
import { onHandoffNudge } from '../automations/handoff';
import { onConnectionBroke, onCorrection } from '../automations/health';
import { onArmJobCheck, onStillGoing } from '../automations/job-check';
import { onCallPromise, onMessagePromise } from '../automations/promises';
import { onEngaged, onPipelineEvidence } from '../automations/pipeline';
import { onReviewReplied, onReviewSyncWanted } from './reviews';
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
  onEstimateSent,
  onInvoiceChanged,
  onInvoicePaid,
  onInvoiceSent,
  onPaymentFailed,
  onPaymentRecorded,
  onSubscriptionLive,
} from '../money/jobs';
import { onWalletLow } from '../money/recharge';
import { onWalletDeclinedNotice, onWalletEmptyNotice } from '../money/wallet-notices';
import { onRefundRequested } from '../money/refunds';
import { onFoundingCheckoutRequested } from '../founding/checkout';
import { onPlanCardRequested, onPlanChanged } from '../money/subscriptions';
import { onBridgeCancelled, onBridgeRequested, onVerificationRequested } from '../telephony/cell';
import { onPortCancelled, onPortSubmitted } from '../telephony/ports';
import {
  onRcsCheckWanted,
  onRcsConnectRequested,
  onRcsDisconnectRequested,
  onRcsStateChanged,
} from '../telephony/rcs';
import {
  onBrandedDomainAdded,
  onBrandedDomainCheckRequested,
  onBrandedDomainRemoved,
} from '../hosting/domains';
import { onPaymentConnectionConnected, onPaymentConnectionDisconnected } from './payments';
import {
  onConversationLinked,
  onConversationSnoozed,
  onMessageQueued,
  onPurchaseRequested,
  onRegistrationStatusChanged,
  onRegistrationSubmitted,
  onReleaseRequested,
} from './telephony';
import { onBookedIntake } from '../automations/intake';
import { onCallReferral, onMessageReferral } from '../automations/referrals';
import { onCompletedThankYou } from '../automations/thank-you';
import { supportHandlers } from './support';
import type { HandlerMap } from './types';
import { onSeatFreed } from './waitlist';

/**
 * Event type → handler, or several run in order in one transaction (a retry runs them all again). Events
 * without a handler are marked done untouched. withTeammate adds the AI teammate's handlers (a customer's
 * message, a hand-back, an approved draft: ai-team/triggers.ts), then withWorkflows appends the workflow
 * dispatcher to every event workflows start on, wait for or stop on (workflows/dispatch.ts), and withAttention
 * appends the Action Center's reconcile last to every event that can change what needs attention
 * (attention/index.ts).
 */
const ownTeammateAndWorkflows: HandlerMap = withWorkflows(
  withTeammate({
    'invitation.created': onInvitationCreated,
    'invitation.resend_requested': onInvitationResendRequested,
    'file.deleted': onFileDeleted,
    'import.requested': onImportRequested,
    'phone_number.purchase_requested': onPurchaseRequested,
    'phone_number.release_requested': onReleaseRequested,
    'registration.submitted': onRegistrationSubmitted,
    'registration.status_changed': onRegistrationStatusChanged,
    // A number a business already owns, on its way to us: the carrier call is a job (telephony/ports.ts).
    'number_port.submitted': onPortSubmitted,
    'number_port.cancelled': onPortCancelled,
    // A business's RCS sender (0101): connecting it, looking again (or switching RCS on or off, which the look
    // puts right in the messaging service's pool) and letting it go are jobs (telephony/rcs.ts).
    'rcs_sender.connect_requested': onRcsConnectRequested,
    'rcs_sender.refresh_requested': onRcsCheckWanted,
    'rcs_sender.updated': onRcsCheckWanted,
    'rcs_sender.disconnect_requested': onRcsDisconnectRequested,
    // Owners and admins hear when RCS goes live, and when it stops.
    'rcs_sender.state_changed': onRcsStateChanged,
    // A business's own domain on its booking page, forms and links (hosting/domains.ts).
    'branded_domain.added': onBrandedDomainAdded,
    'branded_domain.check_requested': onBrandedDomainCheckRequested,
    'branded_domain.removed': onBrandedDomainRemoved,
    // Automations' pipeline rows (automations/pipeline.ts): someone got back to a customer, so their deal may move
    // on; and someone really talking with the business may need a deal of their own.
    // …and "Promises not kept" reads what a person on the team wrote for one (automations/promises.ts).
    'message.queued': [onMessageQueued, onPipelineEvidence, onEngaged, onMessagePromise],
    // A text waiting for quiet hours to end goes then; a cancelled one ends at once (messaging/scheduled.ts).
    'message.scheduled': onTextScheduled,
    'message.schedule_cancelled': onScheduleCancelled,
    // A call through someone's own cell rings it first; confirming a cell calls it (telephony/cell.ts).
    'call.started': onBridgeRequested,
    'call.bridge_cancelled': onBridgeCancelled,
    'user_phone.verification_requested': onVerificationRequested,
    // Someone deleted their account: the job takes them off each business, then the profile and sign-in go.
    'account.deletion_requested': onAccountDeletionRequested,
    // An owner deleted a business: the job lets go of what is outside, then purges it (workspace/delete.ts).
    'workspace.deletion_requested': onWorkspaceDeletionRequested,
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
    'mailbox.reauth_required': [onMailboxReauthRequired, onConnectionBroke],
    'mailbox.failed': onConnectionBroke,
    'calendar_connection.connected': onCalendarRefreshWanted,
    // What customers said in public: a person asks, and the queue does it.
    'review_connection.connected': onReviewSyncWanted,
    'review_connection.sync_requested': onReviewSyncWanted,
    'review.replied': onReviewReplied,
    'calendar_connection.sync_requested': onCalendarRefreshWanted,
    'calendar_connection.reauth_required': [onCalendarReauthRequired, onConnectionBroke],
    'calendar_connection.failed': onConnectionBroke,
    // A connected payment account: its token refresh starts, and disconnecting tells the provider too.
    'payment_connection.connected': onPaymentConnectionConnected,
    'payment_connection.disconnected': onPaymentConnectionDisconnected,
    // Automations' "Connection broke" (automations/health.ts): whoever can fix it hears at once.
    'payment_connection.reauth_required': onConnectionBroke,
    'payment_connection.failed': onConnectionBroke,
    'payment_connection.revoked': onConnectionBroke,
    'review_connection.needs_attention': onConnectionBroke,
    'phone_number.purchase_failed': onConnectionBroke,
    // A person asked for a refund: the provider call is queued, so it retries on its own (money/refunds.ts).
    'refund.requested': onRefundRequested,
    // Somebody pressed Pay on a founding seat (0093): Stripe's page is made by a job, which retries on its own.
    'founding.checkout_requested': onFoundingCheckoutRequested,
    // The usage wallet ran low (M16): if it has a card and automatic top-up on, the charge is queued as a job
    // for the same reason a refund is. `wallet.empty` brings no second attempt — by then the top-up has
    // already been tried — but it does bring the email, because a push can be switched off and at zero we do
    // not send a text to say there is no money for texts.
    'wallet.low': onWalletLow,
    'wallet.empty': onWalletEmptyNotice,
    'wallet.suspended': onWalletDeclinedNotice,
    // Money (money/jobs.ts): a document that went out carries its own message and then the jobs that follow
    // it — an estimate's nudge and expiry, an invoice's reminder ladder and its overdue mark. A payment
    // brings the customer a receipt (or, where nobody was watching, that it didn't go through), and a
    // settled invoice brings the team its "you've been paid".
    'estimate.sent': [onEstimateSent, onPipelineEvidence],
    'estimate.accepted': onPipelineEvidence,
    'invoice.sent': onInvoiceSent,
    'invoice.updated': onInvoiceChanged,
    'payment.recorded': [onPaymentRecorded, onInvoiceChanged],
    'payment.updated': onInvoiceChanged,
    'payment.failed': [onPaymentFailed, onInvoiceChanged],
    'refund.recorded': onInvoiceChanged,
    'invoice.paid': onInvoicePaid,
    // A plan: the provider is made to match what it says here (money/subscriptions.ts), and the cycle job
    // watches it from then on.
    'subscription.started': [onPlanChanged, onSubscriptionLive],
    'subscription.resumed': [onPlanChanged, onSubscriptionLive],
    'subscription.paused': onPlanChanged,
    'subscription.cancelled': onPlanChanged,
    'subscription.connection_changed': [onPlanChanged, onSubscriptionLive],
    // The customer was asked for a card, and then put one on: the link goes out, and the plan goes live.
    'subscription.card_requested': onPlanCardRequested,
    'subscription.card_saved': [onPlanChanged, onSubscriptionLive],
    // Appointments follow into people's own calendars (write-through) first; then the reminders, what the
    // customer hears and the team's email (handlers/appointment-messages.ts).
    'appointment.booked': [
      onAppointmentChanged,
      onArmReminders,
      onBookedConfirm,
      onBookedTeamEmail,
      // Automations' "Intake questions": the form, two minutes after the confirmation (automations/intake.ts).
      onBookedIntake,
      onPipelineEvidence,
      // Automations' "Did the job happen?": a push to whoever is on it, once it's over (automations/job-check.ts).
      onArmJobCheck,
    ],
    'appointment.updated': onAppointmentChanged,
    'appointment.rescheduled': [onAppointmentChanged, onArmReminders, onMovedNotice, onArmJobCheck],
    'appointment.still_going': onStillGoing,
    'appointment.reassigned': [onAppointmentChanged, onReassignedNotice],
    'appointment.cancelled': [onAppointmentChanged, onCancelledNotice, onCancelledTeamEmail],
    // Automations' "Referral mentioned": a customer's message or call that might name somebody who needs the
    // business is read by the AI in a job of its own (automations/referrals.ts).
    'message.received': [onMessageReferral, onEngaged],
    'call.transcribed': [onCallReferral, onCallPromise],
    // Automations' "Hand-off nobody picked up" (automations/handoff.ts) and "Approvals about to expire"
    // (automations/expiring.ts): the rounds after a hand-off, and the warning before a decision runs out.
    'conversation.handed_off': onHandoffNudge,
    'workflow.approval_requested': onExpiringArm,
    'ai_teammate.drafted': onExpiringArm,
    // Automations' "Repeated corrections": an edit or a rejection may be the third alike (automations/health.ts).
    'ai_teammate.draft_decided': onCorrection,
    // Automations' "Outreach campaigns": the AI writes each text, then they go a few an hour once approved
    // (automations/campaigns.ts).
    'campaign.created': onCampaignCreated,
    'campaign.approved': onCampaignSending,
    'campaign.resumed': onCampaignSending,
    'campaign.pace_changed': onCampaignPace,
    'call.completed': [onPipelineEvidence, onEngaged],
    // Automations' "Thank-you after the job": two hours on (automations/thank-you.ts).
    'appointment.completed': [onAppointmentChanged, onCompletedThankYou, onPipelineEvidence],
    'appointment.no_show': onAppointmentChanged,
    'attendee.added': [onAppointmentChanged, onArmReminders, onAddedConfirm, onPipelineEvidence],
    'attendee.removed': [onAppointmentChanged, onCancelledNotice],
    'attendee.rescheduled': [onAppointmentChanged, onArmReminders, onMovedNotice],
    'attendee.cancelled': [onAppointmentChanged, onCancelledNotice, onCancelledTeamEmail],
    // A customer who confirmed by replying C hears a short thank-you (handlers/appointment-messages.ts).
    'attendee.confirmed': onConfirmedThanks,
    // M18: a job's status or note changed: the customer hears about it (booking/job-texts.ts).
    'job.status_changed': onJobStatusChanged,
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

// withPush appends last: a booking, an assignment, an approval waiting or a payment queues its push once the event's
// other work is done (push/moments.ts).
//
// The support desk's own events (M13) are added afterwards, outside all of that: they belong to no business,
// so there is no teammate to wake, no workflow to start and nothing to put on anyone's Home.
export const handlers: HandlerMap = {
  ...withPush(withAttention(ownTeammateAndWorkflows)),
  ...supportHandlers,
};
