/**
 * How the business is set up: permissions, fields, kinds of records, templates, numbers, who sees which
 * conversations, its own web address, mail from strangers and blocked addresses, and the RCS sender and lead forms
 * once they are connected.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 *
 * Left out on purpose: connecting an RCS sender (it is made in the business's own Twilio account, which only they
 * sign in to), and adding a website form or a connected app or replacing its key (each hands back a key, and a
 * key never goes in a chat).
 */
import { z } from 'zod';
import { CUSTOM_FIELD_TYPES } from '../crm/custom-fields';
import { CUSTOMIZABLE_PERMISSIONS, CUSTOMIZABLE_ROLES } from '../permissions';
import {
  RECORD_ICONS,
  RELATIONSHIP_CARDINALITIES,
  RELATIONSHIP_ENDS,
} from '../relationships/words';
import { hostname } from '../schemas/branded-domain';
import { uuid } from '../schemas/common';
import { define, text, type AssistantTool } from './tool-kit';

/** The keys the command takes, each with the words the Permissions screen shows it with. */
const PERMISSION_KEYS = CUSTOMIZABLE_PERMISSIONS.map((p) => p.permission) as [string, ...string[]];
const PERMISSION_WORDS = CUSTOMIZABLE_PERMISSIONS.map((p) => `${p.permission} = ${p.label}`).join(
  '; ',
);

const choices = z
  .array(z.string().trim().min(1).max(80))
  .max(100)
  .describe('The whole list of choices, in order, for a choice or multi_choice field');

const cardinality = z
  .enum(RELATIONSHIP_CARDINALITIES)
  .describe(
    'How many each end may have, A first: one_to_many is one A with many Bs. many_to_many unless one end can only ever have one',
  );

const relationshipEnd = z.object({
  end: z.enum(RELATIONSHIP_ENDS).describe('person is a customer; custom_record a kind of record'),
  recordTypeId: uuid.optional().describe('Which kind of record, when end is custom_record'),
  label: text(40).describe('What this end is called to the other: Owner, Pet, Parent, Spouse'),
});

