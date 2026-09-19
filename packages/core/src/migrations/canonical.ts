/**
 * The CRM-neutral shape everything passes through.
 *
 * An adapter reads its own system and produces these. The importers here read only these. That one rule is
 * what makes the second adapter cheap and the tenth adapter possible — and it is the rule a reviewer should
 * check first, because the temptation to "just pass the raw record through, it's only one field" is what turns
 * a migration platform back into an importer with extra steps.
 *
 * Two things every envelope carries no matter what:
 *   - where it came from, in enough detail to find it again and to never write it twice;
 *   - what could not be mapped, so nothing is lost silently. A field with no home here goes into
 *     `extensions`, and the adapter raises a finding about it. `extensions` is a safety net, not an answer:
 *     a category is not "Ready" for general release while the thing people actually use lives in there.
 */
import { z } from 'zod';

export const CANONICAL_SCHEMA_VERSION = 1;

/** Where a record came from. Enough to find it again, and to never bring it twice. */
export const CanonicalSource = z.object({
  system: z.string().min(1).max(40),
  adapterVersion: z.string().min(1).max(40),
  installationId: z.uuid(),
  /** The sub-account, as the source names it. */
  locationId: z.string().min(1).max(200),
  objectType: z.string().min(1).max(60),
  objectId: z.string().min(1).max(300),
  parentObjectId: z.string().min(1).max(300).nullish(),
  /** The old system's own times. These become the record's history here; ours never replace them. */
  sourceCreatedAt: z.iso.datetime({ offset: true }).nullish(),
  sourceUpdatedAt: z.iso.datetime({ offset: true }).nullish(),
  sourceDeletedAt: z.iso.datetime({ offset: true }).nullish(),
  retrievedAt: z.iso.datetime({ offset: true }),
  payloadChecksum: z.string().min(8).max(128),
  payloadVersion: z.number().int().min(1).max(100000),
});
export type CanonicalSource = z.infer<typeof CanonicalSource>;

/** A pointer at another record, by the source's id for it. Resolved here through the source mappings. */
export const CanonicalRef = z.object({
  /** The category the other record belongs to, so the resolver knows where to look. */
  category: z.string().min(1).max(60),
  objectType: z.string().min(1).max(60),
  objectId: z.string().min(1).max(300),
  /** How this record relates to it: 'owner', 'contact', 'company', 'conversation', 'assignee'. */
  role: z.string().min(1).max(40),
  /** false when the record is worth importing without it (the links pass attaches it later). */
  required: z.boolean().default(false),
});
export type CanonicalRef = z.infer<typeof CanonicalRef>;

/** Something the adapter could not map exactly, raised where it happened. */
export const CanonicalWarning = z.object({
  code: z.string().min(1).max(80),
  field: z.string().max(200).nullish(),
  message: z.string().min(1).max(300),
});
export type CanonicalWarning = z.infer<typeof CanonicalWarning>;

/**
 * Every normalized record, whatever it is. `data` is the canonical object for its type; `extensions` is
 * everything real that had nowhere to go, namespaced by source so it can be remapped when the home is built.
 */
export const CanonicalEnvelope = z.object({
  canonicalType: z.string().min(1).max(60),
  canonicalSchemaVersion: z.number().int().min(1).max(1000),
  category: z.string().min(1).max(60),
  source: CanonicalSource,
  relationships: z.array(CanonicalRef).max(200).default([]),
  data: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(CanonicalWarning).max(100).default([]),
});
export type CanonicalEnvelope = z.infer<typeof CanonicalEnvelope>;

/** How a field fared. Every mapped field ends as exactly one of these; silence is not allowed. */
export const MAPPING_OUTCOMES = [
  'mapped',
  'transformed',
  'kept_in_extensions',
  'skipped',
  'blocked',
] as const;
export type MappingOutcome = (typeof MAPPING_OUTCOMES)[number];

