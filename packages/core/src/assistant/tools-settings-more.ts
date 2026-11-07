/**
 * The last of the settings the Assistant used to hand back (the owner, 2026-10-26: it can do whatever the person
 * can): turning add-ons on and off, adding and uninstalling them; bringing something back from the Deleted bin; how
 * partners are paid and each partner's share; and Settings → Safety's times and safety person. Each is the screen's
 * own command, run as the person, and each waits for their OK.
 *
 * Moving things to the Deleted bin too, for those who may delete (the owner, 2026-10-27): they wait there 30 days.
 *
 * Still left to the person: emptying the bin or deleting anything for good straight away (docs/deleting.md),
 * deleting an add-on's data (typed by hand), and what needs their own sign-in, a file from their computer or a card
 * payment.
 */
import { z } from 'zod';
import { PARTNER_TERMS_MOST } from '../partners/settings';
import { BinKind } from '../schemas/bin';
import { uuid } from '../schemas/common';
import { define, dollars, text, type AssistantTool } from './tool-kit';

const share = z
  .number()
  .min(0.01)
  .max(100)
  .describe('A share of each payment, as a percent: 10 is 10%');

export const moreSettingsTools: readonly AssistantTool[] = [
  define({
    name: 'manage_add_on',
    description:
      'Add an add-on to the business, turn one on or off, or uninstall one (Add-ons). Turning one off keeps its data and settings for when it comes back; uninstalling lets go of what it holds outside HandsFreeOS and keeps its data until an owner deletes it. An add-on another needs moves with it, and the card says so. The add-on’s id is in get_settings (area add_ons). Deleting an add-on’s data is the person’s own, typed on the page.',
    input: z.object({
      action: z.enum(['install', 'turn_on', 'turn_off', 'uninstall']),
      addonId: z.string().trim().min(2).max(16),
    }),
    autonomy: 'confirm',
    permission: 'addons.manage',
  }),
  define({
    name: 'update_addon_settings',
    description:
      'Change an add-on’s own settings for the business, the ones on its settings page, and its switches. Read what is set now with read_addon_settings first (it shows the defaults as set, and each setting’s label), and pass only the settings that change, by the names it shows; everything else stays as it is. A setting that is a list or a set of days is passed whole, as it should end up; in a group of settings (an object, deeper down too), pass only the parts that change: the rest of the group stays as it is, and null takes a part out (a daily limit back to none). Ids are people’s (get_settings, area team) or calendars’ (area calendars); someone picked for a setting that needs a permission they don’t hold is refused, with why. The add-on’s own permission decides who may.',
    input: z.object({
      addonId: z.string().trim().min(2).max(16),
      settings: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Only the settings that change, each as it should end up'),
      flags: z
        .record(z.string(), z.boolean())
        .optional()
        .describe('Its switches that change: true on, false off'),
    }),
    autonomy: 'confirm',
    permission: 'workspace.read',
  }),
  define({
    name: 'move_to_bin',
    description:
      'Delete through the Deleted bin, as Delete for good… does on the screens: customers with everything only about them, conversations, one booking, leads, companies or records of the business’s own kinds. They wait 30 days in Settings → Deleted bin, where restore_from_bin brings them back, and are gone after that. The card says what goes with them and what stays. Up to 100 at once, a booking one at a time. Ids from search_customers, get_customer, list_leads, list_inbox, find_conversations or find_records. Archiving (archive_or_restore) keeps everything instead: use this only when they ask to delete.',
    input: z.object({
      kind: BinKind.describe(
        'person: customers; appointment: a booking; custom_record: a record of the business’s own kinds',
      ),
      ids: z.array(uuid).min(1).max(100),
      tellCustomers: z
        .boolean()
        .default(true)
        .describe('A booking still to come is cancelled first: tell its customers'),
    }),
    autonomy: 'confirm',
    permission: 'records.delete',
  }),
  define({
    name: 'restore_from_bin',
    description:
      'Bring something back from the Deleted bin, as it was: a customer with what was theirs, a conversation, a lead, a booking, a company or a record. Its binItemId is in get_settings (area deleted_bin), which lists the newest 100; one older than those is found by its name (and kind, when two share a name). The bin keeps things 30 days; the AI never empties it or deletes anything in it for good.',
    input: z.object({
      binItemId: uuid.optional(),
      name: text(200)
        .optional()
        .describe('Its name as the bin shows it, when its binItemId isn’t in what you read'),
      kind: BinKind.optional().describe('With name: person is a customer, appointment a booking'),
    }),
    autonomy: 'confirm',
    permission: 'records.delete',
  }),
  define({
    name: 'update_partner_settings',
    description:
      'How partners are paid (Settings → Partners): the share they earn unless they have their own, the terms they accept, the smallest payout, and the calendar their links book. Partners accept changed terms again. Read what is set now with get_settings (area partners) and pass only what changes.',
    input: z.object({
      sharePercent: share.optional(),
      terms: z
        .string()
        .trim()
        .max(PARTNER_TERMS_MOST)
        .optional()
        .describe('The whole terms, as partners read them; empty takes them off'),
      smallestPayout: dollars.min(1).max(25).optional().describe('In dollars, $1 to $25'),
      calendarId: uuid
        .nullable()
        .optional()
        .describe(
          'The calendar their links book, one taking bookings on the booking page (get_settings, area calendars); null for the first one there',
        ),
    }),
    autonomy: 'confirm',
    permission: 'partners.manage',
  }),
  define({
    name: 'manage_partner',
    description:
      'One partner (Settings → Partners): make a customer a partner, give them their own share or put them back on the business’s, pause them, end them or bring them back, or mark which partner sent a customer (or that none did). What a partner earned is always kept.',
    input: z.object({
      action: z.enum(['add', 'set_share', 'pause', 'end', 'bring_back', 'set_referral']),
      personId: uuid
        .optional()
        .describe('add: the customer who becomes a partner. set_referral: the customer they sent'),
      partnerId: uuid
        .nullable()
        .optional()
        .describe('The partner; for set_referral, null when no partner sent them'),
      sharePercent: share
        .nullable()
        .optional()
        .describe('add or set_share: their own share; null for the business’s'),
    }),
    autonomy: 'confirm',
    permission: 'partners.manage',
  }),
  define({
    name: 'update_safety_settings',
    description:
      'Settings → Safety: Ask them after (minutes past a check-in’s planned end before the phone asks “Still there?”), Then tell their contacts after (minutes more with no answer before their contacts are told), and Who’s told when someone has nobody to tell (the safety person; null: the owners and admins). Someone has nobody to tell when none of their teammate contacts is still in the business and nobody outside has replied OK and not STOP. Read what is set now with get_settings (area safety). Never anyone else’s contacts: each person’s own are theirs alone (manage_my_safety_contacts, for the person asking).',
    input: z.object({
      askAfterMinutes: z.int().min(0).max(60).optional(),
      alertAfterMinutes: z.int().min(1).max(60).optional(),
      safetyUserId: uuid.nullable().optional(),
    }),
    autonomy: 'confirm',
    permission: 'workspace.update',
  }),
];
