/**
 * The stand-in CRM: local development, the tests and every Playwright spec migrate from this.
 *
 * It is not a mock that returns three rows. It is a small, deliberately awkward agency, because the things
 * that go wrong in a migration are the things a happy-path fixture never contains:
 *
 *   - **Two sub-accounts** (Austin and Dallas), so the many-to-one mapping Chris chose is really exercised.
 *   - **The same customer in both**, with the same mobile number, so a merge across sub-accounts happens.
 *   - **Two Dave Smiths**, one in each sub-account, with different numbers — so anything matching on names
 *     would join two real people and the test would catch it.
 *   - **A customer whose email points at one person here and whose phone points at another**, which is the
 *     conflict that must always go to a human.
 *   - **A custom field of a type we have no home for**, so the "kept, not dropped" promise is under test.
 *   - **A category the sign-in cannot reach** (companies, from the start), so "we were not allowed to look"
 *     never renders as zero — and a second one it *can* read but this system has nowhere to put (custom
 *     fields), so the two are visibly different answers rather than one shrug.
 *   - **A page boundary**: more contacts than one page holds, so resuming and the cursor are exercised.
 *
 * Nothing here looks like a secret: its tokens say they are fake.
 */
import type {
  CapabilityManifest,
  CategorySupport,
  CanonicalEnvelope,
  CrmSourceAdapter,
  InventoryResult,
  ListOptions,
  MappingContext,
  SourceConnection,
  SourcePage,
  SourceRecord,
} from '@hfos/core/server';
import { CANONICAL_SCHEMA_VERSION, migrationCategory, releaseCapability } from '@hfos/core/server';

export const FAKE_ADAPTER_VERSION = 'fake-1';
/** A page, small on purpose so the tests cross a boundary without thousands of rows. */
export const FAKE_PAGE_SIZE = 3;

export interface FakeSource {
  readonly adapter: CrmSourceAdapter;
  /** Every request the engine made, so a spec can assert the scan never wrote and the import never re-read. */
  readonly calls: { category: string; scope: string; cursor: unknown }[];
  /** Take a category away from the sign-in, to prove a permission gap never shows as an empty account. */
  denyScope(scope: string): void;
  reset(): void;
}

interface FakeRecord {
  readonly objectType: string;
  readonly objectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payload: Record<string, unknown>;
}

const AUSTIN = 'loc_austin';
const DALLAS = 'loc_dallas';

/** The agency, as the stand-in holds it. Exported so specs can name what they expect to arrive. */
export const FAKE_SCOPES: readonly { id: string; name: string; timezone: string }[] = [
  { id: AUSTIN, name: 'Lone Star HVAC — Austin', timezone: 'America/Chicago' },
  { id: DALLAS, name: 'Lone Star HVAC — Dallas', timezone: 'America/Chicago' },
];

const user = (
  id: string,
  first: string,
  last: string,
  email: string,
  role: string,
): FakeRecord => ({
  objectType: 'user',
  objectId: id,
  createdAt: '2024-01-04T15:00:00.000Z',
  updatedAt: '2025-06-01T12:00:00.000Z',
  payload: { id, firstName: first, lastName: last, email, roles: { type: 'account', role } },
});

const tag = (id: string, name: string): FakeRecord => ({
  objectType: 'tag',
  objectId: id,
  createdAt: '2024-02-01T10:00:00.000Z',
  updatedAt: '2024-02-01T10:00:00.000Z',
  payload: { id, name },
});

const field = (id: string, name: string, key: string, dataType: string): FakeRecord => ({
  objectType: 'custom_field',
  objectId: id,
  createdAt: '2024-02-01T10:00:00.000Z',
  updatedAt: '2024-02-01T10:00:00.000Z',
  payload: { id, name, fieldKey: key, dataType, model: 'contact', position: 1 },
});

interface ContactSeed {
  id: string;
  first: string;
  last: string;
  email?: string;
  phone?: string;
  tags?: string[];
  owner?: string;
  added: string;
  updated?: string;
  dnd?: boolean;
  fields?: { id: string; value: unknown }[];
  extra?: Record<string, unknown>;
}

const contact = (c: ContactSeed): FakeRecord => ({
  objectType: 'contact',
  objectId: c.id,
  createdAt: c.added,
  updatedAt: c.updated ?? c.added,
  payload: {
    id: c.id,
    firstName: c.first,
    lastName: c.last,
    contactName: `${c.first} ${c.last}`,
    email: c.email,
    phone: c.phone,
    tags: c.tags ?? [],
    assignedTo: c.owner,
    dateAdded: c.added,
    dateUpdated: c.updated ?? c.added,
    dnd: c.dnd ?? false,
    customFields: c.fields ?? [],
    ...(c.extra ?? {}),
  },
});

/** Something the business sells. Its prices are a list of their own over there. */
const sells = (id: string, name: string, dollars: number): FakeRecord => ({
  objectType: 'product',
  objectId: id,
  createdAt: '2019-03-01T10:00:00.000Z',
  updatedAt: '2024-03-01T10:00:00.000Z',
  payload: {
    id,
    name,
    description: null,
    prices: [{ _id: `${id}_p1`, amount: dollars, currency: 'USD' }],
    availableInStore: true,
  },
});