// ---------- the canonical objects ----------
// Only the ones the importers read today. Each is the HandsFreeOS idea of the thing, not any source's.

/** A phone number or email address a person can be reached on. */
export const CanonicalEndpoint = z.object({
  kind: z.enum(['phone', 'email']),
  value: z.string().min(1).max(320),
  primary: z.boolean().default(false),
  label: z.string().max(60).nullish(),
});

export const CanonicalConsent = z.object({
  channel: z.enum(['sms', 'email', 'call', 'whatsapp', 'all']),
  state: z.enum(['unknown', 'opted_in', 'opted_out']),
  at: z.iso.datetime({ offset: true }).nullish(),
  reason: z.string().max(200).nullish(),
});

export const CanonicalAddress = z.object({
  line1: z.string().max(200).nullish(),
  line2: z.string().max(200).nullish(),
  city: z.string().max(120).nullish(),
  state: z.string().max(120).nullish(),
  postalCode: z.string().max(40).nullish(),
  country: z.string().max(2).nullish(),
});

export const CanonicalContact = z.object({
  firstName: z.string().max(120).nullish(),
  lastName: z.string().max(120).nullish(),
  /** Used only when the source has no first/last split. Never guessed at beyond one space. */
  fullName: z.string().max(240).nullish(),
  email: z.string().max(320).nullish(),
  phone: z.string().max(40).nullish(),
  endpoints: z.array(CanonicalEndpoint).max(50).default([]),
  address: CanonicalAddress.nullish(),
  timezone: z.string().max(60).nullish(),
  /** What the old system called the way this customer found the business. */
  source: z.string().max(200).nullish(),
  tags: z.array(z.string().min(1).max(60)).max(200).default([]),
  customFields: z.record(z.string(), z.unknown()).default({}),
  consent: z.array(CanonicalConsent).max(10).default([]),
  notes: z.string().max(4000).nullish(),
});
export type CanonicalContact = z.infer<typeof CanonicalContact>;

export const CanonicalCompany = z.object({
  name: z.string().min(1).max(200),
  email: z.string().max(320).nullish(),
  phone: z.string().max(40).nullish(),
  website: z.string().max(400).nullish(),
  address: CanonicalAddress.nullish(),
  tags: z.array(z.string().min(1).max(60)).max(200).default([]),
  customFields: z.record(z.string(), z.unknown()).default({}),
});
export type CanonicalCompany = z.infer<typeof CanonicalCompany>;

/**
 * A person who worked in the old system. Brought across as an identity so their name stays on what they did,
 * whether or not anybody ever invites them here. Inviting is a separate, deliberate act.
 */
export const CanonicalUserIdentity = z.object({
  firstName: z.string().max(120).nullish(),
  lastName: z.string().max(120).nullish(),
  email: z.string().max(320).nullish(),
  phone: z.string().max(40).nullish(),
  /** What the old system called their role; mapped to the nearest here, never upwards. */
  roleName: z.string().max(120).nullish(),
  active: z.boolean().default(true),
});
export type CanonicalUserIdentity = z.infer<typeof CanonicalUserIdentity>;

export const CanonicalTag = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(20).nullish(),
});

/** The shape of an extra field, brought before any value that uses it. */
export const CanonicalCustomField = z.object({
  name: z.string().min(1).max(120),
  key: z.string().min(1).max(120),
  /** The canonical types. Anything else becomes a finding rather than a silently stringified value. */
  type: z.enum([
    'text',
    'long_text',
    'number',
    'money',
    'date',
    'datetime',
    'boolean',
    'choice',
    'multi_choice',
    'phone',
    'email',
    'url',
    'file',
  ]),
  options: z.array(z.string().max(200)).max(500).default([]),
  required: z.boolean().default(false),
  position: z.number().int().min(0).max(10000).default(0),
  appliesTo: z.enum(['contact', 'company', 'lead', 'appointment']).default('contact'),
});
export type CanonicalCustomField = z.infer<typeof CanonicalCustomField>;

