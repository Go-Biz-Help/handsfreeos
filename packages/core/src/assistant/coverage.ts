/**
 * What the Assistant can do of what the screens do, in one place (the owner, 2026-10-26 and 2026-10-27: everything a
 * person can do, the Assistant can do): the screens' commands it runs as they are, what it never does and why, what
 * it can't do yet, page by page in menu order, and which tool changes each setting. Browser-safe: the worker makes
 * tools from SCREEN_ACTIONS (screen-actions.ts), and packages/core/test/assistant-coverage.test.ts checks every
 * command a screen runs and every setting row against these lists. docs/operations.md, "Keeping the Assistant able to
 * do everything", says how to add to them.
 */
import { AUTOMATIONS, type AutomationDef } from '../automations/catalog';
import type { Permission } from '../permissions';
import { RECORD_KIND_STARTERS, RELATIONSHIP_STARTERS } from '../relationships/starters';

/** Every Automations row, with what each may say about itself (always on). */
const AUTOMATION_ROWS: readonly AutomationDef[] = AUTOMATIONS;

/** One screen command the Assistant runs as it is. */
export interface ScreenAction {
  /**
   * Said on its card, under what it does: what it costs, or what can't be taken back. Every risk-4 command has one.
   */
  readonly warning?: string;
  /**
   * Who it's offered to, when that isn't the command's own permission: one the kernel lets anyone run and that checks
   * who may inside (notifications, say), or one of the agency's, whose organization permission the
   * kernel checks (offered on workspace.update, which every agency owner and admin holds in each of its businesses).
   */
  readonly offeredTo?: Permission;
  /** Said to the model after the command's own description: how to call it the way its screen does. */
  readonly about?: string;
  /**
   * Parts of its input the worker fills, never the model (the address the business's pages are on, a staff credit's
   * reference): left out of the tool's input, so whatever the model says there is dropped.
   */
  readonly filled?: readonly string[];
  /**
   * A change either door takes (a migration's): the model may ask it of the whole agency (`wholeAgency`), as the
   * agency's own page does. The executor then leaves the business's id off, so the kernel checks the agency's own
   * permission; only the agency's owners and admins are let through.
   */
  readonly agencyDoor?: true;
  /**
   * An agency's change that names one of its client businesses (the one to remind, the one to save a setup from): the
   * model may name it (`businessId`, from get_agency_area), said in these words; left out, it is the business asked
   * in. The executor checks it is one of the agency's before putting it on, and the card names it.
   */
  readonly forBusiness?: string;
}

/**
 * The setup wizards' saves take the whole answers document, as their screens send it. The worker puts the model's
 * answers over the ones saved so far, so a screen's own are all it gives.
 */
const SETUP_ANSWERS_ABOUT =
  'Pass only the answers this screen changes, under answers (the AI teammate’s under answers.ai): every other answer stays as it was saved, and the card shows what will change.';
/** Quick setup's answers are the AI teammate's own, so none sit under `ai`. */
const AI_SETUP_ANSWERS_ABOUT =
  'Pass only the answers this screen changes, under answers: every other answer stays as it was saved, and the card shows what will change.';