/** A bill. GoHighLevel keeps money as dollars and what was paid on the document itself. */
const billed = (
  id: string,
  contactId: string,
  number: string,
  status: string,
  total: number,
  paid: number,
  issued: string,
  items: readonly { name: string; qty: number; amount: number }[],
  extra: Record<string, unknown> = {},
): FakeRecord => ({
  objectType: 'invoice',
  objectId: id,
  createdAt: issued,
  updatedAt: issued,
  payload: {
    _id: id,
    invoiceNumber: number,
    title: 'Service',
    status,
    currency: 'USD',
    total,
    subtotal: total,
    amountPaid: paid,
    issueDate: issued,
    dueDate: new Date(new Date(issued).getTime() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    contactDetails: { id: contactId },
    invoiceItems: items.map((it) => ({ name: it.name, qty: it.qty, amount: it.amount })),
    ...extra,
  },
});

/** A quote, and what the customer did about it. */
const quoted = (
  id: string,
  contactId: string,
  number: string,
  status: string,
  total: number,
  issued: string,
  extra: Record<string, unknown> = {},
): FakeRecord => ({
  objectType: 'estimate',
  objectId: id,
  createdAt: issued,
  updatedAt: issued,
  payload: {
    _id: id,
    estimateNumber: number,
    title: 'Quote',
    status,
    currency: 'USD',
    total,
    subtotal: total,
    issueDate: issued,
    contactDetails: { id: contactId },
    estimateItems: [{ name: 'Replacement coil', qty: 1, amount: total }],
    ...extra,
  },
});

/** A customer on a recurring plan, billed by the old system's own processor. */
const onPlan = (
  id: string,
  contactId: string,
  name: string,
  dollars: number,
  status: string,
  started: string,
): FakeRecord => ({
  objectType: 'subscription',
  objectId: id,
  createdAt: started,
  updatedAt: started,
  payload: {
    _id: id,
    subscriptionId: id,
    name,
    amount: dollars,
    interval: 'monthly',
    intervalCount: 1,
    status,
    startDate: started,
    nextChargeDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    contactDetails: { id: contactId },
  },
});

/** Something still to do for a customer, the way GoHighLevel keeps it: on the customer. */
const todo = (
  id: string,
  contactId: string,
  title: string,
  added: string,
  extra: Record<string, unknown> = {},
): FakeRecord => ({
  objectType: 'task',
  objectId: id,
  createdAt: added,
  updatedAt: added,
  payload: { id, contactId, title, dateAdded: added, assignedTo: 'usr_ana', ...extra },
});

/** Something somebody wrote down about a customer. */
const wrote = (id: string, contactId: string, body: string, added: string): FakeRecord => ({
  objectType: 'note',
  objectId: id,
  createdAt: added,
  updatedAt: added,
  payload: { id, contactId, body, userId: 'usr_dev', dateAdded: added },
});

/** A saved piece of wording. The third one has a name and no words, which is a real shape. */
const wording = (
  id: string,
  name: string,
  subject: string | null,
  body: string | null,
): FakeRecord => ({
  objectType: 'template',
  objectId: id,
  createdAt: '2020-06-01T10:00:00.000Z',
  updatedAt: '2024-06-01T10:00:00.000Z',
  payload: { id, name, subject, ...(body === null ? {} : { html: body }) },
});

/**
 * A form. The stand-in source is one of the kinder ones: it hands over its questions, which is what an
 * adapter is allowed to do when the source really has an endpoint for them. A form with no `questions` is
 * the other case — everything anybody answered is kept and the form itself has to be finished by hand.
 */
const form = (
  id: string,
  name: string,
  mode: 'form' | 'survey',
  questions: readonly { key: string; title: string; type: string; required?: boolean }[],
): FakeRecord => ({
  objectType: 'form',
  objectId: id,
  createdAt: '2021-03-02T10:00:00.000Z',
  updatedAt: '2024-05-02T10:00:00.000Z',
  payload: { id, name, mode, questions },
});

/** One person's answers, keyed by the question's own name over there. */
const answered = (
  id: string,
  formId: string,
  contactId: string | null,
  at: string,
  answers: Record<string, unknown>,
): FakeRecord => ({
  objectType: 'form_submission',
  objectId: id,
  createdAt: at,
  updatedAt: at,
  payload: { id, formId, contactId, createdAt: at, ...answers },
});

/** A calendar, with a visit length and nothing HandsFreeOS could use for its hours. */
const calendar = (id: string, name: string, minutes: number): FakeRecord => ({
  objectType: 'calendar',
  objectId: id,
  createdAt: '2019-02-01T09:00:00.000Z',
  updatedAt: '2024-02-01T09:00:00.000Z',
  payload: {
    id,
    name,
    description: 'Service visits',
    slotDuration: minutes,
    slotDurationUnit: 'mins',
    timezone: 'America/Chicago',
    isActive: true,
  },
});

/** A visit. `appointmentStatus` is GoHighLevel's own word for how it went. */
const visit = (
  id: string,
  calendarId: string,
  contactId: string,
  title: string,
  startsAt: string,
  minutes: number,
  status: string,
  extra: Record<string, unknown> = {},
): FakeRecord => ({
  objectType: 'appointment',
  objectId: id,
  createdAt: startsAt,
  updatedAt: startsAt,
  payload: {
    id,
    calendarId,
    contactId,
    title,
    startTime: startsAt,
    endTime: new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString(),
    appointmentStatus: status,
    assignedUserId: 'usr_ana',
    dateAdded: startsAt,
    ...extra,
  },
});

/** A pipeline and its stages, the way GoHighLevel hands them over: columns with no meaning of their own. */
const pipeline = (
  id: string,
  name: string,
  stages: readonly { id: string; name: string }[],
): FakeRecord => ({
  objectType: 'pipeline',
  objectId: id,
  createdAt: '2019-01-15T10:00:00.000Z',
  updatedAt: '2024-01-15T10:00:00.000Z',
  payload: {
    id,
    name,
    stages: stages.map((st, i) => ({ id: st.id, name: st.name, position: i })),
  },
});

/** A deal. `status` is where GoHighLevel keeps won and lost, rather than on the stage. */
const deal = (
  id: string,
  name: string,
  contactId: string,
  pipelineId: string,
  stageId: string,
  status: string,
  value: number,
  added: string,
  extra: Record<string, unknown> = {},
): FakeRecord => ({
  objectType: 'opportunity',
  objectId: id,
  createdAt: added,
  updatedAt: added,
  payload: {
    id,
    name,
    contactId,
    pipelineId,
    pipelineStageId: stageId,
    status,
    monetaryValue: value,
    assignedTo: 'usr_ana',
    source: 'Google',
    dateAdded: added,
    ...extra,
  },
});

/** A thread with one customer on one channel. `type` is GoHighLevel's own spelling. */
const thread = (
  id: string,
  contactId: string,
  type: string,
  who: { phone?: string; email?: string; name?: string },
  added: string,
  lastAt: string,
): FakeRecord => ({
  objectType: 'conversation',
  objectId: id,
  createdAt: added,
  updatedAt: lastAt,
  payload: {
    id,
    contactId,
    type,
    phone: who.phone,
    email: who.email,
    contactName: who.name,
    dateAdded: added,
    lastMessageDate: lastAt,
    unreadCount: 0,
  },
});

/** One message in a thread. `messageType` decides whether it is a message or a call over there. */
const said = (
  id: string,
  conversationId: string,
  messageType: string,
  direction: 'inbound' | 'outbound',
  at: string,
  body: string,
  extra: Record<string, unknown> = {},
): FakeRecord => ({
  objectType:
    messageType.includes('CALL') || messageType.includes('VOICEMAIL') ? 'call' : 'message',
  objectId: id,
  createdAt: at,
  updatedAt: at,
  payload: {
    id,
    conversationId,
    messageType,
    direction,
    status: direction === 'inbound' ? 'received' : 'delivered',
    body,
    dateAdded: at,
    ...extra,
  },
});

/** Austin. The 2019 dates matter: a migration that stamped today's date would fail its own history check. */
const AUSTIN_RECORDS: readonly FakeRecord[] = [
  user('usr_ana', 'Ana', 'Ruiz', 'ana@lonestarhvac.example', 'admin'),
  user('usr_dev', 'Devon', 'Clark', 'devon@lonestarhvac.example', 'user'),
  tag('tag_vip', 'VIP'),
  tag('tag_maint', 'Maintenance plan'),
  field('fld_unit', 'Unit model', 'contact.unit_model', 'TEXT'),
  field('fld_install', 'Install date', 'contact.install_date', 'DATE'),
  // A type with no home here: the promise is that it is kept and raised, not flattened and forgotten.
  field('fld_sig', 'Signed agreement', 'contact.signed_agreement', 'SIGNATURE'),
  contact({
    id: 'con_a1',
    first: 'Dave',
    last: 'Smith',
    email: 'dave.smith@example.com',
    phone: '+15125550101',
    tags: ['VIP'],
    owner: 'usr_ana',
    added: '2019-04-11T14:22:00.000Z',
    updated: '2025-08-02T09:10:00.000Z',
    fields: [{ id: 'fld_unit', value: 'Carrier 24ACC6' }],
  }),
  contact({
    id: 'con_a2',
    first: 'Maria',
    last: 'Alvarez',
    email: 'maria@example.com',
    phone: '+15125550102',
    tags: ['Maintenance plan'],
    owner: 'usr_dev',
    added: '2020-09-30T18:05:00.000Z',
  }),
  // Also in Dallas, on the same mobile: the one that proves a merge across sub-accounts works.
  contact({
    id: 'con_a3',
    first: 'Tom',
    last: 'Nguyen',
    email: 'tom@example.com',
    phone: '+15125550103',
    added: '2021-02-14T11:00:00.000Z',
  }),
  contact({
    id: 'con_a4',
    first: 'Priya',
    last: 'Patel',
    email: 'priya@example.com',
    phone: '+15125550104',
    added: '2022-07-19T16:45:00.000Z',
    dnd: true,
  }),
  contact({
    id: 'con_a5',
    first: 'Sam',
    last: 'Okafor',
    phone: '+15125550105',
    added: '2023-01-08T08:30:00.000Z',
    extra: {
      address1: '900 Congress Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    },
  }),
  // A form somebody opened and walked away from. GoHighLevel keeps the contact it made: an email address,
  // no name, and nothing else. It is a real customer and it has to come across.
  contact({
    id: 'con_a6',
    first: '',
    last: '',
    email: 'no.name@example.com',
    added: '2024-02-03T11:00:00.000Z',
  }),
  // And the same thing with the email missing too — no name, no email, no number. There is no customer
  // here to bring, and saying so is better than a book full of people called "Someone".
  contact({
    id: 'con_a7',
    first: '',
    last: '',
    added: '2024-02-04T11:00:00.000Z',
  }),

  // ---------- the work ----------
  // Stages with no meaning of their own: nothing here reads as won or lost, so the import has to add
  // somewhere to win and somewhere to lose or the business could never mark another deal.
  pipeline('pip_sales', 'Sales', [
    { id: 'stg_new', name: 'New enquiry' },
    { id: 'stg_quote', name: 'Quote sent' },
    { id: 'stg_sched', name: 'Scheduled' },
  ]),
  deal(
    'opp_a1',
    'AC replacement',
    'con_a1',
    'pip_sales',
    'stg_quote',
    'open',
    4200,
    '2024-03-01T10:00:00.000Z',
  ),
  deal(
    'opp_a2',
    'Annual plan',
    'con_a2',
    'pip_sales',
    'stg_sched',
    'won',
    349.5,
    '2021-03-02T11:00:00.000Z',
    {
      lastStatusChangeAt: '2021-03-20T16:00:00.000Z',
    },
  ),
  deal(
    'opp_a3',
    'Ducting quote',
    'con_a4',
    'pip_sales',
    'stg_quote',
    'lost',
    1800,
    '2022-09-10T09:00:00.000Z',
    {
      lastStatusChangeAt: '2022-10-01T09:00:00.000Z',
      lostReasonName: 'Went with a cheaper quote',
    },
  ),
  // Abandoned over there is lost here, and the reason says so rather than pretending it was a decision.
  deal(
    'opp_a4',
    'Thermostat upgrade',
    'con_a5',
    'pip_sales',
    'stg_new',
    'abandoned',
    260,
    '2023-02-11T14:00:00.000Z',
  ),

  // ---------- what they sell, and what they billed ----------
  sells('prd_service', 'Service call', 129),
  sells('prd_coil', 'Replacement coil', 850),
  // Paid in full, years ago: the payment must not look like one anybody here could refund.
  billed('inv_a1', 'con_a1', 'INV-1041', 'paid', 129, 129, '2019-06-05T10:00:00.000Z', [
    { name: 'Service call', qty: 1, amount: 129 },
  ]),
  // Half paid, and still owed: the one that must never be chased from here.
  billed('inv_a2', 'con_a2', 'INV-1120', 'partially_paid', 420.5, 200, '2021-05-02T10:00:00.000Z', [
    { name: 'Annual plan', qty: 1, amount: 349.5 },
    { name: 'Filter pack', qty: 2, amount: 35.5 },
  ]),
  // In a currency HandsFreeOS does not hold: said out loud rather than stored as though it were dollars.
  billed(
    'inv_a3',
    'con_a4',
    'INV-1200',
    'sent',
    90,
    0,
    '2022-10-02T10:00:00.000Z',
    [{ name: 'Callout', qty: 1, amount: 90 }],
    { currency: 'CAD' },
  ),

  // Accepted years ago, and one still out — the one that must not be nudged from here.
  quoted('est_a1', 'con_a1', 'EST-204', 'accepted', 850, '2023-08-01T10:00:00.000Z', {
    acceptedBy: 'Dave Smith',
  }),
  quoted('est_a2', 'con_a5', 'EST-311', 'sent', 1250, '2024-05-02T10:00:00.000Z'),

  // A plan still charging at the old system's processor, and one that was cancelled.
  onPlan('sub_a1', 'con_a2', 'Maintenance plan', 29, 'active', '2021-03-20T10:00:00.000Z'),
  onPlan('sub_a2', 'con_a4', 'Filter club', 12, 'cancelled', '2022-01-10T10:00:00.000Z'),

  // ---------- what people wrote down, and what is still to do ----------
  todo('tsk_a1', 'con_a1', 'Order the replacement coil', '2024-03-04T09:00:00.000Z', {
    dueDate: '2024-03-08T17:00:00.000Z',
    body: 'Carrier, 3 ton.',
  }),
  todo('tsk_a2', 'con_a2', 'Send the renewal paperwork', '2021-02-25T09:00:00.000Z', {
    completed: true,
  }),
  wrote(
    'not_a1',
    'con_a1',
    'Dog in the back garden — ring the bell first.',
    '2019-04-12T10:30:00.000Z',
  ),
  wrote(
    'not_a2',
    'con_a1',
    'Second unit in the loft is out of warranty.',
    '2023-08-02T13:15:00.000Z',
  ),

  // ---------- the diary ----------
  calendar('cal_service', 'Service visits', 90),
  // Behind them: a visit that happened, one nobody came to, one that was called off.
  visit('apt_a1', 'cal_service', 'con_a1', 'AC service', '2019-06-04T14:00:00.000Z', 90, 'showed', {
    address: '1200 Barton Springs Rd, Austin',
    notes: 'Gate code 2214.',
  }),
  visit(
    'apt_a2',
    'cal_service',
    'con_a2',
    'Filter change',
    '2021-04-19T16:00:00.000Z',
    60,
    'noshow',
  ),
  visit(
    'apt_a3',
    'cal_service',
    'con_a4',
    'Quote visit',
    '2022-09-08T15:00:00.000Z',
    60,
    'cancelled',
  ),
  // Ahead of them: the one that has to be in the diary on the morning they move in. A year out, so it stays
  // in the future however long this repository lives.
  visit(
    'apt_a4',
    'cal_service',
    'con_a5',
    'Annual service',
    new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
    90,
    'confirmed',
  ),

  // ---------- the history ----------
  // Two text threads with the same customer, which is something the old system allows and this one does not:
  // they have to fold into one timeline rather than one of them being lost.
  thread(
    'cnv_a1',
    'con_a1',
    'TYPE_SMS',
    { phone: '+15125550101' },
    '2019-05-02T15:00:00.000Z',
    '2019-05-02T15:40:00.000Z',
  ),
  thread(
    'cnv_a1b',
    'con_a1',
    'TYPE_SMS',
    { phone: '+15125550101' },
    '2024-06-11T17:00:00.000Z',
    '2024-06-11T17:05:00.000Z',
  ),
  // An email thread, and a WhatsApp one — the channel HandsFreeOS has no exact home for.
  thread(
    'cnv_a2',
    'con_a2',
    'TYPE_EMAIL',
    { email: 'maria@example.com' },
    '2020-10-01T09:00:00.000Z',
    '2020-10-01T09:30:00.000Z',
  ),
  thread(
    'cnv_a4',
    'con_a4',
    'TYPE_WHATSAPP',
    { phone: '+15125550104', name: 'Priya Patel' },
    '2022-08-01T12:00:00.000Z',
    '2022-08-01T12:10:00.000Z',
  ),

  // A photo of the unit, texted in: the kind of file the whole of the old system's storage is made of.
  said(
    'msg_a1',
    'cnv_a1',
    'TYPE_SMS',
    'inbound',
    '2019-05-02T15:00:00.000Z',
    'Our AC is making a grinding noise.',
    { attachments: ['https://fake.invalid/media/msg_a1-unit.jpg'] },
  ),
  said(
    'msg_a2',
    'cnv_a1',
    'TYPE_SMS',
    'outbound',
    '2019-05-02T15:20:00.000Z',
    'We can be there Thursday at 9.',
  ),
  said(
    'msg_a3',
    'cnv_a1',
    'TYPE_SMS',
    'inbound',
    '2019-05-02T15:40:00.000Z',
    'Thursday works, thank you.',
  ),
  // The same photo again, five years later: the same bytes under two records, which is one copy here.
  said(
    'msg_a4',
    'cnv_a1b',
    'TYPE_SMS',
    'inbound',
    '2024-06-11T17:00:00.000Z',
    'Time for the annual service?',
    { attachments: ['https://fake.invalid/media/msg_a4-unit.jpg'] },
  ),
  said(
    'msg_a5',
    'cnv_a2',
    'TYPE_EMAIL',
    'outbound',
    '2020-10-01T09:00:00.000Z',
    'Your maintenance plan renews next month.',
    {
      subject: 'Maintenance plan renewal',
      from: 'hello@lonestarhvac.example',
      to: 'maria@example.com',
    },
  ),
  // Longer than a message here holds: every character still has to survive the move.
  said(
    'msg_a6',
    'cnv_a2',
    'TYPE_EMAIL',
    'outbound',
    '2020-10-01T09:30:00.000Z',
    `Spring checklist. ${'Check the filter. '.repeat(700)}`,
    {
      subject: 'Spring checklist',
    },
  ),
  said(
    'msg_a7',
    'cnv_a4',
    'TYPE_WHATSAPP',
    'inbound',
    '2022-08-01T12:00:00.000Z',
    'Are you open Saturday?',
  ),

  // The wording they reuse. The last one is listed over there with nothing in it.
  wording(
    'tpl_quote',
    'Quote follow-up',
    'Your quote from Lone Star HVAC',
    '<p>Hi {{person.first_name}}, just checking you got the quote we sent.</p>',
  ),
  wording(
    'tpl_onway',
    'On our way',
    'We are on our way',
    '<p>{{person.first_name}}, we are on our way and should be with you shortly.</p>',
  ),
  wording('tpl_empty', 'Winter reminder', 'Time for your winter service', null),

  // The form on their website, with its questions, and three people who filled it in.
  form('frm_quote', 'Get a quote', 'form', [
    { key: 'first_name', title: 'Your name', type: 'short_text', required: true },
    { key: 'email', title: 'Email', type: 'email', required: true },
    { key: 'phone', title: 'Phone', type: 'phone' },
    { key: 'what_do_you_need', title: 'What do you need?', type: 'long_text' },
    { key: 'how_many_units', title: 'How many units?', type: 'number' },
  ]),
  // A survey whose questions the old system will not hand over: only the answers say what it asked.
  form('frm_after', 'After the visit', 'survey', []),
  answered('sub_1', 'frm_quote', 'con_a1', '2023-04-02T14:00:00.000Z', {
    first_name: 'Dave',
    email: 'dave.smith@example.com',
    phone: '+15125550101',
    what_do_you_need: 'The upstairs unit is not keeping up in the afternoon.',
    how_many_units: 2,
  }),
  answered('sub_2', 'frm_quote', 'con_a2', '2023-09-18T09:30:00.000Z', {
    first_name: 'Maria',
    email: 'maria@example.com',
    what_do_you_need: 'Annual service, please.',
    how_many_units: 1,
  }),
  // Nobody in the book: the answers still land, on a form, waiting for somebody to deal with them.
  answered('sub_3', 'frm_quote', null, '2024-01-07T17:45:00.000Z', {
    first_name: 'Walk-in',
    email: 'someone@example.com',
    what_do_you_need: 'Quote for a new install.',
  }),

  // A call with a recording, and a voicemail.
  said('cal_a1', 'cnv_a1', 'TYPE_CALL', 'outbound', '2019-05-03T09:05:00.000Z', '', {
    from: '+15125550000',
    to: '+15125550101',
    attachments: ['https://fake.invalid/recordings/cal_a1.mp3'],
    meta: { call: { status: 'completed', duration: 214 } },
  }),
  said('cal_a2', 'cnv_a1', 'TYPE_VOICEMAIL', 'inbound', '2021-11-19T18:40:00.000Z', '', {
    from: '+15125550101',
    to: '+15125550000',
    meta: {
      call: { status: 'voicemail', duration: 31 },
      transcript: 'Hi, calling about the thermostat.',
    },
  }),
];

/** Dallas. A second Dave Smith, a different person, and the email/phone conflict. */
const DALLAS_RECORDS: readonly FakeRecord[] = [
  user('usr_ana', 'Ana', 'Ruiz', 'ana@lonestarhvac.example', 'admin'),
  user('usr_kim', 'Kim', 'Bao', 'kim@lonestarhvac.example', 'user'),
  tag('tag_vip_d', 'VIP'),
  field('fld_unit_d', 'Unit model', 'contact.unit_model', 'TEXT'),
  contact({
    id: 'con_d1',
    first: 'Dave',
    last: 'Smith',
    email: 'd.smith@other.example',
    phone: '+14695550201',
    added: '2020-03-02T13:00:00.000Z',
  }),
  // The same person as Austin's con_a3, on the same number.
  contact({
    id: 'con_d2',
    first: 'Tom',
    last: 'Nguyen',
    email: 'tom.nguyen@example.com',
    phone: '+15125550103',
    added: '2021-06-21T09:15:00.000Z',
  }),
  // Email says one of ours, phone says another: always a human's decision.
  contact({
    id: 'con_d3',
    first: 'Chris',
    last: 'Doyle',
    email: 'maria@example.com',
    phone: '+15125550101',
    added: '2022-11-05T15:20:00.000Z',
  }),
  contact({
    id: 'con_d4',
    first: 'Lena',
    last: 'Fischer',
    email: 'lena@example.com',
    phone: '+14695550204',
    added: '2023-05-17T10:05:00.000Z',
  }),

  // Tom is the same person as Austin's con_a3 on the same number, so his thread from this sub-account has to
  // join the customer they merged into rather than making a second one.
  thread(
    'cnv_d2',
    'con_d2',
    'TYPE_SMS',
    { phone: '+15125550103' },
    '2021-07-01T14:00:00.000Z',
    '2021-07-01T14:30:00.000Z',
  ),
  said(
    'msg_d1',
    'cnv_d2',
    'TYPE_SMS',
    'inbound',
    '2021-07-01T14:00:00.000Z',
    'Can you service the Dallas office too?',
  ),
  said(
    'msg_d2',
    'cnv_d2',
    'TYPE_SMS',
    'outbound',
    '2021-07-01T14:30:00.000Z',
    'Yes — same plan, same price.',
  ),
];

const RECORDS: Record<string, readonly FakeRecord[]> = {
  [AUSTIN]: AUSTIN_RECORDS,
  [DALLAS]: DALLAS_RECORDS,
};

const CATEGORY_TYPE: Record<string, string> = {
  products: 'product',
  invoices: 'invoice',
  estimates: 'estimate',
  subscriptions: 'subscription',
  tasks: 'task',
  calendars: 'calendar',
  appointments: 'appointment',
  pipelines: 'pipeline',
  opportunities: 'opportunity',
  users: 'user',
  tags: 'tag',
  custom_fields: 'custom_field',
  contacts: 'contact',
  companies: 'company',
  conversations: 'conversation',
  messages: 'message',
  calls: 'call',
  forms: 'form',
  form_submissions: 'form_submission',
  templates: 'template',
};

/** What the stand-in pretends exists but this release does not read record by record. */
const COUNTS_ONLY: Record<string, number> = {
  reviews: 37,
  media: 640,
  phone_numbers: 2,
  sending_domains: 1,
  integrations: 3,
  workflows: 17,
  websites: 1,
  funnels: 4,
};

const SCOPE_NAMES: Record<string, readonly string[]> = {
  users: ['users.readonly'],
  tags: ['tags.readonly'],
  custom_fields: ['customFields.readonly'],
  contacts: ['contacts.readonly'],
  companies: ['companies.readonly'],
  products: ['products.readonly'],
  invoices: ['invoices.readonly'],
  estimates: ['invoices.readonly'],
  subscriptions: ['payments/subscriptions.readonly'],
  tasks: ['contacts.readonly'],
  calendars: ['calendars.readonly'],
  appointments: ['calendars/events.readonly'],
  pipelines: ['opportunities.readonly'],
  opportunities: ['opportunities.readonly'],
  conversations: ['conversations.readonly'],
  messages: ['conversations/message.readonly'],
  calls: ['conversations/message.readonly'],
  forms: ['forms.readonly'],
  form_submissions: ['forms.readonly'],
  templates: ['emails/builder.readonly'],
};

export function createFakeSourceAdapter(): FakeSource {
  const calls: { category: string; scope: string; cursor: unknown }[] = [];
  // Companies are out of reach from the start, on purpose: every run of the stand-in then has one category
  // the sign-in was not allowed to read, so "we were not allowed to look" is exercised rather than assumed.
  // Custom fields are the other half of the pair — readable, and with nowhere here to put them.
  const denied = new Set<string>(['companies.readonly']);

  const supportOf = (category: string): CategorySupport => {
    const required = SCOPE_NAMES[category] ?? [];
    const missing = required.filter((s) => denied.has(s));
    const cat = migrationCategory(category);
    return {
      category,
      capability:
        missing.length > 0
          ? 'not_available'
          : cat
            ? releaseCapability(cat.release)
            : 'not_in_release',
      requiredScopes: required,
      missingScopes: missing,
      countQuality: missing.length > 0 ? 'permission_limited' : 'complete',
      incremental: category === 'contacts',
      webhooks: category === 'contacts',
      stableIds: true,
      timestamps: { created: true, updated: true, deleted: false },
    };
  };

  const adapter: CrmSourceAdapter = {
    system: 'gohighlevel',
    adapterVersion: FAKE_ADAPTER_VERSION,
    requestedScopes: [...new Set(Object.values(SCOPE_NAMES).flat())].sort(),

    authorizeUrl: ({ state, redirectUri }) =>
      `${redirectUri}?code=fake-code&state=${encodeURIComponent(state)}`,

    async exchangeCode() {
      return {
        id: '',
        system: 'gohighlevel',
        installKind: 'agency',
        externalAccountId: 'fake-agency',
        scopes: [...new Set(Object.values(SCOPE_NAMES).flat())].filter((s) => !denied.has(s)),
        accessToken: 'fake-not-a-real-token',
        refreshToken: 'fake-not-a-real-refresh-token',
        expiresAt: new Date(Date.now() + 86_400_000),
      } satisfies SourceConnection;
    },

    /**
     * The token door (0069), so the paste-a-token screen can be walked end to end with no account anywhere.
     * It behaves like the real one where it matters: one sub-account, no scope list, nothing to refresh, and
     * an id it does not recognise is refused rather than quietly accepted.
     */
    async connectWithToken({ token, accountId }) {
      const id = accountId.trim();
      if (!token.trim()) throw new Error('Paste the private integration token.');
      if (!FAKE_SCOPES.some((s) => s.id === id))
        throw new Error(`The stand-in agency has no sub-account ${id || '(none given)'}.`);
      return {
        id: '',
        system: 'gohighlevel',
        installKind: 'location',
        authKind: 'private_token',
        externalAccountId: id,
        displayName: FAKE_SCOPES.find((s) => s.id === id)?.name ?? null,
        scopes: [],
        accessToken: 'fake-not-a-real-private-token',
        refreshToken: null,
        expiresAt: null,
      } satisfies SourceConnection;
    },

    async refresh(connection) {
      return { ...connection, expiresAt: new Date(Date.now() + 86_400_000) };
    },

    async discoverScopes(connection) {
      // A private token reaches the one sub-account it was made in, exactly as GoHighLevel's does.
      if (connection.installKind === 'location') {
        const one = FAKE_SCOPES.find((s) => s.id === connection.externalAccountId);
        return one
          ? [
              {
                externalScopeId: one.id,
                name: one.name,
                timezone: one.timezone,
                descriptor: { country: 'US' },
              },
            ]
          : [];
      }
      return FAKE_SCOPES.map((s) => ({
        externalScopeId: s.id,
        name: s.name,
        timezone: s.timezone,
        descriptor: { country: 'US' },
      }));
    },

    async inspectCapabilities(): Promise<CapabilityManifest> {
      return {
        system: 'gohighlevel',
        adapterVersion: FAKE_ADAPTER_VERSION,
        categories: [
          ...Object.keys(CATEGORY_TYPE).map(supportOf),
          ...Object.keys(COUNTS_ONLY).map(supportOf),
        ],
        rateLimit: { requestsPerSecond: 100, burst: 100 },
      };
    },

    async *scan(_connection, scope) {
      for (const category of Object.keys(CATEGORY_TYPE)) {
        const support = supportOf(category);
        const cat = migrationCategory(category);
        if (support.missingScopes.length > 0) {
          yield {
            category,
            count: 0,
            countQuality: 'permission_limited',
            capability: 'not_available',
            notes: 'This sign-in was not given access to it.',
            findings: [
              {
                code: 'access.scope_missing',
                capability: 'not_available',
                severity: 'action',
                summary: `This sign-in cannot read ${(cat?.label ?? category).toLowerCase()}.`,
                whatImports: 'Nothing from this category.',
                whatChanges:
                  'The count is unknown, not zero: we were not allowed to look, so we will not pretend there is nothing there.',
                recommendedAction: 'Sign in again and allow the extra access, then scan once more.',
                detail: { missingScopes: support.missingScopes },
              },
            ],
          } satisfies InventoryResult;
          continue;
        }
        const type = CATEGORY_TYPE[category]!;
        const count = (RECORDS[scope.externalScopeId] ?? []).filter(
          (r) => r.objectType === type,
        ).length;
        yield {
          category,
          count,
          countQuality: 'complete',
          capability: support.capability,
        } satisfies InventoryResult;
      }
      for (const [category, count] of Object.entries(COUNTS_ONLY)) {
        const cat = migrationCategory(category);
        // The stand-in's Dallas is smaller, so the two sub-accounts never look identical.
        const scaled = scope.externalScopeId === DALLAS ? Math.floor(count * 0.6) : count;
        yield {
          category,
          count: scaled,
          countQuality: 'complete',
          capability: cat ? releaseCapability(cat.release) : 'not_in_release',
        } satisfies InventoryResult;
      }
    },

    async list(_connection, scope, category, options: ListOptions): Promise<SourcePage> {
      calls.push({ category, scope: scope.externalScopeId, cursor: options.cursor ?? null });
      const type = CATEGORY_TYPE[category];
      if (!type) return { records: [], cursor: null, done: true };
      if (supportOf(category).missingScopes.length > 0)
        return { records: [], cursor: null, done: true };
      // 'tasks' is two kinds of record over there and here: what is still to do, and what was written down.
      const wanted = category === 'tasks' ? ['task', 'note'] : [type];
      const all = (RECORDS[scope.externalScopeId] ?? []).filter((r) =>
        wanted.includes(r.objectType),
      );
      const from = Number((options.cursor as { offset?: number } | null)?.offset ?? 0);
      const size = Math.min(options.limit ?? FAKE_PAGE_SIZE, FAKE_PAGE_SIZE);
      const slice = all.slice(from, from + size);
      const records: SourceRecord[] = slice
        .filter((r) => !options.until || new Date(r.updatedAt) <= options.until)
        .filter((r) => !options.changedSince || new Date(r.updatedAt) > options.changedSince)
        .map((r) => ({
          objectType: r.objectType,
          objectId: r.objectId,
          // A message or a call belongs to a thread, and the importer finds the thread through this.
          parentObjectId:
            // A task or a note hangs off the customer; a message off its thread; a visit off its calendar.
            r.objectType === 'task' || r.objectType === 'note'
              ? ((r.payload['contactId'] as string | undefined) ?? null)
              : typeof r.payload['conversationId'] === 'string'
                ? (r.payload['conversationId'] as string)
                : typeof r.payload['calendarId'] === 'string'
                  ? (r.payload['calendarId'] as string)
                  : null,
          sourceCreatedAt: new Date(r.createdAt),
          sourceUpdatedAt: new Date(r.updatedAt),
          payload: r.payload,
        }));
      const next = from + size;
      const done = next >= all.length;
      return {
        records,
        cursor: done ? null : { offset: next },
        highWaterAt: slice.length
          ? new Date(Math.max(...slice.map((r) => new Date(r.updatedAt).getTime())))
          : null,
        done,
      };
    },

    async getById(_connection, scope, objectType, objectId) {
      const r = (RECORDS[scope.externalScopeId] ?? []).find(
        (x) => x.objectType === objectType && x.objectId === objectId,
      );
      return r
        ? {
            objectType: r.objectType,
            objectId: r.objectId,
            sourceCreatedAt: new Date(r.createdAt),
            sourceUpdatedAt: new Date(r.updatedAt),
            payload: r.payload,
          }
        : null;
    },

    normalize(record, context: MappingContext): readonly CanonicalEnvelope[] {
      const p = record.payload;
      const base = {
        canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
        source: {
          system: 'gohighlevel',
          adapterVersion: FAKE_ADAPTER_VERSION,
          installationId: context.installationId,
          locationId: context.locationId,
          objectType: record.objectType,
          objectId: record.objectId,
          parentObjectId: record.parentObjectId ?? null,
          sourceCreatedAt: record.sourceCreatedAt?.toISOString() ?? null,
          sourceUpdatedAt: record.sourceUpdatedAt?.toISOString() ?? null,
          sourceDeletedAt: null,
          retrievedAt: new Date().toISOString(),
          payloadChecksum: `fake-${record.objectId}`,
          payloadVersion: 1,
        },
        extensions: {},
        warnings: [] as CanonicalEnvelope['warnings'],
      };
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      switch (record.objectType) {
        case 'estimate': {
          const items = Array.isArray(p['estimateItems'])
            ? (p['estimateItems'] as Record<string, unknown>[])
            : [];
          const seen: Record<
            string,
            'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'void'
          > = {
            accepted: 'accepted',
            sent: 'sent',
            declined: 'declined',
          };
          return [
            {
              ...base,
              canonicalType: 'estimate',
              category: 'estimates',
              relationships: [
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId:
                    str((p['contactDetails'] as Record<string, unknown> | undefined)?.['id']) ?? '',
                  role: 'contact',
                  required: true,
                },
              ],
              data: {
                number: str(p['estimateNumber']),
                title: str(p['title']),
                notes: null,
                status: seen[str(p['status']) ?? ''] ?? 'sent',
                currency: 'USD',
                subtotalCents: Math.round(Number(p['subtotal'] ?? 0) * 100),
                discountCents: 0,
                taxCents: 0,
                totalCents: Math.round(Number(p['total'] ?? 0) * 100),
                issuedAt: str(p['issueDate']),
                expiresOn: null,
                answeredAt:
                  str(p['status']) === 'accepted' ? record.sourceUpdatedAt?.toISOString() : null,
                acceptedName: str(p['acceptedBy']),
                declinedReason: null,
                lines: items.map((it) => ({
                  name: str(it['name']) ?? 'Item',
                  description: null,
                  quantity: Number(it['qty'] ?? 1),
                  unitLabel: 'each',
                  unitPriceCents: Math.round(Number(it['amount'] ?? 0) * 100),
                  taxable: true,
                })),
              },
            },
          ];
        }
        case 'subscription':
          return [
            {
              ...base,
              canonicalType: 'subscription',
              category: 'subscriptions',
              relationships: [
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId:
                    str((p['contactDetails'] as Record<string, unknown> | undefined)?.['id']) ?? '',
                  role: 'contact',
                  required: true,
                },
              ],
              data: {
                planName: str(p['name']) ?? 'Plan',
                priceCents: Math.round(Number(p['amount'] ?? 0) * 100),
                interval: 'month',
                intervalCount: 1,
                status: str(p['status']) === 'cancelled' ? 'cancelled' : 'active',
                startedOn: str(p['startDate'])?.slice(0, 10) ?? null,
                currentPeriodStart: null,
                currentPeriodEnd: null,
                nextBillingOn: str(p['nextChargeDate'])?.slice(0, 10) ?? null,
                cancelledAt:
                  str(p['status']) === 'cancelled' ? record.sourceUpdatedAt?.toISOString() : null,
                externalId: record.objectId,
              },
            },
          ];
        case 'product': {
          const prices = Array.isArray(p['prices'])
            ? (p['prices'] as Record<string, unknown>[])
            : [];
          return [
            {
              ...base,
              canonicalType: 'product',
              category: 'products',
              relationships: [],
              data: {
                name: str(p['name']) ?? 'Product',
                description: str(p['description']),
                unitPriceCents: Math.round(Number(prices[0]?.['amount'] ?? 0) * 100),
                unitLabel: 'each',
                taxable: true,
                active: true,
              },
            },
          ];
        }
        case 'invoice': {
          const items = Array.isArray(p['invoiceItems'])
            ? (p['invoiceItems'] as Record<string, unknown>[])
            : [];
          const seen: Record<string, 'draft' | 'sent' | 'partly_paid' | 'paid' | 'void'> = {
            paid: 'paid',
            partially_paid: 'partly_paid',
            sent: 'sent',
            draft: 'draft',
            void: 'void',
          };
          const total = Math.round(Number(p['total'] ?? 0) * 100);
          return [
            {
              ...base,
              canonicalType: 'invoice',
              category: 'invoices',
              relationships: [
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId:
                    str((p['contactDetails'] as Record<string, unknown> | undefined)?.['id']) ?? '',
                  role: 'contact',
                  required: true,
                },
              ],
              data: {
                number: str(p['invoiceNumber']),
                title: str(p['title']),
                notes: null,
                status: seen[str(p['status']) ?? ''] ?? 'sent',
                currency: str(p['currency']) ?? 'USD',
                subtotalCents: Math.round(Number(p['subtotal'] ?? 0) * 100),
                discountCents: 0,
                taxCents: 0,
                totalCents: total,
                paidCents: Math.round(Number(p['amountPaid'] ?? 0) * 100),
                paidAt: record.sourceUpdatedAt?.toISOString() ?? null,
                issuedAt: str(p['issueDate']),
                dueOn: str(p['dueDate'])?.slice(0, 10) ?? null,
                terms: null,
                lines: items.map((it) => ({
                  name: str(it['name']) ?? 'Item',
                  description: null,
                  quantity: Number(it['qty'] ?? 1),
                  unitLabel: 'each',
                  unitPriceCents: Math.round(Number(it['amount'] ?? 0) * 100),
                  taxable: true,
                })),
              },
            },
          ];
        }
        case 'task':
          return [
            {
              ...base,
              canonicalType: 'task',
              category: 'tasks',
              relationships: [
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId: str(p['contactId']) ?? '',
                  role: 'contact',
                  required: true,
                },
                {
                  category: 'users',
                  objectType: 'user',
                  objectId: str(p['assignedTo']) ?? '',
                  role: 'owner',
                  required: false,
                },
              ],
              data: {
                title: str(p['title']) ?? 'Task',
                notes: str(p['body']),
                dueAt: str(p['dueDate']),
                doneAt: p['completed'] === true ? record.sourceUpdatedAt?.toISOString() : null,
              },
            },
          ];
        case 'note':
          return [
            {
              ...base,
              canonicalType: 'note',
              category: 'tasks',
              relationships: [
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId: str(p['contactId']) ?? '',
                  role: 'contact',
                  required: true,
                },
              ],
              data: {
                body: str(p['body']) ?? '(empty note)',
                occurredAt: record.sourceCreatedAt?.toISOString() ?? new Date(0).toISOString(),
              },
            },
          ];
        case 'template':
          return [
            {
              ...base,
              canonicalType: 'template',
              category: 'templates',
              relationships: [],
              data: {
                name: str(p['name']) ?? 'Template',
                channel: 'email',
                subject: str(p['subject']),
                body: str(p['html']) ?? '',
                folder: null,
              },
            },
          ];
        case 'form':
          return [
            {
              ...base,
              canonicalType: 'form',
              category: 'forms',
              relationships: [],
              data: {
                name: str(p['name']) ?? 'Form',
                mode: str(p['mode']) === 'survey' ? 'survey' : 'form',
                intro: null,
                questions: Array.isArray(p['questions'])
                  ? (p['questions'] as Record<string, unknown>[]).map((q) => ({
                      key: str(q['key']) ?? '',
                      title: str(q['title']) ?? str(q['key']) ?? 'Question',
                      type: str(q['type']) ?? 'short_text',
                      required: q['required'] === true,
                      choices: [],
                    }))
                  : [],
                // This source does have an endpoint for its questions, so what it hands over is the lot.
                questionsAreComplete: Array.isArray(p['questions']) && p['questions'].length > 0,
              },
            },
          ];
        case 'form_submission': {
          const known = new Set(['id', 'formId', 'contactId', 'createdAt']);
          const contactId = str(p['contactId']);
          return [
            {
              ...base,
              canonicalType: 'form_response',
              category: 'form_submissions',
              relationships: [
                {
                  category: 'forms',
                  objectType: 'form',
                  objectId: str(p['formId']) ?? '',
                  role: 'form',
                  required: true,
                },
                ...(contactId
                  ? [
                      {
                        category: 'contacts',
                        objectType: 'contact',
                        objectId: contactId,
                        role: 'person' as const,
                        required: false,
                      },
                    ]
                  : []),
              ],
              data: {
                submittedAt: record.sourceCreatedAt?.toISOString() ?? new Date(0).toISOString(),
                source: 'link',
                answers: Object.entries(p)
                  .filter(
                    ([key, value]) => !known.has(key) && value !== null && value !== undefined,
                  )
                  .map(([key, value]) => ({ key, value: value as string })),
              },
            },
          ];
        }
        case 'calendar':
          return [
            {
              ...base,
              canonicalType: 'calendar',
              category: 'calendars',
              relationships: [],
              data: {
                name: str(p['name']) ?? 'Calendar',
                description: str(p['description']),
                timezone: str(p['timezone']),
                minutes: Number(p['slotDuration'] ?? 60) || 60,
                active: true,
              },
            },
          ];
        case 'appointment': {
          const seen: Record<string, 'scheduled' | 'completed' | 'cancelled' | 'no_show'> = {
            showed: 'completed',
            noshow: 'no_show',
            cancelled: 'cancelled',
            confirmed: 'scheduled',
          };
          return [
            {
              ...base,
              canonicalType: 'appointment',
              category: 'appointments',
              relationships: [
                {
                  category: 'calendars',
                  objectType: 'calendar',
                  objectId: str(p['calendarId']) ?? '',
                  role: 'calendar',
                  required: true,
                },
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId: str(p['contactId']) ?? '',
                  role: 'contact',
                  required: false,
                },
                {
                  category: 'users',
                  objectType: 'user',
                  objectId: str(p['assignedUserId']) ?? '',
                  role: 'owner',
                  required: false,
                },
              ],
              data: {
                title: str(p['title']) ?? 'Visit',
                startsAt: str(p['startTime'])!,
                endsAt: str(p['endTime'])!,
                status: seen[str(p['appointmentStatus']) ?? ''] ?? 'scheduled',
                notes: str(p['notes']),
                where: str(p['address']),
              },
            },
          ];
        }
        case 'pipeline': {
          const stages = Array.isArray(p['stages'])
            ? (p['stages'] as Record<string, unknown>[])
            : [];
          const kindOf = (n: string) =>
            /won|sold/i.test(n) ? 'won' : /lost|dead/i.test(n) ? 'lost' : 'open';
          return [
            {
              ...base,
              canonicalType: 'pipeline',
              category: 'pipelines',
              relationships: [],
              data: {
                name: str(p['name']) ?? 'Pipeline',
                position: 0,
                stages: stages.map((st, i) => ({
                  name: str(st['name']) ?? `Stage ${i + 1}`,
                  kind: kindOf(str(st['name']) ?? ''),
                  position: i,
                  sourceId: str(st['id']),
                })),
              },
            },
          ];
        }
        case 'opportunity': {
          const status = str(p['status']) ?? 'open';
          return [
            {
              ...base,
              canonicalType: 'lead',
              category: 'opportunities',
              relationships: [
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId: str(p['contactId']) ?? '',
                  role: 'contact',
                  required: true,
                },
                {
                  category: 'pipelines',
                  objectType: 'pipeline',
                  objectId: str(p['pipelineId']) ?? '',
                  role: 'pipeline',
                  required: true,
                },
                {
                  category: 'users',
                  objectType: 'user',
                  objectId: str(p['assignedTo']) ?? '',
                  role: 'owner',
                  required: false,
                },
              ],
              data: {
                title: str(p['name']) ?? 'Lead',
                valueCents: Math.round(Number(p['monetaryValue'] ?? 0) * 100),
                status,
                source: str(p['source']),
                sourceStageId: str(p['pipelineStageId']),
                expectedCloseOn: null,
                stageEnteredAt: record.sourceCreatedAt?.toISOString() ?? null,
                closedAt:
                  str(p['lastStatusChangeAt']) ?? record.sourceUpdatedAt?.toISOString() ?? null,
                lostReason: str(p['lostReasonName']),
              },
            },
          ];
        }
        case 'conversation': {
          const type = str(p['type']) ?? '';
          const channel = type.includes('EMAIL') ? 'email' : type.includes('SMS') ? 'sms' : 'chat';
          const name = type.includes('WHATSAPP') ? 'whatsapp' : null;
          return [
            {
              ...base,
              canonicalType: 'conversation',
              category: 'conversations',
              relationships: [
                {
                  category: 'contacts',
                  objectType: 'contact',
                  objectId: str(p['contactId']) ?? '',
                  role: 'contact',
                  required: true,
                },
              ],
              data: {
                channel,
                channelName: name,
                counterpart:
                  channel === 'email'
                    ? (str(p['email']) ?? 'unknown@example.com')
                    : (str(p['phone']) ?? str(p['contactName']) ?? 'unknown'),
                subject: null,
                status: 'closed',
                startedAt: record.sourceCreatedAt?.toISOString() ?? null,
                lastMessageAt: str(p['lastMessageDate']),
              },
            },
          ];
        }
        case 'message': {
          const type = str(p['messageType']) ?? '';
          const channel = type.includes('EMAIL') ? 'email' : type.includes('SMS') ? 'sms' : 'chat';
          const direction = str(p['direction']) === 'inbound' ? 'inbound' : 'outbound';
          return [
            {
              ...base,
              canonicalType: 'message',
              category: 'messages',
              relationships: [
                {
                  category: 'conversations',
                  objectType: 'conversation',
                  objectId: record.parentObjectId ?? '',
                  role: 'conversation',
                  required: true,
                },
              ],
              data: {
                channel,
                direction,
                status: direction === 'inbound' ? 'received' : 'delivered',
                subject: str(p['subject']),
                body: str(p['body']),
                bodyHtml: null,
                fromAddress: str(p['from']),
                toAddresses: [str(p['to'])].filter((v): v is string => !!v),
                occurredAt: record.sourceCreatedAt?.toISOString() ?? new Date(0).toISOString(),
                media: (Array.isArray(p['attachments']) ? (p['attachments'] as string[]) : []).map(
                  (url) => ({ url, name: null, mime: null, sizeBytes: null }),
                ),
                providerMessageId: record.objectId,
              },
            },
          ];
        }
        case 'call': {
          const meta = (p['meta'] ?? {}) as {
            call?: { status?: string; duration?: number };
            transcript?: string;
          };
          const duration = meta.call?.duration ?? null;
          const startedAt = record.sourceCreatedAt?.toISOString() ?? new Date(0).toISOString();
          const attachments = Array.isArray(p['attachments']) ? (p['attachments'] as string[]) : [];
          return [
            {
              ...base,
              canonicalType: 'call',
              category: 'calls',
              relationships: [
                {
                  category: 'conversations',
                  objectType: 'conversation',
                  objectId: record.parentObjectId ?? '',
                  role: 'conversation',
                  required: true,
                },
              ],
              data: {
                direction: str(p['direction']) === 'inbound' ? 'inbound' : 'outbound',
                status:
                  meta.call?.status === 'voicemail'
                    ? 'completed'
                    : (meta.call?.status ?? 'completed'),
                fromNumber: str(p['from']),
                toNumber: str(p['to']),
                startedAt,
                endedAt: duration
                  ? new Date(new Date(startedAt).getTime() + duration * 1000).toISOString()
                  : null,
                durationSeconds: duration,
                isVoicemail: (str(p['messageType']) ?? '').includes('VOICEMAIL'),
                recordingUrl: attachments[0] ?? null,
                recordingSeconds: duration,
                transcript: meta.transcript ?? null,
                providerCallId: record.objectId,
              },
            },
          ];
        }
        case 'user':
          return [
            {
              ...base,
              canonicalType: 'user_identity',
              category: 'users',
              relationships: [],
              data: {
                firstName: str(p['firstName']),
                lastName: str(p['lastName']),
                email: str(p['email']),
                roleName: (p['roles'] as { role?: string } | undefined)?.role ?? null,
                active: true,
              },
            },
          ];
        case 'tag':
          return [
            {
              ...base,
              canonicalType: 'tag',
              category: 'tags',
              relationships: [],
              data: { name: str(p['name']) ?? 'Unnamed tag', color: null },
            },
          ];
        case 'custom_field': {
          const raw = str(p['dataType']) ?? '';
          const known: Record<string, string> = { TEXT: 'text', DATE: 'date', NUMERICAL: 'number' };
          const type = known[raw];
          return [
            {
              ...base,
              canonicalType: 'custom_field',
              category: 'custom_fields',
              relationships: [],
              data: {
                name: str(p['name']) ?? 'Unnamed field',
                key: str(p['fieldKey']) ?? record.objectId,
                type: type ?? 'text',
                options: [],
                required: false,
                position: Number(p['position'] ?? 0) || 0,
                appliesTo: 'contact',
              },
              extensions: type ? {} : { gohighlevel: { dataType: raw } },
              warnings: type
                ? []
                : [
                    {
                      code: 'mapping.unknown_field_type',
                      field: 'dataType',
                      message: `"${raw}" is a field type we have no match for, so it comes across as plain text and the original is kept.`,
                    },
                  ],
            },
          ];
        }
        case 'contact': {
          const relationships: CanonicalEnvelope['relationships'] = [];
          const owner = str(p['assignedTo']);
          if (owner)
            relationships.push({
              category: 'users',
              objectType: 'user',
              objectId: owner,
              role: 'owner',
              required: false,
            });
          const dnd = p['dnd'] === true;
          return [
            {
              ...base,
              canonicalType: 'contact',
              category: 'contacts',
              relationships,
              data: {
                firstName: str(p['firstName']),
                lastName: str(p['lastName']),
                fullName: str(p['contactName']),
                email: str(p['email']),
                phone: str(p['phone']),
                endpoints: [],
                address: {
                  line1: str(p['address1']),
                  city: str(p['city']),
                  state: str(p['state']),
                  postalCode: str(p['postalCode']),
                  country: str(p['country'])?.slice(0, 2) ?? null,
                },
                timezone: null,
                source: str(p['source']),
                tags: (Array.isArray(p['tags']) ? p['tags'] : []).map(String),
                customFields: Object.fromEntries(
                  (Array.isArray(p['customFields'])
                    ? (p['customFields'] as { id?: string; value?: unknown }[])
                    : []
                  )
                    .filter((f) => f.id)
                    .map((f) => [context.customFields.get(f.id!)?.key ?? f.id!, f.value]),
                ),
                consent: [
                  { channel: 'sms', state: dnd ? 'opted_out' : 'unknown' },
                  { channel: 'email', state: dnd ? 'opted_out' : 'unknown' },
                ],
              },
            },
          ];
        }
        default:
          return [];
      }
    },
  };

  return {
    adapter,
    calls,
    denyScope: (s) => denied.add(s),
    reset: () => {
      calls.length = 0;
      denied.clear();
      denied.add('companies.readonly');
    },
  };
}