/**
 * A thread with one customer, on one channel. The source's own channels are wider than HandsFreeOS's three,
 * so the adapter narrows them and says so: a WhatsApp or Instagram thread arrives as a chat with its real
 * channel kept beside it, rather than being dropped for having nowhere exact to go.
 */
export const CanonicalConversation = z.object({
  channel: z.enum(['sms', 'email', 'chat']),
  /** What the source called the channel, when it is not one of ours ('whatsapp', 'instagram', 'gmb'). */
  channelName: z.string().max(40).nullish(),
  /** The customer's side of it: a number, an address or a handle. */
  counterpart: z.string().min(1).max(320),
  subject: z.string().max(400).nullish(),
  /** History arrives settled. An open thread is one the business was still in the middle of. */
  status: z.enum(['open', 'closed']).default('closed'),
  startedAt: z.iso.datetime({ offset: true }).nullish(),
  lastMessageAt: z.iso.datetime({ offset: true }).nullish(),
});
export type CanonicalConversation = z.infer<typeof CanonicalConversation>;

/** A file a message carried. Copied by the engine, never by an importer. */
export const CanonicalMedia = z.object({
  url: z.string().max(2000),
  name: z.string().max(300).nullish(),
  mime: z.string().max(120).nullish(),
  sizeBytes: z.number().int().min(0).nullish(),
});
export type CanonicalMedia = z.infer<typeof CanonicalMedia>;

/**
 * One message inside a thread. `occurredAt` is when it really happened, and it is the whole point: a text
 * sent on a Tuesday afternoon in 2019 has to sit where a Tuesday afternoon in 2019 belongs.
 */
export const CanonicalMessage = z.object({
  channel: z.enum(['sms', 'email', 'chat']),
  direction: z.enum(['inbound', 'outbound']),
  /** Narrowed to what HandsFreeOS records; anything unrecognised becomes the settled state for its direction. */
  status: z
    .enum(['sent', 'delivered', 'undelivered', 'failed', 'received', 'bounced'])
    .default('delivered'),
  subject: z.string().max(400).nullish(),
  body: z.string().max(100_000).nullish(),
  bodyHtml: z.string().max(400_000).nullish(),
  fromAddress: z.string().max(320).nullish(),
  toAddresses: z.array(z.string().max(320)).max(50).default([]),
  occurredAt: z.iso.datetime({ offset: true }),
  media: z.array(CanonicalMedia).max(50).default([]),
  /** The source's own id for it, kept so the same message cannot arrive twice under another name. */
  providerMessageId: z.string().max(200).nullish(),
});
export type CanonicalMessage = z.infer<typeof CanonicalMessage>;

/** A call or a voicemail, with its recording when there was one. */
export const CanonicalCall = z.object({
  direction: z.enum(['inbound', 'outbound']),
  status: z.enum(['completed', 'no_answer', 'busy', 'failed', 'canceled']).default('completed'),
  fromNumber: z.string().max(40).nullish(),
  toNumber: z.string().max(40).nullish(),
  startedAt: z.iso.datetime({ offset: true }),
  answeredAt: z.iso.datetime({ offset: true }).nullish(),
  endedAt: z.iso.datetime({ offset: true }).nullish(),
  durationSeconds: z.number().int().min(0).max(86_400).nullish(),
  isVoicemail: z.boolean().default(false),
  recordingUrl: z.string().max(2000).nullish(),
  recordingSeconds: z.number().int().min(0).max(86_400).nullish(),
  transcript: z.string().max(100_000).nullish(),
  providerCallId: z.string().max(200).nullish(),
});
export type CanonicalCall = z.infer<typeof CanonicalCall>;

