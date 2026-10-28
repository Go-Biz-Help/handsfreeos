/**
 * What the Assistant can do of what the screens do, in one place (the owner, 2026-10-26 and 2026-10-27: everything a
 * person can do, the Assistant can do): the screens' commands it runs as they are, what it never does and why, what
 * it can't do yet, page by page in menu order, and which tool changes each setting. Browser-safe: the worker makes
 * tools from SCREEN_ACTIONS (screen-actions.ts), and packages/core/test/assistant-coverage.test.ts checks every
 * command a screen runs and every setting row against these lists. docs/operations.md, "Keeping the Assistant able to
 * do everything", says how to add to them.
 */
import type { Permission } from '../permissions';

/** One screen command the Assistant runs as it is. */
export interface ScreenAction {
  /**
   * Said on its card, under what it does: what it costs, or what can't be taken back. Every risk-4 command has one.
   */
  readonly warning?: string;
  /**
   * Who it's offered to, when that isn't the command's own permission: one the kernel lets anyone run and that checks
   * who may inside (notifications, an add-on's settings), or one of the agency's, whose organization permission the
   * kernel checks (offered on workspace.update, which every agency owner and admin holds in each of its businesses).
   */
  readonly offeredTo?: Permission;
}

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
  'video_call.admit': {},
  'video_call.end': {},
  'video_call.mute': {},
  'video_call.remove': {},
  'video_call.set_ai': {},
  'video_call.turn_away': {},
  // ---- Money and plans ----
  'subscription.set_connection': {},
  // ---- Workflows ----
  'workflow.create': {},
  'workflow.publish': {},
  'workflow.restore_version': {},
  'workflow.test': {},
  'workflow_proposal.apply': {},
  // ---- Forms and reviews ----
  'form.set_delivery': {},
  'review_connection.disconnect': {},
  'review_connection.sync_now': {},
  // ---- Ideas ----
  'idea.edit': { offeredTo: 'assistant.use' },
  'idea.set_comment_hidden': { offeredTo: 'assistant.use' },
  // ---- Agency area: the organization's own permission, checked by the kernel; offered as the agency's own tools are ----
  'ai_setup_template.delete': { offeredTo: 'workspace.update' },
  'ai_setup_template.rename': { offeredTo: 'workspace.update' },
  'ai_setup_template.save': { offeredTo: 'workspace.update' },
  'knowledge_pack.create': { offeredTo: 'workspace.update' },
  'knowledge_pack.update': { offeredTo: 'workspace.update' },
  'onboarding.remind': { offeredTo: 'workspace.update' },
  'organization.add_owner': {
    offeredTo: 'workspace.update',
    warning:
      'They become an owner of the whole agency and every business in it, and only they can step down.',
  },
  'workflow_template.create': { offeredTo: 'workspace.update' },
  'workflow_template.create_from_workflow': { offeredTo: 'workspace.update' },
  'workflow_template.publish': { offeredTo: 'workspace.update' },
  'workflow_template.rename': { offeredTo: 'workspace.update' },
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
  'addon.save_settings': { offeredTo: 'workspace.read' },
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
  // ---- Settings → Website chat, Facebook & Instagram, Lead intake ----
  'chat_widget.rotate_key': {
    warning: 'Every chat snippet pasted before stops working until the new one is pasted in.',
  },
  'meta_account.disconnect': {},
  'meta_connection.disconnect': {},
  'intake_source.create': {},
  'intake_source.rotate_key': {
    warning:
      'Every copy of the old key stops working at once, on the website and in any connected app.',
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
  // ---- Settings → Imports ----
  'import.cancel': {},
  // ---- HandsFreeOS's own Admin area: staff only (the owner, 2026-10-27) ----
  'support.ticket.assign': {},
  'support.ticket.dismiss_draft': {},
  'support.ticket.reply': {},
  'support.ticket.request_draft': {},
  'support.ticket.set_priority': {},
  'support.ticket.set_status': {},
  'support.canned_reply.save': {},
  'support.canned_reply.delete': {},
  'support.staff.save_profile': {},
  'support.staff.invite': { warning: 'They can answer HandsFreeOS support once they accept.' },
  'support.staff.resend_invitation': {},
  'support.staff.revoke_invitation': {},
  'support.staff.set_role': { warning: 'This changes what they may do in support straight away.' },
  'support.staff.remove': { warning: 'They lose support access at once.' },
  'support_access.request': {},
  'idea.merge': {},
  'idea.set_hidden': {},
  'idea.set_status': {},
  'idea_area.save': {},
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
  'video_calls.set': {},
  'founding.approve': { warning: 'A free seat goes on their business at once.' },
  'founding.decline': {},
  'founding.give': { warning: 'Their business is on the founding plan at once, with its credit.' },
  'founding.revoke': { warning: 'The seat is free for somebody else at once.' },
  'founding.restore': { warning: 'The seat goes back on their business at once.' },
  'founding.set_cap': { warning: 'This changes how many seats the offer has, for everyone.' },
  'founding.set_status': { warning: 'This changes who can see the offer, for everyone.' },
  'partner.set_payouts_open': {
    warning: 'Open, HandsFreeOS charges their card each month and pays their partners.',
  },
  'wallet.adjust': { warning: 'This changes their balance, and shows on their statement.' },
  'wallet.set_stage': { warning: 'This changes what happens when their balance runs out.' },
  'affiliates.save_settings': {
    warning:
      'This changes every affiliate’s share without one of their own, for payments from now on.',
  },
  'affiliate.decide': { warning: 'They get an email saying what was decided.' },
  'affiliate.set_status': { warning: 'This changes whether their link credits new businesses.' },
  'affiliate.set_rate': { warning: 'This changes their share, for payments from now on.' },
  'affiliate.set_code': { warning: 'Their old link stops working at once.' },
  'affiliate.set_business': {},
  // ---- Selling HandsFreeOS (/affiliate): anyone signed in ----
  'affiliate.apply': {
    offeredTo: 'assistant.use',
    warning: 'It goes to HandsFreeOS to decide, and says you live in the US.',
  },
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
  'addon.purge': 'deleting an add-on’s data for good (the owner, 2026-10-26)',
  'addon.start_fresh': 'deleting an add-on’s data for good (the owner, 2026-10-26)',
  'migration.rollback': 'taking back everything a move from another CRM brought, for good',
  'calendar_connection.connect': 'signing in to Google or Outlook, which only the person can do',
  'mailbox.connect': 'signing in to Outlook or Gmail, which only the person can do',
  'meeting_connection.connect': 'signing in to Zoom, which only the person can do',
  'meta_connection.connect': 'signing in to Facebook, which only the person can do',
  'payment_connection.connect': 'signing in to Stripe or Square, which only the person can do',
  'review_connection.connect': 'signing in to Google or Facebook, which only the person can do',
  'migration.connect':
    'signing in at the CRM the business is leaving, which only the person can do',
  'invitation.accept': 'accepting an invitation, which is the person’s own',
  'support.staff.accept': 'accepting a support invitation, which is the person’s own',
  'extension_sign_in.answer': 'letting the browser extension in, which is the person’s own',
  'live_meeting.claim': 'done from HandsFreeOS’s app inside Zoom',
  'user_phone.start_verification': 'confirming a cell by answering a call on it',
  'call.start': 'a call from the browser, on the person’s own microphone',
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
  'knowledge_item.import_faqs': 'a spreadsheet from the person’s own computer',
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
    page: 'A workflow',
    actions: ['workflow.save_draft'],
    why: 'The editor saves a draft as a list of step changes. The Assistant drafts workflows with draft_workflow; changing one step by step needs its own tool.',
  },
  {
    page: 'Agency area',
    actions: ['workflow_template.save_draft', 'workspace.join'],
    why: 'A template’s draft saves as step changes, as a workflow’s does; and joining another of the agency’s businesses acts outside the one the Assistant is in.',
  },
  {
    page: 'Settings → Migrations',
    actions: [
      'migration.create',
      'migration.scan',
      'migration.select',
      'migration.map_scopes',
      'migration.start',
      'migration.pause',
      'migration.resolve_merge',
      'migration.delete',
    ],
    why: 'Moving from another CRM is a wizard whose steps check the agency’s permission themselves, so each needs its own tool and card.',
  },
  {
    page: 'AI quick setup and onboarding setup',
    actions: [
      'ai_setup.save',
      'ai_setup.finish',
      'onboarding_setup.save',
      'onboarding_setup.finish',
    ],
    why: 'They save a whole wizard’s answers at once. The Assistant sets each part up with its own tools; walking the wizard needs one of its own.',
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
    { tool: 'update_my_alerts', field: 'turnOn', value: 'supportTickets' },
  ],
  'notifications.morning_summary': [{ tool: 'update_my_account', field: 'morningEmail' }],
  'notifications.end_of_day': [{ tool: 'update_my_account', field: 'eveningEmail' }],
  'notifications.ai_handoff': [{ tool: 'update_my_account', field: 'emailWhenAiHandsOver' }],
  'notifications.agency_digest': [{ tool: 'update_my_alerts', field: 'agencyDigestEmail' }],
  // ---- My calendar ----
  'my_calendar.weekly_hours': [{ tool: 'update_my_hours', field: 'weekly' }],
  'my_calendar.time_off': [{ tool: 'update_my_hours', field: 'action', value: 'add_time_off' }],
  'my_calendar.connection': [
    { tool: 'do_calendar_connection_disconnect', field: 'connectionId' },
    { tool: 'do_calendar_connection_sync_now', field: 'connectionId' },
  ],
  'my_calendar.video': [{ tool: 'do_meeting_connection_disconnect', field: 'connectionId' }],
};