/** The screens' commands the Assistant runs through tools made from the command, by name. */
export const SCREEN_ACTIONS: Readonly<Record<string, ScreenAction>> = {
  // ---- Home ----
  'addon.dismiss_suggestion': {},
  'addon.mark_news_seen': {},
  'addon_alert.acknowledge': {},
  'attention.cancel_auto': {},
  'attention.restore': {},
  'lead.catch_up': {},
  'referral.create_lead': {},
  'onboarding.as_you_go': {},
  'onboarding.finish': {},
  'onboarding.send_link': {},
  'onboarding.set_view': {},
  'onboarding.skip': {},
  'notification.read': { offeredTo: 'assistant.use' },
  // ---- Inbox and a conversation ----
  'conversation.close_all': {},
  'conversation.move': {},
  'conversation.open': {},
  'conversation.share': {},
  'video_link.create': {},
  'ai_teammate.answer_feedback': {},
  'ai_teammate.give_feedback': {},
  'ai_teammate.retry': {},
  // ---- Contacts and a customer's page ----
  'record.add_tag': {},
  'record.remove_tag': {},
  'custom_record.assign': {},
  'custom_record.unassign': {},
  'maintenance.set_schedule': {},
  'portal_access.give': {},
  'portal_access.revoke': {},
  'record_hold.place': {},
  'record_hold.lift': {
    warning: 'Once it’s lifted, the record’s files and history can be changed and deleted again.',
  },
  'funnel.add_person': {},
  'funnel.decide_suggestion': {},
  'funnel.pause_person': {},
  'funnel.remove_person': {},
  // ---- Calendar and an appointment ----
  'appointment.make_meeting_link': {},
  'attendee.set_attendance': {},
  'call_suggestion.decide': {},
  'job.add_visit': {},
  'session.publish': {},
  'webinar.schedule': {},
  'video_call.admit': {},
  'video_call.end': {},
  'video_call.mute': {},
  'video_call.poll_close': {},
  'video_call.poll_open': {},
  'video_call.poll_skip': {},
  'video_call.remove': {},
  'video_call.set_ai': {},
  'video_call.set_attendee_video': {},
  'video_call.set_poll': {},
  'video_call.set_poll_ai': {},
  'video_call.slide': {},
  'video_call.stage': {},
  'video_call.turn_away': {},
  // ---- Money and plans ----
  'subscription.set_connection': {},
  // ---- Workflows ----
  'workflow.create': {},
  'workflow.publish': {},
  'workflow.restore_version': {},
  'workflow.test': {},
  'workflow_proposal.apply': {},
  // ---- Documents to sign (20261027015200): sending waits for a Confirm card, like every change ----
  // Changing what's on a template is change_document_template, a piece at a time, and Place fields for me is
  // place_template_fields: both save it, so the whole definition is never the model's to copy back.
  'document_template.create': {},
  'document_template.rename': {},
  'document_template.archive': {},
  'document_template.restore': {},
  'document_template.duplicate': {},
  'document.send': {
    about:
      'Read read_document_prefill first, for who each role suggests and what stops it going out; pass each signer by roleKey. Values are only the fields you fill in or change. edits replaces the template’s word changes for this customer whole: pass every one to keep as read_document_prefill lists it, plus theirs, each new one with an id of its own (like e_theirs1) and its line’s box from get_document_pages. To send again one that was voided, declined or ran out of time, as Send it again does, read read_document_prefill with its fromDocumentId, then pass that id as replacesDocumentId.',
  },
  'document.remind': {},
  'document.void': {},
  // ---- Forms and reviews ----
  'form.set_delivery': {},
  'form.use_design_everywhere': {},
  'review_connection.disconnect': {},
  'review_connection.sync_now': {},
  // ---- Ideas ----
  'idea.edit': { offeredTo: 'assistant.use' },
  'idea.set_comment_hidden': { offeredTo: 'assistant.use' },
  // ---- Agency area: the organization's own permission, checked by the kernel; offered as the agency's own tools are ----
  'ai_setup_template.delete': { offeredTo: 'workspace.update' },
  'ai_setup_template.rename': { offeredTo: 'workspace.update' },
  'ai_setup_template.save': {
    offeredTo: 'workspace.update',
    forBusiness:
      'The business whose setup answers are saved, as Save from a business picks it (from get_agency_area); left out, this one',
  },
  'knowledge_pack.create': { offeredTo: 'workspace.update' },
  'knowledge_pack.update': {
    offeredTo: 'workspace.update',
    about:
      'items replaces the pack’s whole list: read the pack with get_agency_area (its packId) first, and pass every item it has with only what was asked changed, added or taken out. archived true archives the pack, and false restores it.',
  },
  'onboarding.remind': {
    offeredTo: 'workspace.update',
    forBusiness:
      'The client business whose own owners get the reminder (from get_agency_area or read_onboarding_clients); left out, this one',
  },
  'organization.add_owner': {
    offeredTo: 'workspace.update',
    warning:
      'They become an owner of the whole agency and every business in it, and only they can step down.',
  },
  'workflow_template.create': { offeredTo: 'workspace.update' },
  'workflow_template.create_from_workflow': { offeredTo: 'workspace.update' },
  'workflow_template.publish': { offeredTo: 'workspace.update' },
  'workflow_template.rename': { offeredTo: 'workspace.update' },
  // Putting yourself on this business, from its Team page, as one of the agency's owners and admins who reach it.
  'workspace.join': { offeredTo: 'workspace.update' },
  // ---- Settings → Account and My calendar ----
  'calendar_connection.disconnect': {},
  'calendar_connection.sync_now': {},
  'meeting_connection.check_settings': {},
  'meeting_connection.disconnect': {},
  'live_meeting_account.disconnect': { offeredTo: 'assistant.use' },
  // ---- Settings → Workspace, Add-ons and Safety ----
  'look.find': {},
  'look.set': {},
  'onboarding.set_enabled': {},
  'addon.save_my_settings': {},
  'addon.vote': {},
  'addon.unvote': {},
  'addon_connection.disconnect': {},
  'safety.check_out': {},
  'safety.extend': {},
  'safety.resolve': {},
  'support_access.decline': {},
  'support_access.end': {},
  'support_access.grant': {
    warning:
      'HandsFreeOS support can then see the private records you see, read-only, for 24 hours.',
  },
  // ---- Settings → Usage & balance ----
  'wallet.set_ai_limit': {},
  'wallet.top_up': { warning: 'This charges the card on file now.' },
  'wallet.forget_card': { warning: 'Automatic top-up goes off with it.' },
  // ---- Settings → Texting & calls ----
  'telephony.enable': {},
  'telephony.disable': {
    warning:
      'This closes the business’s phone account for good. Turning it on again makes a new one.',
  },
  'phone_number.set_recording_notice': {},
  'registration.save_draft': {},
  'registration.request_review': {
    warning:
      'This opens a ticket asking HandsFreeOS to check the texting registration by hand, with what isn’t green. Nothing goes to the carriers until HandsFreeOS approves it.',
  },
  'number_import.start': {},
  'number_import.check_now': {},
  'number_import.cancel': {},
  'number_port.start': {},
  'number_port.save': {},
  'number_port.submit': {
    warning:
      'This sends the port to the carrier. A full port moves calls too, and takes two to four weeks.',
  },
  'number_port.cancel': {
    warning: 'The carrier may already have moved the number, and then it’s too late.',
  },
  'rcs_request.cancel': {},
  'rcs_sender.connect': {},
  // ---- Settings → Email ----
  'mailbox.disconnect': {},
  'email_domain.receive': {},
  'email_domain.stop_receiving': {
    warning:
      'Mail sent to this domain stops arriving here. Point its MX record somewhere else first.',
  },
  'email_address.reassign': {},
  'email_sender_rule.remove': {},
  // ---- Settings → Website chat, Facebook & Instagram ----
  'chat_widget.rotate_key': {
    warning: 'Every chat snippet pasted before stops working until the new one is pasted in.',
  },
  // Disconnecting is a click; connecting again is signing in to Facebook, which only the person can do.
  'meta_account.disconnect': {
    warning:
      'Only you can bring it back, with Connect Facebook in Settings → Facebook & Instagram.',
  },
  'meta_connection.disconnect': {
    warning:
      'Every Page and Instagram account it connected stops answering here. Only you can bring them back, with Connect Facebook in Settings → Facebook & Instagram.',
  },
  // ---- Settings → Calendars ----
  'booking_site.set_page': {},
  // ---- Settings → Payments and Partners ----
  'payment_connection.set_access': {},
  'partner.payout_forget_card': {
    warning: 'What partners are owed waits until a card is back on.',
  },
  'founding.set_renewing': {},
  'founding.claim': { warning: 'The seat is this business’s from now on.' },
  // ---- Settings → AI teammate ----
  'ai_teammate.restore': {},
  'teammate_instruction.create': {},
  'teammate_instruction.update': {},
  'teammate_instruction.delete': {},
  'teammate_lesson.apply': {},
  'teammate_lesson.dismiss': {},
  'funnel.create': {},
  'funnel.save': {},
  'funnel.turn_on': {},
  'funnel.pause': {},
  'funnel.archive': {},
  // ---- AI quick setup and onboarding setup: a screen's answers at a time, from read_ai_setup_get or read_onboarding_setup_get ----
  'ai_setup.save': { about: AI_SETUP_ANSWERS_ABOUT },
  'ai_setup.finish': {
    about: `${AI_SETUP_ANSWERS_ABOUT} baseRevision is state.teammate.revision as read_ai_setup_get gave it, or null with no teammate.`,
    filled: ['pageOrigin'],
  },
  'onboarding_setup.save': {
    about: SETUP_ANSWERS_ABOUT,
    warning:
      'Some screens act as they’re saved: Your business changes the business’s name, kind, address, time zone and website and starts reading the website; Your goal sends its invitations; Your page goes live or off; Your customers can switch on adding them as you go; Your booking page makes the booking page and turns it on; Payments and reviews saves or takes away the review link.',
  },
  'onboarding_setup.finish': {
    about: `${SETUP_ANSWERS_ABOUT} baseRevision is state.teammate.revision as read_onboarding_setup_get gave it, or null with no teammate.`,
    filled: ['pageOrigin'],
    warning: 'Handed to the owner, it emails them an invitation to check it and finish.',
  },
  // ---- Settings → Imports ----
  'import.cancel': {},
  // ---- Settings → Migrations: each step checks the agency's or the business's Migrations permission itself ----
  'migration.create': { offeredTo: 'migrations.manage', agencyDoor: true },
  'migration.scan': { offeredTo: 'migrations.manage', agencyDoor: true },
  'migration.select': { offeredTo: 'migrations.manage', agencyDoor: true },
  'migration.map_scopes': {
    offeredTo: 'migrations.manage',
    agencyDoor: true,
    warning: 'A sub-account set to land in a new business makes that business now.',
  },
  'migration.start': {
    offeredTo: 'migrations.manage',
    agencyDoor: true,
    warning:
      'It brings what was picked from the old system into the business now; no message, invoice or reminder goes out because of it. Taking it all back is Take it back, on the move’s own page (Settings → Migrations or Agency area → Migrations, then the move), which only a person presses.',
  },
  'migration.pause': { offeredTo: 'migrations.manage', agencyDoor: true },
  'migration.resume': { offeredTo: 'migrations.manage', agencyDoor: true },
  'migration.retry': { offeredTo: 'migrations.manage', agencyDoor: true },
  'migration.resolve_merge': { offeredTo: 'migrations.manage', agencyDoor: true },
  // ---- HandsFreeOS's own Admin area: staff only (the owner, 2026-10-27) ----
  'support.ticket.assign': {},
  'support.ticket.dismiss_draft': {},
  'support.ticket.reply': {},
  'support.ticket.request_draft': {},
  'support.ticket.set_priority': {},
  'support.ticket.set_status': {},
  'registration.review.approve': {
    warning:
      'This sends the business’s texting registration to the carriers exactly as it is, with their fees as usual, and tells the business on the ticket.',
  },
  'registration.review.send_back': {
    warning:
      'The business gets this note on the ticket by email, and nothing goes to the carriers.',
  },
  'support.canned_reply.save': {},
  'support.canned_reply.delete': {},
  'support.staff.save_profile': {
    about:
      'Leave signature out to keep the sign-off as it is now: read_platform_me shows your name to customers and sign-off as saved.',
  },
  'support.staff.invite': { warning: 'They can answer HandsFreeOS support once they accept.' },
  'support.staff.resend_invitation': {},
  'support.staff.revoke_invitation': {},
  'support.staff.set_role': { warning: 'This changes what they may do in support straight away.' },
  'support.staff.remove': { warning: 'They lose support access at once.' },
  'support_access.request': {},
  'idea.merge': {},
  'idea.set_hidden': {},
  'idea.set_status': {},
  'idea_area.save': {
    about:
      'Left out, an area’s description, sort and whether it’s archived stay as they are now (read_idea_areas lists every area, archived ones too).',
  },
  'whats_new.save': {},
  'whats_new.publish': {},
  'whats_new.unpublish': {},
  'whats_new.delete': {},
  'addon_grant.give': {},
  'addon_grant.take_back': {},
  'addon_pick.choose': {},
  'ai_provider.set_mode': {},
  'own_business.set': {},
  'phone_listener.set': {},
  'phone_model.set': {},
  'problem_report.set_handled': {},
  'learned_way.set_removed': { warning: 'Set aside, no computer tries it again.' },
  'video_calls.set': {},
  'founding.approve': {
    warning:
      'A free seat goes on their business at once. A paid one is held for them, and its claim link shows on this card once, after you confirm: copy it into an email to them.',
  },
  'founding.decline': {},
  'founding.give': { warning: 'Their business is on the founding plan at once, with its credit.' },
  'founding.revoke': { warning: 'The seat is free for somebody else at once.' },
  'founding.restore': { warning: 'The seat goes back on their business at once.' },
  'founding.set_cap': { warning: 'This changes how many seats the offer has, for everyone.' },
  'founding.set_status': { warning: 'This changes who can see the offer, for everyone.' },
  'partner.set_payouts_open': {
    warning: 'Open, HandsFreeOS charges their card each month and pays their partners.',
  },
  'wallet.adjust': {
    warning: 'This changes their balance, and shows on their statement.',
    // One reference per card, as the screen makes one per dialog: a second credit is never taken for the first.
    filled: ['reference'],
  },
  'wallet.set_stage': { warning: 'This changes what happens when their balance runs out.' },
  'affiliates.save_settings': {
    warning:
      'This changes every affiliate’s share and code limit without one of their own, or whether affiliates are paid: the share for payments from now on, the limit at once, and paying from the next hour, with real money from HandsFreeOS’s Stripe balance.',
  },
  'affiliate.decide': { warning: 'They get an email saying what was decided.' },
  'affiliate.set_status': { warning: 'This changes whether their link credits new businesses.' },
  'affiliate.set_rate': { warning: 'This changes their share, for payments from now on.' },
  'affiliate.set_code': { warning: 'Their old link stops working at once.' },
  'affiliate.set_business': {},
  'affiliate.set_max_discount': {
    warning: 'This changes the most their codes take off, at once, on codes already made too.',
  },
  'affiliates.make_code': {
    warning: 'It works on the plan page at once, for anyone who has it.',
  },
  'affiliates.turn_code': {},
  // ---- Selling HandsFreeOS (/affiliate): anyone signed in ----
  'affiliate.apply': {
    offeredTo: 'assistant.use',
    warning:
      'It goes to HandsFreeOS to decide, and says you live in the US. You agree to the affiliate terms yourself, on Sell HandsFreeOS: press your name at the foot of the side menu.',
  },
  'affiliate.make_code': {
    offeredTo: 'assistant.use',
    warning:
      'It works on the plan page at once, for anyone who has it, and can’t be changed, only turned off.',
  },
  'affiliate.turn_code': { offeredTo: 'assistant.use' },
};

