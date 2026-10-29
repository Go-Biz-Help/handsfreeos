/**
 * Every setting a person can look for, in one list (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web: Settings search",
 * decision 13): each Settings page, each setting row on them, the Account page's sections, each Automations row and a
 * few of its Adjust fields, each notification row, the phone's own settings, and an add-on's switches and settings
 * page. Settings search on the web and the phone, and the main search's Settings group, read it. Browser-safe.
 *
 * The hand-written rows name the setting as its page heads it, where it sits (`section`), and the other words people
 * use for it (`words`, seeded from the Assistant's LOOK_ALIKES). On the web each one is marked where it's drawn:
 * `<SetRow setting="texting.quiet_hours">`, `<SettingAnchor setting>` around a card, or the `id` it already had, which
 * the jump rings. `test/settings-catalog.test.ts` reads the web's source and fails when a row has no entry, an entry
 * marks nothing, or a link names an anchor that isn't there. Each calendar's builder sections and the AI teammate's
 * aren't here this release (decision 13): their open section lives in React state.
 *
 * The ids emails and tools link to keep their names: quiet-hours, rcs, founding, notifications.
 */
import { ADDON_CATALOG } from '../addons/catalog';
import type { CoreFeature } from '../addons/manifest';
import { AUTOMATIONS, AUTOMATION_GROUP_TITLES, type AutomationId } from '../automations/catalog';
import { formatHours } from '../calendar/format';
import { telephonySettingsOf } from '../inbox/rows';
import { formatClock } from '../messaging/quiet-hours';
import type { WorkspacePermission } from '../permissions';
import { openHoursOf } from '../schemas/workspace';
import {
  EMAIL_ONLY_ROWS,
  NOTIFICATION_ROWS,
  type NotificationSettingKey,
} from '../account/notification-rows';
import { SETTINGS_PAGES, type SettingsPageKey } from './pages';

/** What a setting is set to now, from the business's settings: "9:00 PM to 8:00 AM", or null when it can't say. */
export type SettingValue = (
  settings: Readonly<Record<string, unknown>> | null,
  timeZone: string,
) => string | null;

export interface SettingEntry {
  /** `texting.quiet_hours`; a page is `page.texting`. */
  readonly key: string;
  /**
   * `page`: a Settings page itself. `setting`: one on a page. `phone`: one only the phone has (Face ID). `addon`: an
   * add-on's, shown under the add-on's own name and never as a Settings page.
   */
  readonly kind: 'page' | 'setting' | 'phone' | 'addon';
  /** The Settings page it's on; null for an add-on's and the phone's own. */
  readonly page: SettingsPageKey | null;
  /** The add-on it belongs to. */
  readonly addon: string | null;
  /** The card or group it sits in, as the page heads it: "Texting rules". */
  readonly section: string | null;
  readonly label: string;
  /** Other words people use for it. */
  readonly words: readonly string[];
  /** Its id on the web page, rung by the jump; null when the whole page is the setting. */
  readonly anchor: string | null;
  /** What opens the thing that holds it, as a query: `adjust=stale_opportunities` opens that Adjust sheet. */
  readonly open: string | null;
  /** Where it is under /app/w/<business>/: `settings/texting`, `add-ons`, `a/realestate/settings`. */
  readonly path: string;
  /** What someone needs, beside its page's own: one of core's permissions, or an add-on's. */
  readonly needs: string | null;
  readonly feature: CoreFeature | null;
  /**
   * A row only some people have, as their own screens show it: `staff` for those who answer HandsFreeOS support (New
   * support tickets), `agency` for an owner or admin of an organization with more than one business (Daily agency
   * digest).
   */
  readonly only: 'staff' | 'agency' | null;
  /**
   * Where the phone opens it: a screen under /app/w/<business>/ (`settings/notifications?setting=…`), or 'web' for one
   * only the web changes, which the phone lists marked "Opens on the web".
   */
  readonly phone: string;
  readonly value: SettingValue | null;
}

/** A hand-written row. */
interface RowDef {
  readonly page: SettingsPageKey;
  readonly section: string | null;
  readonly label: string;
  readonly words?: readonly string[];
  /** Kept when the page already had an id that something links to; else the key, its dots and underscores hyphens. */
  readonly anchor?: string;
  /** A page under the menu's own (`/calendars/services`): the whole page is the setting, with no anchor. */
  readonly path?: string;
  readonly needs?: WorkspacePermission;
  readonly phone?: string;
  readonly value?: SettingValue;
}

/** "9:00 PM to 8:00 AM", or "Off". */
const quietHoursValue: SettingValue = (settings) => {
  const quiet = telephonySettingsOf(settings).quietHours;
  return quiet.enabled ? `${formatClock(quiet.start)} to ${formatClock(quiet.end)}` : 'Off';
};