/** Setting rows the Assistant never changes, and why. */
export const SETTINGS_NEVER: Readonly<Record<string, string>> = {
  'account.password': 'signing in is the person’s own',
  'account.google_sign_in': 'signing in is the person’s own',
  'account.passkeys': 'signing in is the person’s own',
  'account.my_cell': 'confirming a cell by answering a call on it',
  'account.delete_account': 'deleting the person’s own account, which only they do',
  'phone.lock': 'a setting of the phone in their hand, set on it',
  'phone.businesses': 'a setting of the phone in their hand, set on it',
  'phone.documents_mobile_data': 'a setting of the phone in their hand, set on it',
  'phone.changes': 'a setting of the phone in their hand, set on it',
  'phone.my_safety': 'the person’s own safety contacts, which only they choose',
};

/**
 * The Settings pages (and add-ons' settings) whose rows aren't checked yet, in menu order: the daily routine takes
 * the first, says which tool changes each of its rows (adding what's missing), and takes it off.
 */
export const SETTINGS_NOT_YET: readonly string[] = [
  'workspace',
  'permissions',
  'automations',
  'safety',
  'usage',
  'texting',
  'email',
  'website_chat',
  'facebook_instagram',
  'lead_intake',
  'tags',
  'relationships',
  'calendars',
  'payments',
  'partners',
  'realestate',
];