/**
 * A pipeline and the stages in it, in order.
 *
 * HandsFreeOS says what winning means with the *kind* of a stage; the source often says it with a status on
 * the deal instead. So a stage carries a kind here, inferred from its name where the source has none, and a
 * pipeline that ends up with no won or lost stage is given one — otherwise a deal that was won has nowhere to
 * be won in, and the business could never mark one again.
 */
export const CanonicalPipelineStage = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['open', 'won', 'lost']).default('open'),
  position: z.number().int().min(0).max(1000).default(0),
  /** The source's own id for the stage, so a deal can find the stage it was in. */
  sourceId: z.string().max(200).nullish(),
});
export type CanonicalPipelineStage = z.infer<typeof CanonicalPipelineStage>;

export const CanonicalPipeline = z.object({
  name: z.string().min(1).max(80),
  position: z.number().int().min(0).max(1000).default(0),
  stages: z.array(CanonicalPipelineStage).max(100).default([]),
});
export type CanonicalPipeline = z.infer<typeof CanonicalPipeline>;

/** A deal, in the stage it was in, worth what it was worth. */
export const CanonicalLead = z.object({
  title: z.string().min(1).max(160),
  /** Whole cents, because money is never a float. */
  valueCents: z.number().int().min(0).max(1_000_000_000_000).default(0),
  status: z.enum(['open', 'won', 'lost', 'abandoned']).default('open'),
  source: z.string().max(200).nullish(),
  /** Which stage it was in, by the source's own stage id. */
  sourceStageId: z.string().max(200).nullish(),
  expectedCloseOn: z.string().max(10).nullish(),
  stageEnteredAt: z.iso.datetime({ offset: true }).nullish(),
  closedAt: z.iso.datetime({ offset: true }).nullish(),
  lostReason: z.string().max(300).nullish(),
});
export type CanonicalLead = z.infer<typeof CanonicalLead>;

/**
 * A calendar the business booked visits on.
 *
 * Only the parts that mean the same thing on both sides come across: what it is called, what it is for, how
 * long a visit is and whose day it fills. Availability rules, round-robin, buffers and booking policies are
 * said in ways that do not translate, so they are not guessed at — the calendar arrives as a draft with its
 * visits in it, and the business sets its hours here once, deliberately.
 */
export const CanonicalCalendar = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  timezone: z.string().max(60).nullish(),
  /** How long a visit is, in minutes. */
  minutes: z.number().int().min(1).max(1440).default(60),
  active: z.boolean().default(true),
});
export type CanonicalCalendar = z.infer<typeof CanonicalCalendar>;

/** A visit, past or future, at the time it was really booked for. */
export const CanonicalAppointment = z.object({
  title: z.string().min(1).max(200),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).default('scheduled'),
  notes: z.string().max(5000).nullish(),
  /** Where it was, when the source said: an address, a room, a link. */
  where: z.string().max(500).nullish(),
});
export type CanonicalAppointment = z.infer<typeof CanonicalAppointment>;

/** Something still to do, for a customer. */
export const CanonicalTask = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(10_000).nullish(),
  dueAt: z.iso.datetime({ offset: true }).nullish(),
  doneAt: z.iso.datetime({ offset: true }).nullish(),
});
export type CanonicalTask = z.infer<typeof CanonicalTask>;

/** Something somebody wrote down about a customer. */
export const CanonicalNote = z.object({
  body: z.string().min(1).max(10_000),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type CanonicalNote = z.infer<typeof CanonicalNote>;

/** Something the business sells, as a line on a bill starts life. */
export const CanonicalProduct = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  unitPriceCents: z.number().int().min(0).max(100_000_000_000).default(0),
  unitLabel: z.string().max(40).default('each'),
  taxable: z.boolean().default(true),
  active: z.boolean().default(true),
});
export type CanonicalProduct = z.infer<typeof CanonicalProduct>;