/**
 * What a screen runs that the Assistant never does, and why: the owner's own decisions (it never deletes anything for
 * good, empties the Deleted bin or deletes an add-on's data), and what only the person can do — sign in somewhere,
 * pay on a card's page, pick a file from their own computer, answer a call, or step into another business or view.
 * An add-on's are on its own server module's `notForTheAssistant`.
 */
export const NEVER_FOR_THE_ASSISTANT: Readonly<Record<string, string>> = {
  'account.delete': 'deleting the person’s own account, which only they do, on Account',
  'workspace.delete': 'deleting the whole business for good',
  'bin.empty': 'emptying the Deleted bin, which stays the person’s (the owner, 2026-10-26)',
  'file.delete':
    'deleting a file for good: it skips the Deleted bin and its stored copy is erased, which stays the person’s (the owner, 2026-10-26)',
  'form_response.delete':
    'deleting someone’s answers to a form for good: they skip the Deleted bin, which stays the person’s (the owner, 2026-10-26)',
  'addon.purge': 'deleting an add-on’s data for good (the owner, 2026-10-26)',
  'addon.start_fresh': 'deleting an add-on’s data for good (the owner, 2026-10-26)',
  'migration.rollback':
    'taking back a whole move from another CRM at once, which puts away what it brought (Delete this move finishes them off); the person presses Take it back on the move’s page (the owner, 2026-10-26)',
  'migration.delete':
    'deleting a move from another CRM, which finishes off the records it archived, for good',
  'calendar_connection.connect': 'signing in to Google or Outlook, which only the person can do',
  'mailbox.connect': 'signing in to Outlook or Gmail, which only the person can do',
  'meeting_connection.connect': 'signing in to Zoom, which only the person can do',
  'meta_connection.connect': 'signing in to Facebook, which only the person can do',
  'payment_connection.connect': 'signing in to Stripe or Square, which only the person can do',
  'review_connection.connect': 'signing in to Google or Facebook, which only the person can do',
  'migration.connect':
    'pasting a private token from the CRM the business is leaving, which goes straight to HandsFreeOS and never through the Assistant, so only the person can do it',
  'invitation.accept': 'accepting an invitation, which is the person’s own',
  'affiliate.accept_terms':
    'agreeing to the affiliate terms, which the person reads and agrees to themselves',
  'support.staff.accept': 'accepting a support invitation, which is the person’s own',
  'extension_sign_in.answer': 'letting the browser extension in, which is the person’s own',
  'live_meeting.claim': 'done from HandsFreeOS’s app inside Zoom',
  'form.begin_slides_upload':
    'uploading a live poll’s slides, a PDF from the person’s own computer; they add it on the poll',
  'document_template.begin_upload':
    'uploading a template’s PDF, a file from the person’s own computer; they add it on the template',
  'document_template.set_source':
    'reading in the pages of a PDF the person just uploaded, which goes with the upload',
  'document.sign_now':
    'handing the person’s own phone or computer to a customer who’s with them, to sign on it there',
  'user_phone.start_verification': 'confirming a cell by answering a call on it',
  'call.start': 'a call from the browser, on the person’s own microphone',
  'call.connect_me':
    'a call through the person’s own cell, which rings them first: Call on the Assistant’s call card starts it on the phone',
  'call.cancel_connect': 'hanging up a call through the person’s own cell, on its call sheet',
  'push_device.register': 'the phone signing itself up for notifications, which only the app does',
  'push_device.remove': 'the phone signing itself out of notifications, which only the app does',
  'founding.buy': 'paying on Stripe’s page, which only the person can do',
  'founding.start_checkout': 'paying on Stripe’s page, which only the person can do',
  'founding.pay_renewal': 'paying on Stripe’s page, which only the person can do',
  'rcs_request.submit': 'paying on Stripe’s page, which only the person can do',
  'rcs_request.pay_renewal': 'paying on Stripe’s page, which only the person can do',
  'texting_fee.pay': 'paying on Stripe’s page, which only the person can do',
  'file.begin_upload': 'a file from the person’s own computer or phone',
  'file.confirm': 'a file from the person’s own computer or phone',
  'knowledge_document.begin_upload': 'a file from the person’s own computer or phone',
  'knowledge_document.add': 'a file from the person’s own computer or phone',
  'import.create': 'a spreadsheet from the person’s own computer',
  'import.start': 'a spreadsheet from the person’s own computer',
  'look.begin_upload': 'a picture from the person’s own computer or phone',
  'look.use_upload': 'a picture from the person’s own computer or phone',
  'number_port.begin_upload': 'a file from the person’s own computer or phone',
  'number_port.attach_document': 'a file from the person’s own computer or phone',
  'organization.create': 'a new business is set up on its own pages, where it pays',
  'platform.view_as.start':
    'looking at a business as support changes this screen, which only the person starts',
  'platform.view_as.end':
    'looking at a business as support changes this screen, which only the person ends',
  'teammate_view.start': 'looking as a teammate changes this screen, which only the person starts',
  'teammate_view.end': 'looking as a teammate changes this screen, which only the person ends',
  'assistant_thread.archive': 'the panel’s own list of chats',
  'assistant_thread.rename': 'the panel’s own list of chats',
  'notification.seen': 'the bell counting what the person has looked at, as they look',
  'whats_new.mark_seen': 'What’s new noting it was read, as it’s read',
  'template.used': 'the composer counting which templates get used',
  'workflow_proposal.mark_applied': 'the workflow editor saying it applied a proposal itself',
};

