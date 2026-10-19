import { onAccountDeletionRequested } from '../account/delete';
import { onBinEmptied, onBinned, onBinRestored } from '../bin/index';
import { withAddons } from '../addons/index';
import { onWorkspaceDeletionRequested } from '../workspace/delete';
import { withTeammate } from '../ai-team/index';
import { withAttention } from '../attention/index';
import { onSweepStarted, withContactAi } from '../contact-ai/index';
import { onPortalReplySent } from '../portal/replies';
import { onPortalAccessGiven } from '../portal/invite';
import {
  onPartnerBooking,
  onPartnerDispute,
  onPartnerPayment,
  onPartnerRefund,
  onPartnerRefundFailed,
} from '../partners/handlers';
import {
  onPartnerPayoutCardSaved,
  onPartnerPayoutDeclined,
  onPartnerPayoutLinePaid,
} from '../partners/payouts';
import { onAllClear, onCheckedIn, onContactSaved, onHelp } from '../safety/ladder';
import { onChatReplySent } from '../chat/followup';
import { onDomainServing } from '../chat/own-domain';
import { onKnowledgeDocumentAdded } from '../knowledge/document';
import { onKnowledgeScanRequested } from '../knowledge/scan';
import { onAiSetupReadRequested } from '../ai-setup/read-site';
import { onLookFindRequested, onLookUploadReady } from '../look/jobs';
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
  onSeriesCancelledNotice,
  onSeriesConfirm,
} from './appointment-messages';
import { onJobStatusChanged } from '../booking/job-texts';
import {
  onAppointmentChanged,
  onMeetingConnected,
  onMeetingLinkRequested,
  onMeetingSettingsCheckRequested,
  onTranscriptReady,
  onCalendarReauthRequired,
  onCalendarRefreshWanted,
} from './calendar';
import { onCampaignCreated, onCampaignPace, onCampaignSending } from '../automations/campaigns';
import { onAiCallEnded, onMissedCallForAi, onQuoteNudgedForAi } from '../ai-calls/index';
import { onExpiringArm } from '../automations/expiring';
import { onHandoffNudge } from '../automations/handoff';
import { onConnectionBroke, onCorrection, onFeedback } from '../automations/health';
import { onArmJobCheck, onStillGoing } from '../automations/job-check';
import { onCallPromise, onMessagePromise } from '../automations/promises';
import { onEngaged, onPipelineEvidence } from '../automations/pipeline';
import { onHelpKeyword } from './help-reply';
import { onReviewReplied, onReviewSyncWanted } from './reviews';
import {
  onEmailDomainAdded,
  onEmailDomainChecked,
  onEmailDomainReceivingRequested,
  onEmailDomainReceivingStopped,
  onEmailDomainRemoved,
  onEmailDomainVerifyRequested,
  onUnmatchedClaimed,
} from './email';
import { onFileDeleted } from './file-removed';
import { onCallAnswered } from '../telephony/live';
import { onFileReceived } from './file-received';
import { onLeadQualified } from './qualifying-alerts';
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
import { onTopUpPressed, onWalletLow } from '../money/recharge';
import { onWalletDeclinedNotice, onWalletEmptyNotice } from '../money/wallet-notices';
import { onRefundRequested } from '../money/refunds';
import { onFoundingCheckoutRequested, onFoundingPaid } from '../founding/checkout';
import { onBusinessCreated } from '../opinly';
import { onPlanCardRequested, onPlanChanged } from '../money/subscriptions';
import { onBridgeCancelled, onBridgeRequested, onVerificationRequested } from '../telephony/cell';
import { onPortCancelled, onPortSubmitted } from '../telephony/ports';
import { onImportCheckRequested, onImportStarted } from '../telephony/imports';
import {
  onTelephonyDisableRequested,
  onTelephonyEnableRequested,
} from '../telephony/account-switch';
import {
  onRcsCheckWanted,
  onRcsConnectRequested,
  onRcsDisconnectRequested,
  onRcsStateChanged,
} from '../telephony/rcs';
import {
  onRcsBilled,
  onRcsRenewalPageRequested,
  onRcsRequestSubmitted,
} from '../telephony/rcs-billing';
import {
  onTextingFeeDue,
  onTextingFeeFailed,
  onTextingFeePageRequested,
  onTextingFeePaid,
} from '../telephony/texting-fees';
import {
  onBrandedDomainAdded,
  onBrandedDomainCheckRequested,
  onBrandedDomainRemoved,
} from '../hosting/domains';
import { onPaymentConnectionConnected, onPaymentConnectionDisconnected } from './payments';
import { onMessageEdited, onMetaAccountDisconnected } from '../social/handlers';
import {
  onConversationLinked,
  onConversationSnoozed,
  onMessageQueued,
  onNumberArrived,
  onPurchaseRequested,
  onRegistrationStatusChanged,
  onRegistrationSubmitted,
  onReleaseRequested,
} from './telephony';
import { onBookedIntake } from '../automations/intake';
import { onCallReferral, onMessageReferral } from '../automations/referrals';
import { onCompletedThankYou } from '../automations/thank-you';
import { supportHandlers } from './support';
import { ideaHandlers } from './ideas';
import { roadmapHandlers } from '../addons/roadmap';
import { onFileFingerprint } from './file-fingerprint';
import { onSupportAccessRequested } from './support-access';
import { onOnboardingLinkRequested, onOnboardingRemindRequested } from './onboarding';
import type { HandlerMap } from './types';
import { onSeatFreed, onWaitedForChanged, onWaitlistAdded } from './waitlist';

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
    // "Email me a link" in the phone app's Getting started.
    'onboarding.link_requested': onOnboardingLinkRequested,
    // An agency's reminder to a client business's owners.
    'onboarding.remind_requested': onOnboardingRemindRequested,
    'file.deleted': onFileDeleted,
    // What a file held when it arrived, and before it was locked as signed (Real Estate, step 3).
    'file.attached': onFileFingerprint,
    'file.locked': onFileFingerprint,
    // 20261018000400: a customer's file for a file question: copied onto the lead, and the question's people told.
    'file.received': onFileReceived,
    // "When a lead qualifies → Tell": whoever the AI teammate's settings name hears, with the answers.
    'lead.qualified': onLeadQualified,
    'import.requested': onImportRequested,
    'phone_number.purchase_requested': onPurchaseRequested,
    'phone_number.release_requested': onReleaseRequested,
    'registration.submitted': onRegistrationSubmitted,
    'registration.status_changed': onRegistrationStatusChanged,
    // A number started working here: a registration sent while it was on its way goes now.
    'phone_number.purchased': onNumberArrived,
    'phone_number.ported_in': onNumberArrived,
    'phone_number.imported': onNumberArrived,
    // A number a business already owns, on its way to us: the carrier call is a job (telephony/ports.ts).
    'number_port.submitted': onPortSubmitted,
    'number_port.cancelled': onPortCancelled,
    // A number already in Twilio, being sent to the workspace's subaccount: watching for it is a job
    // (telephony/imports.ts), started at once and pulled forward when somebody says it should be there.
    'number_import.started': onImportStarted,
    'number_import.check_requested': onImportCheckRequested,
    // Phone & texting on or off: the business's own Twilio subaccount, made or closed by a job.
    'telephony.enable_requested': onTelephonyEnableRequested,
    'telephony.disable_requested': onTelephonyDisableRequested,
    // A business's RCS sender (0103): connecting it, looking again (or switching RCS on or off, which the look
    // puts right in the messaging service's pool) and letting it go are jobs (telephony/rcs.ts).
    'rcs_sender.connect_requested': onRcsConnectRequested,
    'rcs_sender.refresh_requested': onRcsCheckWanted,
    'rcs_sender.updated': onRcsCheckWanted,
    'rcs_sender.disconnect_requested': onRcsDisconnectRequested,
    // Owners and admins hear when RCS goes live, and when it stops.
    'rcs_sender.state_changed': onRcsStateChanged,
    // A business asking for an RCS sender and paying for it (0104): the Stripe page is a job, and the business
    // hears when it is paid, renewed, or its renewal is refused (telephony/rcs-billing.ts).
    'rcs_request.submitted': onRcsRequestSubmitted,
    'rcs_request.paid': onRcsBilled,
    'rcs_request.renewed': onRcsBilled,
    'rcs_request.renewal_failed': onRcsBilled,
    'rcs_request.renewal_page_requested': onRcsRenewalPageRequested,
    // What registering for texting costs, passed on (0105): collecting a fee is a job; paying it lets the
    // registration go to the carriers; a card that says no is told to the owners (telephony/texting-fees.ts).
    'texting_fee.due': onTextingFeeDue,
    'texting_fee.page_requested': onTextingFeePageRequested,
    'texting_fee.paid': onTextingFeePaid,
    'texting_fee.failed': onTextingFeeFailed,
    // A business's own domain on its forms, payment links and booking page (hosting/domains.ts).
    'branded_domain.added': onBrandedDomainAdded,
    'branded_domain.check_requested': onBrandedDomainCheckRequested,
    'branded_domain.removed': onBrandedDomainRemoved,
    // Once it's serving, a chat on the business's pages here goes on its domain too (chat/own-domain.ts).
    'branded_domain.status_changed': onDomainServing,
    // Automations' pipeline rows (automations/pipeline.ts): someone got back to a customer, so their deal may move
    // on; and someone really talking with the business may need a deal of their own.
    // …and "Promises not kept" reads what a person on the team wrote for one (automations/promises.ts).
    'message.queued': [onMessageQueued, onPipelineEvidence, onEngaged, onMessagePromise],
    // An email from someone's own mailbox (M19): sent, and heard by nothing else.
    'email.private_queued': onMessageQueued,
    // A text waiting for quiet hours to end goes then; a cancelled one ends at once (messaging/scheduled.ts).
    'message.scheduled': onTextScheduled,
    'message.schedule_cancelled': onScheduleCancelled,
    // A call through someone's own cell rings it first; confirming a cell calls it (telephony/cell.ts).
    'call.started': onBridgeRequested,
    // Someone answered: the add-ons that hear calls live start hearing this one (telephony/live.ts).
    'call.answered': onCallAnswered,
    'call.bridge_cancelled': onBridgeCancelled,
    'user_phone.verification_requested': onVerificationRequested,
    // Someone deleted their account: the job takes them off each business, then the profile and sign-in go.
    'account.deletion_requested': onAccountDeletionRequested,
    // An owner deleted a business: the job lets go of what is outside, then purges it (workspace/delete.ts).
    'workspace.deletion_requested': onWorkspaceDeletionRequested,
    // A reply in a website chat is out: people's are marked sent, and the unread follow-up is armed (chat/).
    // A reply in a website chat or a client's portal: marked sent, and the unread follow-up armed.
    'message.sent': [onChatReplySent, onPortalReplySent],
    'conversation.linked': onConversationLinked,
    'conversation.snoozed': onConversationSnoozed,
    'email_domain.added': onEmailDomainAdded,
    'email_domain.verify_requested': onEmailDomainVerifyRequested,
    'email_domain.checked': onEmailDomainChecked,
    'email_domain.removed': onEmailDomainRemoved,
    'email_domain.receiving_requested': onEmailDomainReceivingRequested,
    'email_domain.receiving_stopped': onEmailDomainReceivingStopped,
    'email.unmatched_claimed': onUnmatchedClaimed,
    'mailbox.connected': onMailboxSyncWanted,
    'mailbox.resync_requested': onMailboxSyncWanted,
    'mailbox.reauth_required': [onMailboxReauthRequired, onConnectionBroke],
    'mailbox.failed': onConnectionBroke,
    'calendar_connection.connected': onCalendarRefreshWanted,
    'meeting_connection.connected': onMeetingConnected,
    'appointment.meeting_link_requested': onMeetingLinkRequested,
    'meeting_connection.settings_check_requested': onMeetingSettingsCheckRequested,
    'appointment.transcript_ready': onTranscriptReady,
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
    // Facebook Messenger and Instagram (social/): a Page that stopped answering tells its owners; one let go stops
    // Meta sending its messages; a message taken back takes its files with it.
    'meta_account.needs_attention': onConnectionBroke,
    'meta_account.disconnected': onMetaAccountDisconnected,
    'message.edited': onMessageEdited,
    // A person asked for a refund: the provider call is queued, so it retries on its own (money/refunds.ts).
    'refund.requested': onRefundRequested,
    // Somebody pressed Pay on a founding seat (0093): Stripe's page is made by a job, which retries on its own.
    'founding.checkout_requested': onFoundingCheckoutRequested,
    // …and paid for: the website's analytics hears of it from a job, when it has a key (founding/checkout.ts).
    'founding.paid': onFoundingPaid,
    // A business made in onboarding is a sign-up, told to Opinly when it has a key (opinly.ts).
    'workspace.created': onBusinessCreated,
    // The usage wallet ran low (M16): if it has a card and automatic top-up on, the charge is queued as a job
    // for the same reason a refund is. `wallet.empty` brings no second attempt — by then the top-up has
    // already been tried — but it does bring the email, because a push can be switched off and at zero we do
    // not send a text to say there is no money for texts.
    'wallet.low': onWalletLow,
    // …and somebody pressed Top up now: its charge is queued the same way (money/recharge.ts).
    'wallet.recharge_requested': onTopUpPressed,
    'wallet.empty': onWalletEmptyNotice,
    'wallet.suspended': onWalletDeclinedNotice,
    // Money (money/jobs.ts): a document that went out carries its own message and then the jobs that follow
    // it — an estimate's nudge and expiry, an invoice's reminder ladder and its overdue mark. A payment
    // brings the customer a receipt (or, where nobody was watching, that it didn't go through), and a
    // settled invoice brings the team its "you've been paid".
    'estimate.sent': [onEstimateSent, onPipelineEvidence],
    'estimate.nudged': onQuoteNudgedForAi,
    'estimate.accepted': onPipelineEvidence,
    'invoice.sent': onInvoiceSent,
    'invoice.updated': onInvoiceChanged,
    // …and a partner's client paying earns the partner their share, which a refund takes back (partners/handlers.ts).
    'payment.recorded': [onPaymentRecorded, onInvoiceChanged, onPartnerPayment],
    'payment.updated': onInvoiceChanged,
    'payment.failed': [onPaymentFailed, onInvoiceChanged],
    'refund.recorded': [onInvoiceChanged, onPartnerRefund],
    // A refund the client's bank turned down after it went through counts as the business's money again, and the
    // partner's share it took back is theirs again.
    'refund.failed': [onInvoiceChanged, onPartnerRefundFailed],
    // A dispute the business lost takes back what a partner earned on the payment (partners/handlers.ts).
    'dispute.closed': onPartnerDispute,
    // Paying partners (partners/payouts.ts): a new card is tried at once; the owners hear when the card is
    // declined, or given up on for the month; a partner hears when they're paid.
    'partner.payout_card_saved': onPartnerPayoutCardSaved,
    'partner.payout_declined': onPartnerPayoutDeclined,
    'partner.payout_failed': onPartnerPayoutDeclined,
    'partner.payout_line_paid': onPartnerPayoutLinePaid,
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
      // Booked through a partner's link: the customer becomes that partner's client (partners/handlers.ts).
      onPartnerBooking,
    ],
    'appointment.updated': onAppointmentChanged,
    'appointment.rescheduled': [
      onAppointmentChanged,
      onArmReminders,
      onMovedNotice,
      onArmJobCheck,
      onWaitedForChanged,
    ],
    'appointment.still_going': onStillGoing,
    'appointment.reassigned': [onAppointmentChanged, onReassignedNotice],
    'appointment.cancelled': [
      onAppointmentChanged,
      onCancelledNotice,
      onCancelledTeamEmail,
      onWaitedForChanged,
    ],
    // The Deleted bin (bin/index.ts): what went in comes out of people's calendars and what comes back goes back
    // in; "Delete now" empties it at once.
    'person.deleted': onBinned,
    'appointment.deleted': onBinned,
    'bin.restored': onBinRestored,
    'bin.emptied': onBinEmptied,
    // Automations' "Referral mentioned": a customer's message or call that might name somebody who needs the
    // business is read by the AI in a job of its own (automations/referrals.ts).
    // A customer's HELP is answered with the business's name and number (handlers/help-reply.ts).
    'message.received': [onHelpKeyword, onMessageReferral, onEngaged],
    'call.transcribed': [onCallReferral, onCallPromise],
    // Automations' "Hand-off nobody picked up" (automations/handoff.ts) and "Approvals about to expire"
    // (automations/expiring.ts): the rounds after a hand-off, and the warning before a decision runs out.
    'conversation.handed_off': onHandoffNudge,
    'workflow.approval_requested': onExpiringArm,
    'ai_teammate.drafted': onExpiringArm,
    // Automations' "Learn from corrections": each edit or rejection is read right away (automations/health.ts).
    'ai_teammate.draft_decided': onCorrection,
    // Feedback on a reply: a thumbs down that says something is read into a rule or one question back.
    'ai_teammate.feedback_given': onFeedback,
    'ai_teammate.feedback_answered': onFeedback,
    // Automations' "Outreach campaigns": the AI writes each text, then they go a few an hour once approved
    // (automations/campaigns.ts).
    'campaign.created': onCampaignCreated,
    'campaign.approved': onCampaignSending,
    'campaign.resumed': onCampaignSending,
    'campaign.pace_changed': onCampaignPace,
    'call.completed': [onPipelineEvidence, onEngaged, onAiCallEnded],
    // AI outbound calls: a missed call rung back, and how a call the AI placed ended (ai-calls/index.ts).
    'call.missed': [onMissedCallForAi, onAiCallEnded],
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
    'series.created': [onAppointmentChanged, onArmReminders, onSeriesConfirm],
    'series.cancelled': [onAppointmentChanged, onSeriesCancelledNotice, onWaitedForChanged],
    'waitlist.seat_freed': onSeatFreed,
    // A wait ends with the window of time, or when the session starts or is cancelled (booking/waitlist.ts).
    'waitlist.added': onWaitlistAdded,
    // The knowledge base: website scans and uploaded documents run as jobs (knowledge/scan.ts, document.ts).
    'knowledge_scan.requested': onKnowledgeScanRequested,
    'knowledge_document.added': onKnowledgeDocumentAdded,
    // Quick setup's look at the website, for its screens to start from (ai-setup/read-site.ts).
    'ai_setup.read_requested': onAiSetupReadRequested,
    // The business's logo: made from an upload, or looked for on its website (look/jobs.ts).
    'look.upload_ready': onLookUploadReady,
    'look.find_requested': onLookFindRequested,
    // The agency's pushes (organization-level events): one install job per business (workflows/templates.ts).
    'workflow_template.pushed': onTemplatePushed,
    'knowledge_pack.pushed': onPackPushed,
    // The AI's pass over the whole customer list: its job starts at once (contact-ai/sweep.ts).
    'contact_ai.sweep_started': onSweepStarted,
    // A client let into their portal, or sent the link again: the email with the signed link (portal/invite.ts).
    'portal.access_given': onPortalAccessGiven,
    // Check-ins (round six): the ladder at the planned end, Help at once, the all-clear to whoever was told, and
    // someone outside asked to agree by text (safety/ladder.ts).
    'safety.checked_in': onCheckedIn,
    'safety.extended': onAllClear,
    'safety.checked_out': onAllClear,
    'safety.resolved': onAllClear,
    'safety.help': onHelp,
    'safety_contact.saved': onContactSaved,
  }),
);

// withPush appends last: a booking, an assignment, an approval waiting or a payment queues its push once the event's
// other work is done (push/moments.ts). withAddons adds the add-on lifecycle's handlers, and after everything else
// an event's delivery to each add-on that subscribes to it and runs in the business, as a job of its own
// (addons/index.ts).
//
// The support desk's own events (M13) are added afterwards, outside all of that: they belong to no business,
// so there is no teammate to wake, no workflow to start and nothing to put on anyone's Home.
export const handlers: HandlerMap = {
  // withContactAi appends the AI's look at a customer's tags and details to what happened with them (contact-ai/).
  ...withAddons(withPush(withAttention(withContactAi(ownTeammateAndWorkflows)))),
  ...supportHandlers,
  // Support asking to see a business's private records (Real Estate step 4).
  'support_access.requested': [onSupportAccessRequested],
  // Ideas, the roadmap and What's new (0102): HandsFreeOS's own too, so beside the support desk's.
  ...ideaHandlers,
  // Voting on what's next (0109): the team's pick, told to the businesses that voted for it.
  ...roadmapHandlers,
};