/** One line of a bill, as it read when it was sent. */
export const CanonicalMoneyLine = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  quantity: z.number().min(0.001).max(1_000_000).default(1),
  unitLabel: z.string().max(40).default('each'),
  unitPriceCents: z.number().int().min(0).max(100_000_000_000).default(0),
  taxable: z.boolean().default(true),
});
export type CanonicalMoneyLine = z.infer<typeof CanonicalMoneyLine>;

/**
 * A bill, as it stood. Money is whole cents throughout — never a float, never a string — and the totals are
 * the source's own rather than ours: a bill that has gone to a customer says what it said, and recomputing it
 * from the lines would quietly change history when a rounding rule differs.
 */
export const CanonicalInvoice = z.object({
  number: z.string().max(40).nullish(),
  title: z.string().max(200).nullish(),
  notes: z.string().max(5000).nullish(),
  status: z.enum(['draft', 'sent', 'partly_paid', 'paid', 'void']).default('sent'),
  currency: z.string().length(3).default('USD'),
  subtotalCents: z.number().int().min(0).max(100_000_000_000).default(0),
  discountCents: z.number().int().min(0).max(100_000_000_000).default(0),
  taxCents: z.number().int().min(0).max(100_000_000_000).default(0),
  totalCents: z.number().int().min(0).max(100_000_000_000).default(0),
  /** What had been paid by the time it came across, and when the last of it arrived. */
  paidCents: z.number().int().min(0).max(100_000_000_000).default(0),
  paidAt: z.iso.datetime({ offset: true }).nullish(),
  issuedAt: z.iso.datetime({ offset: true }).nullish(),
  dueOn: z.string().max(10).nullish(),
  terms: z.string().max(2000).nullish(),
  lines: z.array(CanonicalMoneyLine).max(200).default([]),
});
export type CanonicalInvoice = z.infer<typeof CanonicalInvoice>;

/** A quote, as it stood, and what the customer did about it. */
export const CanonicalEstimate = z.object({
  number: z.string().max(40).nullish(),
  title: z.string().max(200).nullish(),
  notes: z.string().max(5000).nullish(),
  status: z.enum(['draft', 'sent', 'accepted', 'declined', 'expired', 'void']).default('sent'),
  currency: z.string().length(3).default('USD'),
  subtotalCents: z.number().int().min(0).max(100_000_000_000).default(0),
  discountCents: z.number().int().min(0).max(100_000_000_000).default(0),
  taxCents: z.number().int().min(0).max(100_000_000_000).default(0),
  totalCents: z.number().int().min(0).max(100_000_000_000).default(0),
  issuedAt: z.iso.datetime({ offset: true }).nullish(),
  expiresOn: z.string().max(10).nullish(),
  answeredAt: z.iso.datetime({ offset: true }).nullish(),
  /** Who said yes, when the source recorded a name against the acceptance. */
  acceptedName: z.string().max(120).nullish(),
  declinedReason: z.string().max(1000).nullish(),
  lines: z.array(CanonicalMoneyLine).max(200).default([]),
});
export type CanonicalEstimate = z.infer<typeof CanonicalEstimate>;

/**
 * A customer on a recurring plan.
 *
 * Brought across as a record of what they are on, never as something HandsFreeOS bills: the card and the
 * mandate live at the old system's processor, and only the business moving them deliberately can change that.
 */
export const CanonicalSubscription = z.object({
  planName: z.string().min(1).max(160),
  priceCents: z.number().int().min(0).max(100_000_000_000).default(0),
  interval: z.enum(['day', 'week', 'month', 'year']).default('month'),
  intervalCount: z.number().int().min(1).max(36).default(1),
  status: z.enum(['active', 'past_due', 'paused', 'cancelled']).default('active'),
  startedOn: z.string().max(10).nullish(),
  currentPeriodStart: z.string().max(10).nullish(),
  currentPeriodEnd: z.string().max(10).nullish(),
  nextBillingOn: z.string().max(10).nullish(),
  cancelledAt: z.iso.datetime({ offset: true }).nullish(),
  /** The processor's own id, kept so the two can be matched up when the business moves the billing. */
  externalId: z.string().max(200).nullish(),
});
export type CanonicalSubscription = z.infer<typeof CanonicalSubscription>;