/** A page's actions the Assistant can't do yet, and why: what the daily routine works through, in menu order. */
export interface NotYet {
  /** The page, as the side menu and its tabs name it. */
  readonly page: string;
  readonly actions: readonly string[];
  readonly why: string;
}

export const ASSISTANT_NOT_YET: readonly NotYet[] = [
  {
    page: 'Settings → Safety (phone)',
    actions: ['safety.check_in', 'safety.help', 'safety_contact.save', 'safety_contact.remove'],
    why: 'Found when the check began reading the phone’s own changes (6 November). Checking in, asking for help and choosing who is told are the phone’s safety screens, still to be checked for what the Assistant may do there.',
  },
];

// ---------- settings: every row on the Settings pages (settings/catalog.ts) ----------

/** One way the Assistant changes a setting: the tool, the input it sets, and for a list of choices the one this is. */
export interface SettingWay {
  readonly tool: string;
  /** The tool's input that sets it, as a path: `turnOn`, `settings.links.review`. */
  readonly field: string;
  /** The choice it is, when the input is a list of them: `missedCall`. */
  readonly value?: string;
}

/** Which tool changes each setting row, by its key in the settings catalogue. */
export const SETTING_TOOLS: Readonly<Record<string, readonly SettingWay[]>> = {
  // ---- Account ----
  'account.profile': [{ tool: 'update_my_account', field: 'fullName' }],
  'account.appearance': [{ tool: 'update_my_account', field: 'appearance' }],
  'account.menu': [{ tool: 'arrange_my_menu', field: 'places' }],
  'account.notifications': [
    { tool: 'update_my_alerts', field: 'turnOn' },
    { tool: 'update_my_alerts', field: 'turnOff' },
  ],
  'notifications.customer_waiting': [
    { tool: 'update_my_alerts', field: 'turnOn', value: 'customerWaiting' },
  ],
  'notifications.missed_call': [{ tool: 'update_my_alerts', field: 'turnOn', value: 'missedCall' }],
  'notifications.urgent': [
    { tool: 'update_my_alerts', field: 'turnOn', value: 'urgent' },
    { tool: 'update_my_account', field: 'emailWhenCustomerWaiting' },
  ],
  'notifications.approvals': [{ tool: 'update_my_alerts', field: 'turnOn', value: 'approval' }],
  'notifications.appointments': [
    { tool: 'update_my_alerts', field: 'turnOn', value: 'booking' },
    { tool: 'update_my_account', field: 'emailWhenBooked' },
  ],
  'notifications.assigned': [{ tool: 'update_my_alerts', field: 'turnOn', value: 'assigned' }],
  'notifications.qualifying': [{ tool: 'update_my_alerts', field: 'turnOn', value: 'qualifying' }],
  'notifications.documents': [{ tool: 'update_my_alerts', field: 'turnOn', value: 'documents' }],
  'notifications.payments': [
    { tool: 'update_my_alerts', field: 'turnOn', value: 'payment' },
    { tool: 'update_my_account', field: 'emailWhenPaid' },
  ],
  'notifications.balance': [{ tool: 'update_my_alerts', field: 'turnOn', value: 'wallet' }],
  'notifications.jobs': [{ tool: 'update_my_alerts', field: 'turnOn', value: 'jobs' }],
  'notifications.connections': [
    { tool: 'update_my_alerts', field: 'turnOn', value: 'connections' },
  ],
  'notifications.addons': [
    { tool: 'update_my_alerts', field: 'turnOn', value: 'addons' },
    { tool: 'update_my_account', field: 'emailWhenAddonNeedsYou' },
  ],
  'notifications.support_tickets': [
    { tool: 'update_my_support_alerts', field: 'turnOn', value: 'supportTickets' },
  ],
  'notifications.morning_summary': [{ tool: 'update_my_account', field: 'morningEmail' }],
  'notifications.end_of_day': [{ tool: 'update_my_account', field: 'eveningEmail' }],
  'notifications.ai_handoff': [{ tool: 'update_my_account', field: 'emailWhenAiHandsOver' }],
  'notifications.agency_digest': [{ tool: 'update_my_alerts', field: 'agencyDigestEmail' }],
  // ---- My calendar ----
  'my_calendar.weekly_hours': [
    { tool: 'update_my_hours', field: 'weekly' },
    { tool: 'update_my_hours', field: 'timeZone' },
  ],
  'my_calendar.time_off': [{ tool: 'update_my_hours', field: 'action', value: 'add_time_off' }],
  'my_calendar.connection': [
    { tool: 'do_calendar_connection_disconnect', field: 'connectionId' },
    { tool: 'do_calendar_connection_sync_now', field: 'connectionId' },
  ],
  'my_calendar.video': [{ tool: 'do_meeting_connection_disconnect', field: 'connectionId' }],
  // ---- Workspace ----
  'workspace.name': [{ tool: 'update_business', field: 'name' }],
  'workspace.time_zone': [{ tool: 'update_business', field: 'timezone' }],
  'workspace.industry': [{ tool: 'update_business', field: 'industry' }],
  'workspace.website': [{ tool: 'update_business', field: 'website' }],
  'workspace.review_link': [{ tool: 'update_business', field: 'reviewLink' }],
  'workspace.hours': [{ tool: 'update_business', field: 'openHours' }],
  // A logo from the person's own computer is theirs to add (look.begin_upload is on the Never list).
  'workspace.look': [
    { tool: 'do_look_set', field: 'color' },
    { tool: 'do_look_set', field: 'removeLogo' },
  ],
  'workspace.your_page': [{ tool: 'do_booking_site_set_page', field: 'on' }],
  'workspace.getting_started': [{ tool: 'do_onboarding_set_enabled', field: 'enabled' }],
  'workspace.branded_domain': [
    { tool: 'manage_web_address', field: 'action', value: 'add' },
    { tool: 'manage_web_address', field: 'action', value: 'remove' },
  ],
  // ---- Permissions ----
  'permissions.who_can': [{ tool: 'manage_permissions', field: 'action', value: 'set_role' }],
  'permissions.defaults': [{ tool: 'manage_permissions', field: 'action', value: 'reset_role' }],
  'permissions.people': [
    { tool: 'manage_permissions', field: 'action', value: 'set_person' },
    { tool: 'manage_permissions', field: 'action', value: 'reset_person' },
  ],
  // ---- Automations: each row's switch by its id, wherever the switch lives; an always-on row is on the Never list ----
  ...Object.fromEntries(
    AUTOMATION_ROWS.filter((a) => !a.locked).map((a) => [
      `automation.${a.id}`,
      [
        { tool: 'update_automations', field: 'turnOn', value: a.id },
        { tool: 'update_automations', field: 'turnOff', value: a.id },
      ],
    ]),
  ),
  'adjust.urgent_after': [
    { tool: 'update_action_center_settings', field: 'hotLeadUrgentAfterMinutes' },
  ],
  'adjust.big_job': [{ tool: 'update_action_center_settings', field: 'bigJobDollars' }],
  'adjust.typical_value': [
    { tool: 'update_action_center_settings', field: 'typicalJobValueDollars' },
  ],
  'adjust.reply_c': [{ tool: 'update_action_center_settings', field: 'replyCToConfirm' }],
  'adjust.maintenance_plan': [{ tool: 'update_automations', field: 'maintenancePlanMessage' }],
  'adjust.ignore_balances': [
    { tool: 'update_action_center_settings', field: 'ignoreBalancesUnderDollars' },
  ],
  'adjust.stage_meanings': [{ tool: 'update_automations', field: 'stageMeanings' }],
  'adjust.gone_quiet': [{ tool: 'update_action_center_settings', field: 'goneQuietAfterDays' }],
  'adjust.gone_cold': [{ tool: 'update_automations', field: 'reengageAfterDays' }],
  'adjust.voicemail_box': [{ tool: 'update_automations', field: 'whenVoicemailAnswers' }],
  'adjust.how_you_tag': [{ tool: 'update_automations', field: 'howYouTag' }],
  'adjust.calling_hours': [
    { tool: 'update_automations', field: 'callLeadsFrom' },
    { tool: 'update_automations', field: 'callLeadsUntil' },
    { tool: 'update_automations', field: 'callLeadsAtWeekends' },
  ],
  'adjust.call_tries': [{ tool: 'update_automations', field: 'callTries' }],
  'adjust.ok_to_call': [{ tool: 'update_automations', field: 'askForOkToCall' }],
  'adjust.business_landlines': [{ tool: 'update_automations', field: 'callBusinessLandlines' }],
  // ---- Safety ----
  'safety.check_ins': [
    { tool: 'update_safety_settings', field: 'askAfterMinutes' },
    { tool: 'update_safety_settings', field: 'alertAfterMinutes' },
    { tool: 'update_safety_settings', field: 'safetyUserId' },
  ],
  // ---- Usage & balance: the card itself is typed on the payment provider's page, which only the person does ----
  'usage.balance': [{ tool: 'do_wallet_top_up', field: 'amountCents' }],
  'usage.auto_top_up': [
    { tool: 'update_auto_topup', field: 'on' },
    { tool: 'update_auto_topup', field: 'belowDollars' },
    { tool: 'update_auto_topup', field: 'addDollars' },
  ],
  'usage.ai_limit': [{ tool: 'do_wallet_set_ai_limit', field: 'aiDailyLimitCents' }],
  // Buying a seat is on Stripe's page (founding.buy is on the Never list); renewing is the business's switch.
  'usage.founding': [{ tool: 'do_founding_set_renewing', field: 'renewing' }],
  // ---- Texting & calls: the calls rows change the default number, as the screen does ----
  'texting.inbox_visibility': [{ tool: 'set_inbox_visibility', field: 'eachPersonSeesTheirOwn' }],
  'texting.number': [
    { tool: 'manage_phone_number', field: 'action', value: 'get' },
    { tool: 'manage_phone_number', field: 'action', value: 'give_up' },
    { tool: 'manage_numbers', field: 'action', value: 'rename' },
    { tool: 'manage_numbers', field: 'action', value: 'make_default' },
    { tool: 'manage_numbers', field: 'action', value: 'choose_who_it_rings' },
    { tool: 'do_number_port_start', field: 'e164' },
    { tool: 'do_number_import_start', field: 'e164' },
  ],
  // The campaign fee is paid on Stripe's page (texting_fee.pay is on the Never list).
  'texting.registration': [
    { tool: 'submit_carrier_registration', field: 'kind' },
    { tool: 'do_registration_save_draft', field: 'answers' },
  ],
  // Asking for a sender is paid on Stripe's page (rcs_request.submit is on the Never list); HandsFreeOS makes it.
  'texting.rcs': [
    { tool: 'do_rcs_sender_connect', field: 'senderId' },
    { tool: 'manage_rcs', field: 'action', value: 'check_now' },
    { tool: 'manage_rcs', field: 'action', value: 'disconnect' },
  ],
  'texting.rcs_send': [
    { tool: 'manage_rcs', field: 'action', value: 'pause' },
    { tool: 'manage_rcs', field: 'action', value: 'turn_on' },
  ],
  'texting.rcs_line': [
    { tool: 'manage_rcs', field: 'action', value: 'start_on_number' },
    { tool: 'manage_rcs', field: 'phoneNumberId' },
  ],
  'texting.quiet_hours': [
    { tool: 'update_texting_settings', field: 'quietHoursEnabled' },
    { tool: 'update_texting_settings', field: 'quietHoursStart' },
    { tool: 'update_texting_settings', field: 'quietHoursEnd' },
  ],
  'texting.remind_waiting': [{ tool: 'update_texting_settings', field: 'remindTeamAfterMinutes' }],
  'texting.calls': [{ tool: 'update_texting_settings', field: 'ringPhones' }],
  'texting.ring_for': [{ tool: 'update_texting_settings', field: 'ringSeconds' }],
  'texting.caller_id': [{ tool: 'update_texting_settings', field: 'showCustomerNumber' }],
  'texting.recording': [
    { tool: 'do_phone_number_set_recording_notice', field: 'announceRecording' },
  ],
  'texting.voicemail': [
    { tool: 'update_texting_settings', field: 'voicemailEnabled' },
    { tool: 'update_texting_settings', field: 'voicemailGreeting' },
  ],
  // ---- Email: connecting a mailbox is signing in to Microsoft, which only the person does (mailbox.connect) ----
  'email.sending_address': [
    { tool: 'manage_email_settings', field: 'action', value: 'add_address' },
    { tool: 'manage_email_settings', field: 'action', value: 'change_address' },
    { tool: 'manage_email_settings', field: 'displayName' },
    { tool: 'manage_email_settings', field: 'isDefault' },
    { tool: 'manage_email_settings', field: 'ownerUserId' },
    { tool: 'do_email_address_reassign', field: 'to' },
  ],
  'email.own_domain': [
    { tool: 'manage_email_settings', field: 'action', value: 'add_domain' },
    { tool: 'manage_email_settings', field: 'action', value: 'check_domain' },
    { tool: 'manage_email_settings', field: 'action', value: 'remove_domain' },
    { tool: 'manage_email_settings', field: 'emailDomainId' },
    { tool: 'do_email_domain_receive', field: 'emailDomainId' },
    { tool: 'do_email_domain_stop_receiving', field: 'emailDomainId' },
  ],
  'email.mailboxes': [{ tool: 'do_mailbox_disconnect', field: 'connectionId' }],
  'email.blocked': [
    { tool: 'manage_email_settings', field: 'action', value: 'unblock' },
    { tool: 'block_email_address', field: 'address' },
  ],
  'email.unknown_senders': [
    { tool: 'sort_unmatched_email', field: 'action', value: 'file_under_customer' },
    { tool: 'sort_unmatched_email', field: 'action', value: 'dismiss' },
  ],
  'email.sender_rules': [{ tool: 'do_email_sender_rule_remove', field: 'address' }],
  // Settings → Website chat, and each chat in Forms → Website chats, changed as its screen does.
  'website_chat.who_answers': [{ tool: 'manage_website_chat', field: 'answeredByAi' }],
  'website_chat.daily_limit': [{ tool: 'manage_website_chat', field: 'dailyCap' }],
  'website_chat.sites': [
    { tool: 'manage_website_chat', field: 'action', value: 'create' },
    { tool: 'manage_website_chat', field: 'websites', value: 'https://lonestarhvac.com' },
  ],
  'website_chat.install': [{ tool: 'do_chat_widget_rotate_key', field: 'widgetId' }],
  'website_chat.look': [
    { tool: 'manage_website_chat', field: 'name' },
    { tool: 'manage_website_chat', field: 'greeting' },
    { tool: 'manage_website_chat', field: 'buttonLabel' },
    { tool: 'manage_website_chat', field: 'color', value: '#2d69d8' },
    { tool: 'manage_website_chat', field: 'textColor', value: 'automatic' },
    { tool: 'manage_website_chat', field: 'topBarColor', value: '#191d25' },
  ],
  'website_chat.logo': [{ tool: 'manage_website_chat', field: 'showLogo' }],
  'website_chat.placement': [
    { tool: 'manage_website_chat', field: 'position', value: 'left' },
    { tool: 'manage_website_chat', field: 'phonePosition', value: 'same_as_computer' },
    { tool: 'manage_website_chat', field: 'computerLift' },
    { tool: 'manage_website_chat', field: 'phoneLift' },
    { tool: 'manage_website_chat', field: 'computerButton', value: 'icon' },
    { tool: 'manage_website_chat', field: 'phoneButton', value: 'hidden' },
  ],
  'website_chat.away': [
    { tool: 'manage_website_chat', field: 'whenNobodyAnswers', value: 'chat' },
    { tool: 'manage_website_chat', field: 'awayMessage' },
    { tool: 'manage_website_chat', field: 'askFor.name', value: 'when_needed' },
    { tool: 'manage_website_chat', field: 'askFor.phone', value: 'after_first_message' },
    { tool: 'manage_website_chat', field: 'askFor.email', value: 'never' },
  ],
  'website_chat.text_box': [{ tool: 'manage_website_chat', field: 'askForSmsConsent' }],
  // ---- Facebook & Instagram ----
  'facebook_instagram.accounts': [{ tool: 'do_meta_account_disconnect', field: 'accountId' }],
  'facebook_instagram.sign_in': [{ tool: 'do_meta_connection_disconnect', field: 'connectionId' }],
  // ---- Lead intake ----
  'lead_intake.channels': [
    ...['text', 'call', 'email', 'messenger', 'instagram', 'facebook_lead_ad', 'indeed'].map(
      (value) => ({ tool: 'manage_lead_intake', field: 'channel', value }),
    ),
    { tool: 'manage_lead_intake', field: 'active' },
    { tool: 'manage_lead_intake', field: 'createLead' },
    { tool: 'manage_lead_intake', field: 'pipelineId' },
    { tool: 'manage_lead_intake', field: 'stageId' },
    { tool: 'manage_lead_intake', field: 'name' },
    { tool: 'manage_lead_intake', field: 'dailyCap' },
  ],
  'lead_intake.sources': [
    ...['create', 'change', 'new_key', 'pause', 'turn_on', 'retire'].map((value) => ({
      tool: 'manage_lead_form',
      field: 'action',
      value,
    })),
    { tool: 'manage_lead_form', field: 'websites' },
    { tool: 'manage_lead_form', field: 'thankYouPage' },
  ],
  // ---- Tags ----
  'tags.list': [
    ...['create', 'change', 'delete'].map((value) => ({
      tool: 'manage_tag',
      field: 'action',
      value,
    })),
    { tool: 'manage_tag', field: 'name' },
    { tool: 'manage_tag', field: 'color' },
  ],
  'tags.ai_tagging': [
    ...['start', 'stop'].map((value) => ({ tool: 'ai_tag_customers', field: 'action', value })),
    { tool: 'ai_tag_customers', field: 'instructions' },
    { tool: 'ai_tag_customers', field: 'tagIds' },
    { tool: 'ai_tag_customers', field: 'onlyTagId' },
    { tool: 'ai_tag_customers', field: 'fixDetails' },
  ],
  // ---- Relationships ----
  'relationships.record_kinds': [
    ...['create', 'change', 'archive', 'restore'].map((value) => ({
      tool: 'manage_record_kind',
      field: 'action',
      value,
    })),
    ...RECORD_KIND_STARTERS.map((s) => ({
      tool: 'manage_record_kind',
      field: 'starter',
      value: s.key,
    })),
    ...[
      'name',
      'plural',
      'nameLabel',
      'icon',
      'fields',
      'linkTo',
      'linkLabel',
      'linkCardinality',
    ].map((field) => ({ tool: 'manage_record_kind', field })),
  ],
  'relationships.types': [
    ...['create', 'change', 'archive', 'restore'].map((value) => ({
      tool: 'manage_relationship_type',
      field: 'action',
      value,
    })),
    ...RELATIONSHIP_STARTERS.map((s) => ({
      tool: 'manage_relationship_type',
      field: 'starter',
      value: s.key,
    })),
    ...['a', 'b', 'cardinality', 'sameBothWays', 'aLabel', 'bLabel'].map((field) => ({
      tool: 'manage_relationship_type',
      field,
    })),
  ],
  // ---- Calendars ----
  'calendars.services': [
    ...['create', 'change', 'archive'].map((value) => ({
      tool: 'manage_service',
      field: 'action',
      value,
    })),
    ...[
      'name',
      'durationsMinutes',
      'priceDollars',
      'bufferBeforeMinutes',
      'bufferAfterMinutes',
      'repeatMonths',
      'staffUserIds',
      'resources',
      'hours',
    ].map((field) => ({ tool: 'manage_service', field })),
  ],
  'calendars.resources': [
    ...['create', 'change', 'archive'].map((value) => ({
      tool: 'manage_resource',
      field: 'action',
      value,
    })),
    ...['room', 'equipment', 'vehicle', 'property', 'chair', 'other'].map((value) => ({
      tool: 'manage_resource',
      field: 'kind',
      value,
    })),
    ...['name', 'quantity', 'location', 'hours'].map((field) => ({
      tool: 'manage_resource',
      field,
    })),
  ],
  // An area drawn on the map is drawn there (a handover in the settings map); the rest is here.
  'calendars.territories': [
    ...['create', 'change', 'delete'].map((value) => ({
      tool: 'manage_territory',
      field: 'action',
      value,
    })),
    ...['name', 'postalCodes', 'milesFrom', 'userIds'].map((field) => ({
      tool: 'manage_territory',
      field,
    })),
  ],
  'calendars.booking_site': ['slug', 'name', 'intro', 'enabled'].map((field) => ({
    tool: 'update_booking_site',
    field,
  })),
  // ---- Payments ----
  // Connecting Stripe or Square is signing in to them (payment_connection.connect is NEVER, with a handover);
  // what is already connected is here.
  'payments.accounts': [
    ...['rename', 'make_default', 'disconnect'].map((value) => ({
      tool: 'manage_payment_account',
      field: 'action',
      value,
    })),
    { tool: 'manage_payment_account', field: 'label' },
    { tool: 'manage_payment_account', field: 'keepPlansBilling' },
    { tool: 'do_payment_connection_set_access', field: 'usedBy' },
    { tool: 'do_payment_connection_set_access', field: 'userIds' },
  ],
  'payments.ways_to_pay': [{ tool: 'update_money_settings', field: 'offerBankTransfer' }],
  'payments.bank_transfer': [
    { tool: 'update_money_settings', field: 'offerBankTransfer' },
    { tool: 'update_numbering_and_ways_to_pay', field: 'offerBankTransfer' },
  ],
  'payments.tax': ['taxRatePercent', 'taxName', 'newItemsTaxable'].map((field) => ({
    tool: 'update_money_settings',
    field,
  })),
  'payments.tax_rate': [{ tool: 'update_money_settings', field: 'taxRatePercent' }],
  'payments.tax_name': [{ tool: 'update_money_settings', field: 'taxName' }],
  'payments.taxable': [{ tool: 'update_money_settings', field: 'newItemsTaxable' }],
  'payments.numbering': [
    'invoicePrefix',
    'invoiceNextNumber',
    'estimatePrefix',
    'estimateNextNumber',
  ].map((field) => ({ tool: 'update_numbering_and_ways_to_pay', field })),
  'payments.address': [{ tool: 'update_money_settings', field: 'businessAddress' }],
  'payments.terms': ['terms', 'estimateGoodForDays', 'invoiceNote', 'estimateNote'].map(
    (field) => ({ tool: 'update_money_settings', field }),
  ),
  'payments.due': ['due_on_receipt', 'net_7', 'net_14', 'net_30'].map((value) => ({
    tool: 'update_money_settings',
    field: 'terms',
    value,
  })),
  'payments.estimate_valid': [{ tool: 'update_money_settings', field: 'estimateGoodForDays' }],
  'payments.deposits': [
    ...['none', 'percent', 'amount'].map((value) => ({
      tool: 'update_money_settings',
      field: 'depositKind',
      value,
    })),
    { tool: 'update_money_settings', field: 'depositPercent' },
    { tool: 'update_money_settings', field: 'depositDollars' },
  ],
  'payments.reminders': [
    'remindBeforeDueDays',
    'remindOnDueDay',
    'remindAfterDueDays',
    'nudgeEstimateAfterDays',
  ].map((field) => ({ tool: 'update_money_settings', field })),
  // ---- Partners ----
  'partners.pay': ['sharePercent', 'smallestPayout', 'calendarId'].map((field) => ({
    tool: 'update_partner_settings',
    field,
  })),
  'partners.terms': [{ tool: 'update_partner_settings', field: 'terms' }],
  // ---- Add-ons' own settings pages: what the add-on's schema holds, merged into what is set now ----
  'addon.realestate.page.settings': [
    { tool: 'update_addon_settings', field: 'addonId' },
    { tool: 'update_addon_settings', field: 'settings' },
  ],
};