/** "After 10 minutes", or "Never". */
const reminderValue: SettingValue = (settings) => {
  const minutes = telephonySettingsOf(settings).unansweredReminderMinutes;
  if (minutes === 0) return 'Never';
  return minutes % 60 === 0
    ? `After ${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
    : `After ${minutes} minutes`;
};

/** "Chicago time", from the business's time zone. */
const timeZoneValue: SettingValue = (_settings, timeZone) => {
  const city = timeZone.split('/').pop()?.replace(/_/g, ' ');
  return city ? `${city} time` : null;
};

/** The phone's Settings screen, with the row to flash. */
const phoneRow = (key: string) => `settings?setting=${key}`;

/**
 * Each setting row on the Settings pages and each Account section, in page order. The labels are the page's own
 * words, so a person finds what they see.
 */
const ROWS = {
  // ---- Account ----
  'account.profile': {
    page: 'account',
    section: null,
    label: 'Profile',
    words: ['name', 'full name', 'email address'],
  },
  'account.appearance': {
    page: 'account',
    section: null,
    label: 'Appearance',
    words: ['dark mode', 'light mode', 'theme', 'colours', 'colors'],
    anchor: 'appearance',
    phone: phoneRow('account.appearance'),
  },
  'account.menu': {
    page: 'account',
    section: null,
    label: 'Side menu',
    words: ['edit menu', 'reorder', 'hide', 'groups', 'navigation'],
    anchor: 'menu',
  },
  'account.password': {
    page: 'account',
    section: 'Sign-in methods',
    label: 'Password',
    words: ['change password', 'sign in', 'log in'],
  },
  'account.google_sign_in': {
    page: 'account',
    section: 'Sign-in methods',
    label: 'Sign in with Google',
    words: ['google', 'sign in', 'log in'],
    anchor: 'google',
  },
  'account.passkeys': {
    page: 'account',
    section: 'Sign-in methods',
    label: 'Passkeys',
    words: ['face id', 'touch id', 'sign in', 'security key'],
    anchor: 'passkeys',
  },
  'account.notifications': {
    page: 'account',
    section: null,
    label: 'Notifications',
    words: ['push', 'alerts', 'emails', 'what i’m told about'],
    anchor: 'notifications',
    phone: 'settings/notifications',
  },
  'account.my_cell': {
    page: 'account',
    section: null,
    label: 'My cell phone',
    words: ['my cell', 'mobile', 'call rings', 'my number'],
    anchor: 'my-cell',
    phone: phoneRow('account.my_cell'),
  },
  'account.delete_account': {
    page: 'account',
    section: null,
    label: 'Delete my account',
    words: ['close account', 'remove me', 'leave'],
    anchor: 'delete-account',
    phone: phoneRow('account.delete_account'),
  },

  // ---- My calendar ----
  'my_calendar.weekly_hours': {
    page: 'my_calendar',
    section: null,
    label: 'Weekly hours',
    words: ['my hours', 'working hours', 'availability', 'lunch break'],
  },
  'my_calendar.time_off': {
    page: 'my_calendar',
    section: null,
    label: 'Time off',
    words: ['vacation', 'holiday', 'day off', 'away'],
  },
  'my_calendar.connection': {
    page: 'my_calendar',
    section: null,
    label: 'Calendar connection',
    words: ['google calendar', 'outlook', 'connect a calendar', 'busy times'],
  },
  'my_calendar.video': {
    page: 'my_calendar',
    section: null,
    label: 'Video meetings',
    words: ['zoom', 'google meet', 'teams', 'video link'],
  },

  // ---- Workspace ----
  'workspace.name': {
    page: 'workspace',
    section: 'Workspace',
    label: 'Business name',
    words: ['company name', 'rename'],
  },
  'workspace.time_zone': {
    page: 'workspace',
    section: 'Workspace',
    label: 'Time zone',
    words: ['timezone', 'clock'],
    value: timeZoneValue,
  },
  'workspace.industry': {
    page: 'workspace',
    section: 'Workspace',
    label: 'Industry',
    words: ['trade', 'kind of business', 'line of work'],
  },
  'workspace.website': {
    page: 'workspace',
    section: 'Workspace',
    label: 'Website',
    words: ['web site', 'url'],
  },
  'workspace.review_link': {
    page: 'workspace',
    section: 'Workspace',
    label: 'Review link',
    words: ['google business profile', 'reviews', 'google reviews'],
  },
  'workspace.hours': {
    page: 'workspace',
    section: 'Workspace',
    label: 'Business hours',
    words: ['opening hours', 'open hours', 'when we’re open', 'after hours'],
    value: (settings) => formatHours(openHoursOf(settings)),
  },
  'workspace.look': {
    page: 'workspace',
    section: null,
    label: 'Logo and colour',
    words: ['logo', 'brand', 'color', 'branding'],
    anchor: 'logo-and-colour',
  },
  'workspace.your_page': {
    page: 'workspace',
    section: null,
    label: 'Your page',
    words: ['one-page site', 'website', 'landing page', 'booking page'],
    anchor: 'your-page',
  },
  'workspace.getting_started': {
    page: 'workspace',
    section: null,
    label: 'Getting started guide',
    words: ['setup guide', 'checklist', 'onboarding'],
  },
  'workspace.branded_domain': {
    page: 'workspace',
    section: null,
    label: 'Your own web address',
    words: ['domain', 'custom domain', 'dns', 'branded links'],
  },
  'workspace.delete': {
    page: 'workspace',
    section: null,
    label: 'Delete this business',
    words: ['delete workspace', 'close the business', 'remove business'],
    anchor: 'delete-workspace',
    needs: 'workspace.delete',
  },

  // ---- Permissions ----
  'permissions.who_can': {
    page: 'permissions',
    section: null,
    label: 'Who can do what',
    words: ['roles', 'admins', 'members', 'access'],
  },
  'permissions.defaults': {
    page: 'permissions',
    section: null,
    label: 'Back to the defaults',
    words: ['reset admins', 'reset members', 'reset permissions'],
  },
  'permissions.people': {
    page: 'permissions',
    section: null,
    label: 'People with their own settings',
    words: ['one person', 'their own permissions'],
  },

  // ---- Safety ----
  'safety.check_ins': {
    page: 'safety',
    section: null,
    label: 'Check-ins',
    words: ['check in', 'check out', 'alone at a job', 'lone worker', 'safety person'],
  },
  'safety.preview': {
    page: 'safety',
    section: null,
    label: 'What each person sees',
    words: ['safety preview'],
  },

  // ---- Usage & balance ----
  'usage.balance': {
    page: 'usage',
    section: null,
    label: 'Your balance',
    words: ['wallet', 'credit', 'top up', 'funds'],
    phone: 'settings/usage',
  },
  'usage.auto_top_up': {
    page: 'usage',
    section: null,
    label: 'Automatic top-up',
    words: ['auto top up', 'recharge', 'reload'],
    phone: 'settings/usage',
  },
  'usage.ai_limit': {
    page: 'usage',
    section: null,
    label: 'Daily AI limit',
    words: ['ai limit', 'ai spending', 'assistant limit', 'ai budget', 'pause the ai', 'ai cap'],
    phone: 'settings/usage',
  },
  'usage.card': {
    page: 'usage',
    section: null,
    label: 'Card on file',
    words: ['credit card', 'payment method', 'billing card'],
    phone: 'settings/usage',
  },
  'usage.prices': {
    page: 'usage',
    section: null,
    label: 'What things cost',
    words: ['prices', 'rates', 'cost of a text', 'cost of a call'],
  },
  'usage.statement': {
    page: 'usage',
    section: null,
    label: 'Statement',
    words: ['history', 'charges', 'receipts', 'usage'],
  },
  'usage.founding': {
    page: 'usage',
    section: null,
    label: 'Founding plan',
    words: ['founding member', 'plan', 'subscription'],
    anchor: 'founding',
  },

  // ---- Texting & calls ----
  'texting.inbox_visibility': {
    page: 'texting',
    section: null,
    label: 'Who sees which conversations',
    words: [
      'inbox access',
      'each person sees their own',
      'conversation visibility',
      'private inbox',
    ],
  },
  'texting.number': {
    page: 'texting',
    section: null,
    label: 'Business number',
    words: ['phone number', 'text me a test', 'release number', 'port a number', 'toll-free'],
  },
  'texting.registration': {
    page: 'texting',
    section: null,
    label: 'Carrier registration',
    words: ['a2p', '10dlc', 'brand', 'texting campaign', 'toll-free verification'],
  },
  'texting.rcs': {
    page: 'texting',
    section: null,
    label: 'RCS messaging',
    words: ['rcs', 'branded texts', 'logo in texts', 'buttons'],
    anchor: 'rcs',
  },
  'texting.rcs_send': {
    page: 'texting',
    section: 'RCS messaging',
    label: 'Send as RCS when the phone supports it',
    words: ['rcs on', 'pause rcs'],
  },
  'texting.rcs_line': {
    page: 'texting',
    section: 'RCS messaging',
    label: 'New RCS conversations start on',
    words: ['rcs number'],
  },
  'texting.quiet_hours': {
    page: 'texting',
    section: 'Texting rules',
    label: 'Quiet hours',
    words: ['do not disturb', 'night', 'no texts at night', 'send times'],
    anchor: 'quiet-hours',
    value: quietHoursValue,
  },
  'texting.remind_waiting': {
    page: 'texting',
    section: 'Texting rules',
    label: 'Remind the team when a customer waits',
    words: ['unanswered reminder', 'reply reminder', 'waiting customer email'],
    value: reminderValue,
  },
  'texting.stop_help': {
    page: 'texting',
    section: 'Texting rules',
    label: 'STOP, START and HELP',
    words: ['opt out', 'unsubscribe', 'opted out'],
  },
  'texting.calls': {
    page: 'texting',
    section: null,
    label: 'When a customer calls',
    words: ['call forwarding', 'forward calls', 'ring my phone', 'team browsers'],
  },
  'texting.ring_for': {
    page: 'texting',
    section: 'When a customer calls',
    label: 'Ring for',
    words: ['ring time', 'how long it rings', 'seconds'],
  },
  'texting.caller_id': {
    page: 'texting',
    section: null,
    label: 'What forwarded phones show',
    words: ['caller id', 'business number on my phone'],
  },
  'texting.recording': {
    page: 'texting',
    section: null,
    label: 'Call recording',
    words: ['record calls', 'this call may be recorded', 'transcripts'],
  },
  'texting.voicemail': {
    page: 'texting',
    section: null,
    label: 'Voicemail',
    words: ['voicemail greeting', 'leave a message', 'missed calls'],
  },

  // ---- Email ----
  'email.sending_address': {
    page: 'email',
    section: null,
    label: 'Sending address',
    words: ['from address', 'display name', 'email address', 'reply-to'],
  },
  'email.own_domain': {
    page: 'email',
    section: null,
    label: 'Your own domain',
    words: [
      'use your own domain',
      'send from my domain',
      'another domain',
      'dns',
      'dkim',
      'receive mail here too',
      'mx record',
    ],
  },
  'email.mailboxes': {
    page: 'email',
    section: null,
    label: 'Connected mailboxes',
    words: ['gmail', 'outlook', 'google workspace', 'connect a mailbox', 'my mail'],
  },
  'email.blocked': {
    page: 'email',
    section: null,
    label: 'Blocked addresses',
    words: ['block', 'spam', 'blocked senders'],
  },
  'email.unknown_senders': {
    page: 'email',
    section: null,
    label: 'Mail from people not in Contacts',
    words: ['other mail', 'strangers', 'new senders'],
  },
  'email.sender_rules': {
    page: 'email',
    section: null,
    label: 'Where senders’ mail goes',
    words: ['sender rules', 'filters', 'folders'],
  },

  // ---- Website chat ----
  'website_chat.who_answers': {
    page: 'website_chat',
    section: null,
    label: 'Who answers',
    words: ['ai teammate answers', 'chat replies'],
  },
  'website_chat.daily_limit': {
    page: 'website_chat',
    section: null,
    label: 'Daily limit',
    words: ['chats a day', 'limit'],
  },
  'website_chat.sites': {
    page: 'website_chat',
    section: null,
    label: 'Your sites',
    words: ['allowed sites', 'domains', 'where the chat shows'],
  },
  'website_chat.install': {
    page: 'website_chat',
    section: null,
    label: 'Add it to your site',
    words: ['install', 'snippet', 'embed code', 'wordpress', 'squarespace', 'wix'],
  },
  'website_chat.try': {
    page: 'website_chat',
    section: null,
    label: 'Try it',
    words: ['preview', 'test the chat'],
  },
  'website_chat.look': {
    page: 'website_chat',
    section: null,
    label: 'Look',
    words: ['chat colour', 'chat color', 'greeting', 'chat button'],
  },
  'website_chat.away': {
    page: 'website_chat',
    section: null,
    label: 'When nobody is answering',
    words: ['away message', 'offline', 'contact details', 'ask for their number'],
  },
  'website_chat.text_box': {
    page: 'website_chat',
    section: 'When nobody is answering',
    label: 'Offer a box to get texts',
    words: ['text me', 'sms opt in'],
  },

  // ---- Facebook & Instagram ----
  'facebook_instagram.accounts': {
    page: 'facebook_instagram',
    section: null,
    label: 'Pages and accounts',
    words: ['facebook page', 'instagram account', 'messenger', 'connect facebook'],
  },
  'facebook_instagram.sign_in': {
    page: 'facebook_instagram',
    section: null,
    label: 'Facebook sign-in',
    words: ['reconnect facebook', 'meta login'],
  },
  'facebook_instagram.lead_ads': {
    page: 'facebook_instagram',
    section: null,
    label: 'Lead ads',
    words: ['lead ad', 'lead form', 'instant form', 'leads access', 'facebook leads'],
  },

  // ---- Lead intake ----
  'lead_intake.channels': {
    page: 'lead_intake',
    section: null,
    label: 'Where new leads come from',
    words: [
      'someone texts your number',
      'missed call',
      'emails your business',
      'facebook page',
      'instagram',
      'lead ad form',
      'new lead pipeline',
    ],
  },
  'lead_intake.sources': {
    page: 'lead_intake',
    section: null,
    label: 'Forms and connected apps',
    words: ['website form', 'zapier', 'connect an app', 'api key', 'webhook'],
  },

  // ---- Tags ----
  'tags.list': {
    page: 'tags',
    section: null,
    label: 'Tags',
    words: ['labels', 'tag colours'],
  },
  'tags.ai_tagging': {
    page: 'tags',
    section: null,
    label: 'Let the AI tag your customers',
    words: ['auto tag', 'tag everyone', 'ai tags'],
  },
  'tags.ai_changes': {
    page: 'tags',
    section: null,
    label: 'What the AI changed lately',
    words: ['ai changes', 'undo a tag'],
  },

  // ---- Relationships ----
  'relationships.record_kinds': {
    page: 'relationships',
    section: null,
    label: 'Kinds of records',
    words: ['pets', 'vehicles', 'properties', 'equipment', 'custom records'],
  },
  'relationships.types': {
    page: 'relationships',
    section: null,
    label: 'Relationship types',
    words: ['links', 'connect records', 'owner of', 'works at'],
  },

  // ---- Calendars ----
  'calendars.services': {
    page: 'calendars',
    section: null,
    label: 'Services',
    words: ['service list', 'job types', 'lengths', 'what customers book'],
    path: '/calendars/services',
  },
  'calendars.resources': {
    page: 'calendars',
    section: null,
    label: 'Resources',
    words: ['rooms', 'equipment', 'vans', 'trucks'],
    path: '/calendars/resources',
  },
  'calendars.territories': {
    page: 'calendars',
    section: null,
    label: 'Territories',
    words: ['service area', 'zip codes', 'where you work', 'route by zip'],
    path: '/calendars/territories',
  },
  'calendars.booking_site': {
    page: 'calendars',
    section: null,
    label: 'Booking site',
    words: ['booking page', 'online booking', 'book online', 'scheduling link'],
    path: '/calendars/booking-site',
  },

  // ---- Payments ----
  'payments.accounts': {
    page: 'payments',
    section: null,
    label: 'Accounts you get paid into',
    words: ['stripe', 'square', 'connect stripe', 'payouts', 'who can use it'],
  },
  'payments.ways_to_pay': {
    page: 'payments',
    section: null,
    label: 'Ways to pay',
    words: ['payment methods', 'how customers pay'],
  },
  'payments.bank_transfer': {
    page: 'payments',
    section: 'Ways to pay',
    label: 'Bank transfer',
    words: ['ach', 'bank payment'],
  },
  'payments.card': {
    page: 'payments',
    section: 'Ways to pay',
    label: 'Card',
    words: ['credit card', 'apple pay', 'google pay'],
  },
  'payments.cash': {
    page: 'payments',
    section: 'Ways to pay',
    label: 'Cash and cheque',
    words: ['check', 'cash payment', 'record a payment'],
  },
  'payments.tax': {
    page: 'payments',
    section: null,
    label: 'Sales tax',
    words: ['tax', 'vat', 'gst'],
  },
  'payments.tax_rate': {
    page: 'payments',
    section: 'Sales tax',
    label: 'Rate',
    words: ['sales tax', 'tax rate', 'vat'],
  },
  'payments.tax_name': {
    page: 'payments',
    section: 'Sales tax',
    label: 'What to call it on a document',
    words: ['tax name', 'tax label'],
  },
  'payments.taxable': {
    page: 'payments',
    section: 'Sales tax',
    label: 'New items start taxable',
    words: ['taxable', 'tax by default'],
  },
  'payments.numbering': {
    page: 'payments',
    section: null,
    label: 'Numbering',
    words: ['invoice number', 'estimate number', 'prefix', 'next number'],
  },
  'payments.address': {
    page: 'payments',
    section: null,
    label: 'Your address',
    words: ['business address', 'address on invoices'],
  },
  'payments.terms': {
    page: 'payments',
    section: null,
    label: 'Terms and notes',
    words: ['payment terms', 'footer', 'notes on invoices'],
  },
  'payments.due': {
    page: 'payments',
    section: 'Terms and notes',
    label: 'Invoices are due',
    words: ['due date', 'net 30', 'payment terms'],
  },
  'payments.estimate_valid': {
    page: 'payments',
    section: 'Terms and notes',
    label: 'Estimates stay good for',
    words: ['estimate expiry', 'quote expiry', 'valid for'],
  },
  'payments.deposits': {
    page: 'payments',
    section: null,
    label: 'Deposits',
    words: ['deposit', 'down payment', 'upfront'],
  },
  'payments.reminders': {
    page: 'payments',
    section: null,
    label: 'Invoice reminders',
    words: ['payment reminders', 'overdue reminders', 'nudge an estimate'],
  },

  // ---- Partners ----
  'partners.pay': {
    page: 'partners',
    section: null,
    label: 'How partners are paid',
    words: ['their share', 'commission', 'smallest payout', 'partner link calendar'],
    phone: 'settings/partners',
  },
  'partners.terms': {
    page: 'partners',
    section: null,
    label: 'Partner terms',
    words: ['terms partners accept', 'agreement'],
  },
  'partners.payouts': {
    page: 'partners',
    section: null,
    label: 'Paying your partners',
    words: ['partner payouts', 'card for partner payouts', 'statement'],
  },
} as const satisfies Readonly<Record<string, RowDef>>;

/** The Automations' Adjust fields that are settings of their own, each opening its automation's sheet. */
const ADJUST_FIELDS = {
  'adjust.urgent_after': {
    automation: 'hot_lead_alert',
    label: 'Urgent after',
    words: ['hot lead wait'],
  },
  'adjust.big_job': {
    automation: 'hot_lead_alert',
    label: 'A big job starts at',
    words: ['big job', 'job value'],
  },
  'adjust.typical_value': {
    automation: 'hot_lead_alert',
    label: 'When a lead has no value, use',
    words: ['typical value', 'lead value'],
  },
  'adjust.reply_c': {
    automation: 'day_before_confirmation',
    label: 'Reply C to confirm',
    words: ['confirm by text', 'confirmation reply'],
  },
  'adjust.maintenance_plan': {
    automation: 'maintenance_due',
    label: 'For customers on a maintenance plan',
    words: ['maintenance plan wording'],
  },
  'adjust.ignore_balances': {
    automation: 'overdue_invoices',
    label: 'Ignore balances under',
    words: ['small balances', 'minimum balance'],
  },
  'adjust.stage_meanings': {
    automation: 'pipeline_moves',
    label: 'What each stage means',
    words: ['stage roles', 'stage meanings'],
  },
  'adjust.gone_quiet': {
    automation: 'stale_opportunities',
    label: 'Gone quiet after',
    words: ['stale after', 'no contact for'],
  },
  'adjust.gone_cold': {
    automation: 'reengage_dead_leads',
    label: 'Gone cold after',
    words: ['dead leads', 'months without contact'],
  },
  'adjust.voicemail_box': {
    automation: 'call_back_missed',
    label: 'When a voicemail box answers',
    words: ['leave a voicemail', 'ai calls voicemail'],
  },
  'adjust.calling_hours': {
    automation: 'call_back_missed',
    label: 'Calling hours for leads',
    words: ['legal calling hours', 'call hours', 'when calls go', 'calls at weekends'],
  },
  'adjust.call_tries': {
    automation: 'call_back_missed',
    label: 'When a lead doesn’t answer',
    words: ['call again', 'retry calls', 'call attempts', 'no answer'],
  },
  'adjust.ok_to_call': {
    automation: 'call_back_missed',
    label: 'Ask for an OK to call',
    words: ['call consent', 'consent to calls', 'permission to call', 'ok to call box'],
  },
  'adjust.how_you_tag': {
    automation: 'ai_tags',
    label: 'How you tag customers',
    words: ['tagging guide', 'tag rules'],
  },
} as const satisfies Readonly<
  Record<
    string,
    { readonly automation: AutomationId; readonly label: string; readonly words: readonly string[] }
  >
>;

/** A key the web may mark on its pages; TypeScript refuses one the catalogue doesn't have. */
export type SettingKey = keyof typeof ROWS | keyof typeof ADJUST_FIELDS | NotificationSettingKey;

/** A key's id on the page: hyphens for its dots and underscores (`texting.ring_for` is `texting-ring-for`). */
const anchorOf = (key: string) => key.replace(/[._]/g, '-');

/**
 * The other words people use for each page, seeded from the Assistant's LOOK_ALIKES: the words that got people sent
 * to the wrong screen.
 */
const PAGE_WORDS: Readonly<Record<SettingsPageKey, readonly string[]>> = {
  account: ['my account', 'profile', 'sign in', 'password', 'signing in with google'],
  my_calendar: ['my hours', 'time off', 'availability', 'google calendar', 'outlook calendar'],
  workspace: ['business details', 'business profile', 'company', 'web address'],
  main_offer: ['offer', 'guarantee', 'pricing'],
  permissions: ['roles', 'access', 'who can do what', 'admins'],
  automations: ['action center', 'reminders', 'follow-ups', 'alerts', 'notifications'],
  safety: ['check-ins', 'lone worker', 'safety person'],
  usage: ['balance', 'wallet', 'top up', 'billing', 'paying handsfreeos'],
  texting: ['sms', 'texts', 'phone number', 'calls', 'voicemail', 'a2p', '10dlc'],
  email: ['mailbox', 'gmail', 'outlook mail', 'email address'],
  website_chat: ['chat widget', 'live chat', 'chat button'],
  facebook_instagram: ['messenger', 'instagram', 'facebook page', 'meta'],
  templates: ['saved replies', 'canned responses', 'snippets'],
  lead_intake: ['new leads', 'web forms', 'zapier'],
  pipelines: ['stages', 'deals', 'sales pipeline'],
  tags: ['labels'],
  fields: ['custom fields'],
  relationships: ['kinds of records', 'pets', 'vehicles', 'properties'],
  deleted_bin: ['trash', 'recycle bin', 'restore', 'bring back', 'deleted'],
  calendars: ['booking', 'appointments', 'scheduling'],
  payments: ['stripe', 'square', 'get paid', 'deposits'],
  products: ['price list', 'catalogue', 'catalog', 'items'],
  partners: ['referrals', 'affiliates', 'commission'],
  imports: ['csv', 'spreadsheet', 'upload', 'excel'],
  migrations: [
    'connect a crm',
    'gohighlevel',
    'hubspot',
    'switch from another crm',
    'move my data',
  ],
};

/** Where a page's settings are, under /app/w/<business>/. */
const pagePath = (page: SettingsPageKey) =>
  `settings${SETTINGS_PAGES.find((p) => p.key === page)!.path}`;

/** The phone opens these pages itself; everything else of the business's opens the web. */
const PAGE_ON_PHONE: Partial<Record<SettingsPageKey, string>> = {
  usage: 'settings/usage',
  main_offer: 'settings/main-offer',
  partners: 'settings/partners',
};

const pages = (): SettingEntry[] =>
  SETTINGS_PAGES.map((p) => ({
    key: `page.${p.key}`,
    kind: 'page',
    page: p.key,
    addon: null,
    section: null,
    label: p.label,
    words: PAGE_WORDS[p.key],
    anchor: null,
    open: null,
    path: pagePath(p.key),
    needs: null,
    feature: null,
    only: null,
    phone: PAGE_ON_PHONE[p.key] ?? 'web',
    value: null,
  }));

const rows = (): SettingEntry[] =>
  Object.entries(ROWS).map(([key, raw]) => {
    const r: RowDef = raw;
    return {
      key,
      kind: 'setting',
      page: r.page,
      addon: null,
      section: r.section,
      label: r.label,
      words: r.words ?? [],
      anchor: r.path ? null : (r.anchor ?? anchorOf(key)),
      open: null,
      path: r.path ? `settings${r.path}` : pagePath(r.page),
      needs: r.needs ?? null,
      feature: null,
      only: null,
      phone: r.phone ?? 'web',
      value: r.value ?? null,
    };
  });

/** Each Automations row, its group as the section, rung on the page where its switch is. */
const automations = (): SettingEntry[] =>
  AUTOMATIONS.map((a) => ({
    key: `automation.${a.id}`,
    kind: 'setting',
    page: 'automations',
    addon: null,
    section: AUTOMATION_GROUP_TITLES[a.group],
    label: a.label,
    words: [a.oneLiner],
    anchor: `automation-${a.id}`,
    open: null,
    path: pagePath('automations'),
    needs: null,
    feature: null,
    only: null,
    phone: 'web',
    value: null,
  }));

/** The Adjust fields, each opening its automation's sheet, its label as the section. */
const adjustFields = (): SettingEntry[] =>
  Object.entries(ADJUST_FIELDS).map(([key, f]) => ({
    key,
    kind: 'setting',
    page: 'automations',
    addon: null,
    section: AUTOMATIONS.find((a) => a.id === f.automation)!.label,
    label: f.label,
    words: f.words,
    anchor: anchorOf(key),
    open: `adjust=${f.automation}`,
    path: pagePath('automations'),
    needs: null,
    feature: null,
    only: null,
    phone: 'web',
    value: null,
  }));

/**
 * Each notification row, under Notifications on the Account page, flashed in place on the phone. New support tickets
 * and Daily agency digest carry who has them, as both apps' Notifications show them.
 */
const notifications = (): SettingEntry[] =>
  [...NOTIFICATION_ROWS, ...EMAIL_ONLY_ROWS].map((row) => ({
    key: row.key,
    kind: 'setting',
    page: 'account',
    addon: null,
    section: 'Notifications',
    label: row.title,
    words: [row.detail],
    anchor: anchorOf(row.key),
    open: null,
    path: pagePath('account'),
    needs: null,
    feature: null,
    only: row.staffOnly ? 'staff' : row.agencyOnly ? 'agency' : null,
    phone: `settings/notifications?setting=${row.key}`,
    value: null,
  }));

/**
 * What only the phone has (its own Settings screen, `(more)/settings/index.tsx`): the lock, the businesses and
 * documents kept on it, its changes, and the person's own safety contacts. The web never lists them.
 */
const PHONE_ROWS: readonly Pick<SettingEntry, 'key' | 'section' | 'label' | 'words'>[] = [
  {
    key: 'phone.lock',
    section: 'This phone',
    label: 'Unlock with Face ID',
    words: ['face id lock', 'touch id', 'fingerprint', 'passcode', 'lock the app'],
  },
  {
    key: 'phone.businesses',
    section: 'This phone',
    label: 'Businesses on this phone',
    words: ['offline businesses', 'kept on this phone', 'switch business'],
  },
  {
    key: 'phone.documents_mobile_data',
    section: 'This phone',
    label: 'Documents on mobile data',
    words: ['wi-fi only', 'download documents', 'cellular data'],
  },
  {
    key: 'phone.changes',
    section: 'This phone',
    label: 'Changes on this phone',
    words: ['waiting to send', 'offline changes', 'sync'],
  },
  {
    key: 'phone.my_safety',
    section: 'You',
    label: 'My safety',
    words: ['who’s told if i don’t check out', 'safety contacts', 'check-ins'],
  },
];

const phoneOnly = (): SettingEntry[] =>
  PHONE_ROWS.map((r) => ({
    ...r,
    kind: 'phone',
    page: null,
    addon: null,
    anchor: null,
    open: null,
    path: 'settings',
    needs: null,
    feature: null,
    only: null,
    phone: phoneRow(r.key),
    value: null,
  }));

/**
 * An add-on's own: each labelled switch it declares (`settings.flags`), on the Add-ons page for whoever manages
 * add-ons, and its settings page in the side menu (`ui.nav`'s `settings`, Real Estate's Deal settings). Shown under
 * the add-on's name, never as a Settings page.
 */
const addons = (): SettingEntry[] =>
  ADDON_CATALOG.filter((m) => m.catalog.status !== 'planned').flatMap((m) => [
    ...Object.entries(m.settings?.flags ?? {}).map(([flag, f]): SettingEntry => ({
      key: `addon.${m.id}.${flag}`,
      kind: 'addon',
      page: null,
      addon: m.id,
      section: null,
      label: f.label,
      words: [],
      anchor: null,
      open: `addon=${m.id}`,
      path: 'add-ons',
      needs: 'addons.manage',
      feature: null,
      only: null,
      phone: `add-ons?addon=${m.id}`,
      value: null,
    })),
    ...(m.ui?.nav ?? [])
      .filter((n) => n.key === 'settings')
      .map((n): SettingEntry => ({
        key: `addon.${m.id}.page.${n.key}`,
        kind: 'addon',
        page: null,
        addon: m.id,
        section: null,
        label: n.label,
        words: ['settings'],
        anchor: null,
        open: null,
        path: `a/${m.id}${n.path ? `/${n.path}` : ''}`,
        needs: n.permission ?? null,
        feature: null,
        only: null,
        phone: 'web',
        value: null,
      })),
  ]);

/** Every entry: the pages, then their settings in page order, the phone's own, and the add-ons'. */
export const SETTINGS: readonly SettingEntry[] = [
  ...pages(),
  ...rows(),
  ...notifications(),
  ...automations(),
  ...adjustFields(),
  ...phoneOnly(),
  ...addons(),
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** One entry by its key. */
export function settingEntry(key: string): SettingEntry | undefined {
  return BY_KEY.get(key);
}

/** The id a key marks on the web page, and its key, for `id` and `data-setting`. */
export function settingAnchor(key: SettingKey): string {
  return BY_KEY.get(key)?.anchor ?? anchorOf(key);
}

/** What a setting is set to now ("9:00 PM to 8:00 AM"), or null for one with nothing to say. */
export function settingValueText(
  key: string,
  settings: Readonly<Record<string, unknown>> | null,
  timeZone: string,
): string | null {
  return BY_KEY.get(key)?.value?.(settings, timeZone) ?? null;
}