/**
 * One question on a form, as the old system left it.
 *
 * `key` is what the source calls the field, and it is the join between a question and the answers people
 * gave it — which is the only reason it is here rather than being replaced by an id of ours at the door.
 */
export const CanonicalFormQuestion = z.object({
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  type: z
    .enum([
      'short_text',
      'long_text',
      'choice',
      'checkboxes',
      'yes_no',
      'number',
      'date',
      'email',
      'phone',
      'address',
    ])
    .default('short_text'),
  required: z.boolean().default(false),
  choices: z.array(z.string().min(1).max(200)).max(60).default([]),
});
export type CanonicalFormQuestion = z.infer<typeof CanonicalFormQuestion>;

/**
 * A form or survey people filled in.
 *
 * Most systems will not hand over the questions — they hand over the answers, and the questions have to be
 * read back out of them. So `questions` is what could honestly be worked out, and `questionsAreComplete`
 * says whether the source told us or we inferred it, because a form rebuilt from its answers is not a form
 * anyone should publish without looking at it.
 */
export const CanonicalForm = z.object({
  name: z.string().min(1).max(120),
  mode: z.enum(['form', 'survey', 'quiz']).default('form'),
  intro: z.string().max(4000).nullish(),
  questions: z.array(CanonicalFormQuestion).max(200).default([]),
  questionsAreComplete: z.boolean().default(false),
});
export type CanonicalForm = z.infer<typeof CanonicalForm>;

/** One answer as somebody gave it, against the question's own key over there. */
export const CanonicalFormAnswer = z.object({
  key: z.string().min(1).max(200),
  value: z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(500))]),
});
export type CanonicalFormAnswer = z.infer<typeof CanonicalFormAnswer>;

/** One person's answers to one form, on the day they gave them. */
export const CanonicalFormResponse = z.object({
  submittedAt: z.iso.datetime({ offset: true }),
  answers: z.array(CanonicalFormAnswer).max(200).default([]),
  /** What the source says it came in through, narrowed to what this system records. */
  source: z.enum(['link', 'embed', 'chat', 'qr', 'app', 'api']).default('link'),
});
export type CanonicalFormResponse = z.infer<typeof CanonicalFormResponse>;

export const CANONICAL_TYPES = {
  contact: CanonicalContact,
  company: CanonicalCompany,
  user_identity: CanonicalUserIdentity,
  tag: CanonicalTag,
  custom_field: CanonicalCustomField,
  conversation: CanonicalConversation,
  message: CanonicalMessage,
  call: CanonicalCall,
  pipeline: CanonicalPipeline,
  lead: CanonicalLead,
  calendar: CanonicalCalendar,
  appointment: CanonicalAppointment,
  task: CanonicalTask,
  note: CanonicalNote,
  product: CanonicalProduct,
  invoice: CanonicalInvoice,
  estimate: CanonicalEstimate,
  subscription: CanonicalSubscription,
  form: CanonicalForm,
  form_response: CanonicalFormResponse,
} as const;
export type CanonicalTypeName = keyof typeof CANONICAL_TYPES;

/** Validates an envelope's `data` against the schema for its type. Unknown types are refused, not guessed. */
export function parseCanonical(envelope: CanonicalEnvelope): {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly data: Record<string, unknown>;
} {
  const schema = CANONICAL_TYPES[envelope.canonicalType as CanonicalTypeName];
  if (!schema)
    return { ok: false, issues: [`Unknown canonical type ${envelope.canonicalType}.`], data: {} };
  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'record'}: ${i.message}`),
      data: {},
    };
  return { ok: true, issues: [], data: parsed.data as Record<string, unknown> };
}