/** Setting rows the Assistant never changes, and why. */
export const SETTINGS_NEVER: Readonly<Record<string, string>> = {
  'account.password': 'signing in is the person’s own',
  'account.google_sign_in': 'signing in is the person’s own',
  'account.passkeys': 'signing in is the person’s own',
  'account.my_cell': 'confirming a cell by answering a call on it',
  'account.delete_account': 'deleting the person’s own account, which only they do',
  'workspace.delete': 'deleting the whole business for good, which only its owner does',
  'phone.lock': 'a setting of the phone in their hand, set on it',
  'phone.businesses': 'a setting of the phone in their hand, set on it',
  'phone.documents_mobile_data': 'a setting of the phone in their hand, set on it',
  'phone.changes': 'a setting of the phone in their hand, set on it',
  'phone.my_safety': 'the person’s own safety contacts, which only they choose',
  'safety.preview': 'nothing of its own to change: it shows what the check-in times set',
  'usage.card':
    'the card is typed on the payment provider’s own page, which only the person can do (do_wallet_forget_card takes it off)',
  'usage.prices':
    'HandsFreeOS’s own prices, to read (get_settings, area usage): nothing here is the business’s to change',
  'usage.statement':
    'what was charged and added, to read (get_settings, area usage): nothing to change',
  'texting.stop_help':
    'always on: every text answers STOP, START and HELP by itself, and an opted-out customer stays opted out until they text START',
  'website_chat.try':
    'a preview page the person opens to chat with their own chat box; test chats create and send nothing, so there is nothing to set',
  'tags.ai_changes':
    'what the AI changed lately and why, to read (ai_tagging_status): nothing to set, and a tag it put on comes off with tag_customers',
  'partners.payouts':
    'the card partner payouts are charged to is typed on the payment provider’s own page, which only the person can do (do_partner_payout_forget_card takes it off); what each partner is owed, the next payout and each month’s statement are read with get_settings (area partners)',
  'payments.card':
    'always on, with nothing to switch: every customer can pay by card, Apple Pay or Google Pay, and nothing is ever added for paying that way',
  'payments.cash':
    'never offered to customers, so nothing to set; a cash or cheque payment is recorded by hand on its invoice (record_payment)',
  'facebook_instagram.lead_ads':
    'what each Page’s lead ads send in, to read (get_settings, area facebook_instagram); letting leads in is connecting Facebook again or Meta’s own Leads Access, which only the person can do, and whether they open a lead is Lead intake’s (manage_lead_intake)',
  ...Object.fromEntries(
    AUTOMATION_ROWS.filter((a) => a.locked).map((a) => [
      `automation.${a.id}`,
      'always on, so a person always sees what waits on them: it has no switch',
    ]),
  ),
};

/**
 * The Settings pages (and add-ons' settings) whose rows aren't checked yet, in menu order: the daily routine takes
 * the first, says which tool changes each of its rows (adding what's missing), and takes it off.
 */
export const SETTINGS_NOT_YET: readonly string[] = [];