export const setupTools: readonly AssistantTool[] = [
  // ---------- who may do what (owners only) ----------
  define({
    name: 'manage_permissions',
    description:
      'Change what admins or members may do, or what one person may do whatever their role says, or put a role or a person back to the defaults. Owners only; owners always keep everything, so there is nothing to set for them. One permission a call. Read what is set now with get_settings (area permissions), which also has each person’s userId (or list_team).',
    input: z.object({
      action: z
        .enum(['set_role', 'set_person', 'reset_role', 'reset_person'])
        .describe(
          'set_role: one permission for every admin or member. set_person: one permission for one person. reset_role / reset_person: every setting back to the default / to what their role says',
        ),
      role: z.enum(CUSTOMIZABLE_ROLES).optional().describe('For set_role and reset_role'),
      userId: uuid.optional().describe('For set_person and reset_person'),
      permission: z
        .enum(PERMISSION_KEYS)
        .optional()
        .describe(`Which one, as the Permissions screen names it: ${PERMISSION_WORDS}`),
      allowed: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          'true lets them, false stops them, null goes back to the default (a role) or to what their role says (a person)',
        ),
    }),
    autonomy: 'confirm',
    permission: 'permissions.manage',
  }),

  // ---------- fields, kinds of records and how they relate ----------
  define({
    name: 'manage_custom_field',
    description:
      'Add, change or retire one of the business’s own fields on customers, companies or a kind of record (a gate code, a breed, an account number). What a field holds never changes once it is made. Retiring one takes its answers off every record and can’t be undone. Field ids are in get_settings (area fields); kinds of records in get_settings (area relationships).',
    input: z.object({
      action: z.enum(['create', 'change', 'retire']),
      recordType: z
        .enum(['person', 'company', 'custom_record'])
        .optional()
        .describe('Where a new field goes: person is customers'),
      recordTypeId: uuid
        .optional()
        .describe('The kind of record, when recordType is custom_record'),
      customFieldId: uuid.optional().describe('The field to change or retire'),
      name: text(60).optional().describe('What it is called: Gate code'),
      holds: z
        .enum(CUSTOM_FIELD_TYPES)
        .optional()
        .describe('What it holds, for a new field (text if left out)'),
      choices: choices.optional(),
      help: z.string().trim().max(200).optional().describe('A line shown under it'),
      showWhenEmpty: z.boolean().optional().describe('Show it on every record even when empty'),
    }),
    autonomy: 'confirm',
    permission: 'fields.manage',
  }),
  define({
    name: 'manage_record_kind',
    description:
      'Add, change, archive or bring back a kind of record the business keeps (pets, vehicles, properties): what one is called, its picture, its first fields, and what ties it to customers or companies. Archiving hides its tab, records and relationships; nothing is deleted. Ids are in get_settings (area relationships); archived ones in list_archived_setup.',
    input: z.object({
      action: z.enum(['create', 'change', 'archive', 'restore']),
      customRecordTypeId: uuid.optional().describe('The kind to change, archive or bring back'),
      name: text(40).optional().describe('What one is called: Pet, Vehicle, Property'),
      plural: text(40).optional().describe('More than one, when it isn’t just an s: Properties'),
      nameLabel: text(40).optional().describe('What a record’s own name is called: Name, Plate'),
      icon: z.enum(RECORD_ICONS).optional(),
      fields: z
        .array(
          z.object({
            name: text(60),
            holds: z.enum(CUSTOM_FIELD_TYPES).default('text'),
            choices: choices.optional(),
          }),
        )
        .max(20)
        .optional()
        .describe('Its first fields, for create'),
      linkTo: z
        .enum(['person', 'company'])
        .optional()
        .describe('For create: tie it to customers (person) or companies as it is made'),
      linkLabel: text(40).optional().describe('What the customer is to one of these: Owner'),
      linkCardinality: cardinality.optional().describe('A is the customer, B this kind'),
    }),
    autonomy: 'confirm',
    permission: 'fields.manage',
  }),
  define({
    name: 'manage_relationship_type',
    description:
      'Set up, change, archive or bring back a way two records relate: a customer and a pet, a parent and a student, spouses. Each end is a customer, a company or a kind of record, with what it is called. Only the names of the ends and how many each may have change later. Ids are in get_settings (area relationships); archived ones in list_archived_setup.',
    input: z.object({
      action: z.enum(['create', 'change', 'archive', 'restore']),
      relationshipTypeId: uuid.optional(),
      a: relationshipEnd.optional().describe('End A, for create'),
      b: relationshipEnd.optional().describe('End B, for create'),
      cardinality: cardinality.optional(),
      sameBothWays: z
        .boolean()
        .optional()
        .describe('For create: the same on both ends, like spouses or siblings'),
      aLabel: text(40).optional().describe('For change: what end A is called now'),
      bLabel: text(40).optional().describe('For change: what end B is called now'),
    }),
    autonomy: 'confirm',
    permission: 'fields.manage',
  }),
  define({
    name: 'list_archived_setup',
    description:
      'What was archived and can be brought back, with ids: kinds of records, relationship types and templates. Retired fields can’t come back.',
    input: z.object({}),
    autonomy: 'auto',
    permission: 'records.read',
  }),

  // ---------- saved wording ----------
  define({
    name: 'manage_template',
    description:
      'Add, change, archive or bring back a template: saved wording for a text or an email that the inbox’s reply box can put in. It can use the same {{placeholders}} a workflow does, like {{person.first_name}}. Nothing is sent. Ids are in get_settings (area templates); archived ones in list_archived_setup.',
    input: z.object({
      action: z.enum(['create', 'change', 'archive', 'restore']),
      templateId: uuid.optional(),
      name: z.string().trim().min(1).max(120).optional(),
      channel: z.enum(['sms', 'email']).optional().describe('sms for a text (the default)'),
      subject: z.string().trim().max(200).nullable().optional().describe('An email’s subject'),
      body: z.string().trim().min(1).max(20_000).optional().describe('The words'),
      folder: z
        .string()
        .trim()
        .max(60)
        .nullable()
        .optional()
        .describe('The folder it sits in; null for none'),
    }),
    autonomy: 'confirm',
    permission: 'templates.manage',
  }),

  // ---------- numbers, and who sees which conversations ----------
  define({
    name: 'manage_numbers',
    description:
      'Change one of the business’s numbers: what the team calls it, making it the one new conversations go out from, or who it rings (and so whose conversations it is when each person sees only their own). An empty list rings everyone with the inbox. Numbers are in get_settings (area texting); people in list_team.',
    input: z.object({
      action: z.enum(['rename', 'make_default', 'choose_who_it_rings']),
      phoneNumberId: uuid,
      label: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .nullable()
        .optional()
        .describe('For rename: Front desk, Dispatch; null leaves just the number'),
      userIds: z
        .array(uuid)
        .max(100)
        .optional()
        .describe('For choose_who_it_rings: everyone it should ring'),
    }),
    autonomy: 'confirm',
    permission: 'channels.manage',
  }),
  define({
    name: 'set_inbox_visibility',
    description:
      'Choose whether everyone on the team sees every conversation, or each person sees only their own: the ones assigned to them and the ones on the numbers they answer (a new customer nobody has picked up yet is still seen by everybody). Owners and admins always see everything.',
    input: z.object({
      eachPersonSeesTheirOwn: z.boolean().describe('false: everyone sees everything'),
    }),
    autonomy: 'confirm',
    permission: 'channels.manage',
  }),

  // ---------- the business's own web address ----------
  define({
    name: 'manage_web_address',
    description:
      'The business’s own web address for its forms, payment links, estimates, invoices, website chat and booking page (like go.lonestarhvac.com instead of handsfreeos.com): add it, check it now, or stop using it. Putting the DNS records in is the person’s own job, with whoever sold them the domain; say so, and read the records out once there are some. What is there now is in get_settings (area branded_domain).',
    input: z.object({
      action: z.enum(['add', 'check', 'remove']),
      domain: hostname.describe('The address, like go.lonestarhvac.com'),
    }),
    autonomy: 'confirm',
    permission: 'channels.manage',
  }),

  // ---------- email: mail from strangers, and addresses we stop emailing ----------
  define({
    name: 'list_unmatched_email',
    description:
      'Email from people who aren’t in Contacts, waiting to be filed under a customer or dismissed, newest first, with ids for sort_unmatched_email.',
    input: z.object({}),
    autonomy: 'auto',
    permission: 'inbox.use',
  }),
  define({
    name: 'sort_unmatched_email',
    description:
      'File an email from someone who isn’t in Contacts under a customer (it joins their email conversation and timeline), or dismiss it. Ids from list_unmatched_email; the customer from search_customers, or add them first with create_customer.',
    input: z.object({
      action: z.enum(['file_under_customer', 'dismiss']),
      unmatchedId: uuid,
      personId: uuid.optional().describe('The customer, for file_under_customer'),
    }),
    autonomy: 'confirm',
    permission: 'inbox.use',
  }),
  define({
    name: 'list_blocked_email',
    description:
      'Email addresses nothing goes to (bounced, marked as spam, or blocked by hand), newest first, with ids for manage_email_settings to unblock one.',
    input: z.object({}),
    autonomy: 'auto',
    permission: 'inbox.use',
  }),
  define({
    name: 'block_email_address',
    description:
      'Stop all email to one address, invoices and reminders included, until it is unblocked (manage_email_settings, action unblock).',
    input: z.object({ address: z.email().max(320) }),
    autonomy: 'confirm',
    permission: 'channels.manage',
  }),

  // ---------- RCS and lead forms: only the parts with no key and no sign-in ----------
  define({
    name: 'manage_rcs',
    description:
      'Change the business’s RCS sender once it is connected: pause it (every text goes as SMS or MMS), turn it back on, choose the number a customer’s first RCS message starts its conversation on, ask Twilio where it stands now, or disconnect it. Connecting one is only on Settings → Texting & calls, since it is made in their own Twilio account. Where it stands is in get_settings (area texting).',
    input: z.object({
      action: z.enum(['pause', 'turn_on', 'start_on_number', 'check_now', 'disconnect']),
      phoneNumberId: uuid
        .nullable()
        .optional()
        .describe('For start_on_number; null is the default number'),
    }),
    autonomy: 'confirm',
    permission: 'channels.manage',
  }),
  define({
    name: 'manage_lead_form',
    description:
      'Change a form on the business’s own website or a connected app (like Zapier) that sends leads in: pause it, turn it back on, what its leads are filed under, where they land, how many a day, and a form’s sites and thank-you page; or retire it for good. Adding one or replacing its key is only on Settings → Lead intake, because it hands back a key. Texts, calls and emails are manage_lead_intake. Ids are in get_settings (area lead_intake).',
    input: z.object({
      action: z.enum(['change', 'pause', 'turn_on', 'retire']),
      sourceId: uuid,
      name: text(60).optional().describe('What its customers and leads are filed under'),
      createLead: z.boolean().optional().describe('Whether a lead opens as well as the customer'),
      pipelineId: uuid.nullable().optional().describe('Null is their first pipeline'),
      stageId: uuid.nullable().optional().describe('Null is that pipeline’s first open stage'),
      dailyCap: z.int().min(1).max(1000).optional().describe('The most leads a day it may open'),
      websites: z
        .array(text(300))
        .max(10)
        .optional()
        .describe('A form’s sites it may be sent from, like https://lonestarhvac.com'),
      thankYouPage: z
        .url()
        .max(2000)
        .nullable()
        .optional()
        .describe('Where a form’s sender goes afterwards, starting https://'),
    }),
    autonomy: 'confirm',
    permission: 'channels.manage',
  }),
];
