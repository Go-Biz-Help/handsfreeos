import type { OutboxRow, SqlRunner } from './outbox';
import { parseIds, refusalOf } from './rules';

/**
 * Words for the changes on the phone, as Changes on this phone, the Sign out? sheet and "Held until …" say them:
 * "Text to Maria Lopez", "New customer · Rosa Delgado", "3 changes for Maria Lopez · number and email · a note · moved
 * to Won". Names come from the phone's copy, and from the outbox itself for customers not saved yet.
 */

export type ChangeIcon =
  | 'text'
  | 'email'
  | 'note'
  | 'newPerson'
  | 'person'
  | 'lead'
  | 'photo'
  | 'task'
  | 'tag'
  | 'calendar'
  | 'money'
  | 'inbox'
  | 'item'
  | 'change';

export interface ChangeWords {
  /** "Text to Maria Lopez". */
  readonly title: string;
  /** For a line of several changes to one customer: "a note", "number and email", "moved to Won". */
  readonly part: string;
  /** What was written: a text's or a note's words. */
  readonly quote: string | null;
  readonly icon: ChangeIcon;
  /** The customer it's about, for "3 changes for Maria Lopez". */
  readonly about: { readonly key: string; readonly name: string } | null;
  /** How "Held until … then it goes" names it: "Rosa Delgado is saved", "the photo is uploaded". */
  readonly heldUntil: string;
}

export interface NameBook {
  person(id: string | null | undefined): { name: string; first: string } | null;
  company(id: string | null | undefined): string | null;
  lead(id: string | null | undefined): { title: string; personId: string | null } | null;
  stage(id: string | null | undefined): string | null;
  conversationPerson(id: string | null | undefined): string | null;
  tag(id: string | null | undefined): string | null;
  task(id: string | null | undefined): { title: string; personId: string | null } | null;
}

type Input = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function parse(input: string): Input {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === 'object' ? (value as Input) : {};
  } catch {
    return {};
  }
}

const fullName = (first: unknown, last: unknown) =>
  [str(first), str(last)].filter(Boolean).join(' ') || null;

/** "Number and email", from the details a customer edit changed. */
const DETAIL_WORDS: Record<string, string> = {
  firstName: 'name',
  lastName: 'name',
  name: 'name',
  email: 'email',
  phone: 'number',
  phoneAlt: 'other number',
  address: 'address',
  notes: 'notes',
  source: 'source',
  companyId: 'company',
  ownerUserId: 'owner',
  website: 'website',
  title: 'title',
  valueCents: 'value',
  assigneeUserId: 'assignee',
  expectedCloseOn: 'close date',
  nextAction: 'next step',
  nextActionAt: 'next step',
  dueAt: 'due date',
  personId: 'customer',
};

function listWords(words: readonly string[]): string {
  const unique = [...new Set(words)];
  if (unique.length <= 1) return unique[0] ?? 'details';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** The details an edit changes: everything it sends but the business, the record it edits and what was seen. */
function editedDetails(input: Input, record: string): string {
  const keys = Object.keys(input).filter(
    (k) => k !== 'workspaceId' && k !== record && k !== 'base',
  );
  return listWords(keys.map((k) => DETAIL_WORDS[k] ?? 'details'));
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** "Text to Maria" → "text to Maria"; "AC tune-up" stays as it is. */
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

function quoteOf(text: unknown): string | null {
  const s = str(text);
  return s ? s.replace(/\s+/g, ' ') : null;
}

/** The words for one change. */
export function describe(
  row: Pick<OutboxRow, 'name' | 'input' | 'track'>,
  names: NameBook,
): ChangeWords {
  const input = parse(row.input);
  const personOf = (id: unknown) => {
    const found = names.person(str(id));
    return found ? { key: `person:${String(id)}`, name: found.name, first: found.first } : null;
  };
  const about = (person: ReturnType<typeof personOf>) =>
    person ? { key: person.key, name: person.name } : null;
  const forName = (person: ReturnType<typeof personOf>, fallback: string) =>
    person ? person.name : fallback;
  const words = (
    title: string,
    part: string,
    icon: ChangeIcon,
    person: ReturnType<typeof personOf>,
    quote: string | null = null,
    heldUntil = `${lower(title)} goes through`,
  ): ChangeWords => ({ title, part, quote, icon, about: about(person), heldUntil });

  if (row.track === 'photo') {
    const person =
      input.recordType === 'person'
        ? personOf(input.recordId)
        : input.recordType === 'lead'
          ? personOf(names.lead(str(input.recordId))?.personId)
          : null;
    const company = input.recordType === 'company' ? names.company(str(input.recordId)) : null;
    return words(
      `Photo for ${person?.name ?? company ?? 'a customer'}`,
      'a photo',
      'photo',
      person,
      null,
      'the photo is uploaded',
    );
  }

  const leadPerson = (leadId: unknown) => personOf(names.lead(str(leadId))?.personId);
  switch (row.name) {
    case 'activity.log': {
      const person = personOf(input.personId) ?? leadPerson(input.leadId);
      const kind = str(input.kind) ?? 'note';
      const noun = kind === 'note' ? 'note' : kind === 'call' ? 'call' : kind;
      const company = names.company(str(input.companyId));
      return words(
        `${capital(noun)} for ${forName(person, company ?? 'a customer')}`,
        `a ${noun}`,
        'note',
        person,
        quoteOf(input.body),
      );
    }
    case 'person.create': {
      const name = fullName(input.firstName, input.lastName) ?? 'a customer';
      return {
        title: `New customer · ${name}`,
        part: 'added as a new customer',
        quote: null,
        icon: 'newPerson',
        about: str(input.id) ? { key: `person:${String(input.id)}`, name } : null,
        heldUntil: `${name} is saved`,
      };
    }
    case 'person.update': {
      const person = personOf(input.personId);
      const details = editedDetails(input, 'personId');
      return words(
        `${capital(details)} for ${forName(person, 'a customer')}`,
        details,
        'person',
        person,
      );
    }
    case 'person.archive':
    case 'person.restore': {
      const person = personOf(input.personId);
      const verb = row.name === 'person.archive' ? 'archived' : 'restored';
      return words(`${capital(verb)} ${forName(person, 'a customer')}`, verb, 'person', person);
    }
    case 'company.create': {
      const name = str(input.name) ?? 'a company';
      return {
        title: `New company · ${name}`,
        part: 'added as a new company',
        quote: null,
        icon: 'newPerson',
        about: null,
        heldUntil: `${name} is saved`,
      };
    }
    case 'company.update':
    case 'company.archive':
    case 'company.restore': {
      const name = names.company(str(input.companyId)) ?? 'a company';
      const title =
        row.name === 'company.update'
          ? `${capital(editedDetails(input, 'companyId'))} for ${name}`
          : `${row.name === 'company.archive' ? 'Archived' : 'Restored'} ${name}`;
      return words(title, lower(title), 'person', null);
    }
    case 'lead.create': {
      const person = personOf(input.personId);
      const title = str(input.title) ?? 'New';
      const lead = `${title} lead for ${person?.first ?? names.company(str(input.companyId)) ?? 'a customer'}`;
      return words(lead, 'a lead', 'lead', person, null, `the ${lower(lead)} is saved`);
    }
    case 'lead.move_stage': {
      const lead = names.lead(str(input.leadId));
      const stage = names.stage(str(input.stageId)) ?? 'another stage';
      return words(
        `${lead?.title ?? 'A lead'} moved to ${stage}`,
        `moved to ${stage}`,
        'lead',
        leadPerson(input.leadId),
      );
    }
    case 'lead.update':
    case 'lead.set_next_action':
    case 'lead.record_answers':
    case 'lead.archive':
    case 'lead.restore': {
      const lead = names.lead(str(input.leadId));
      const what =
        row.name === 'lead.update'
          ? editedDetails(input, 'leadId')
          : row.name === 'lead.set_next_action'
            ? 'next step'
            : row.name === 'lead.record_answers'
              ? 'answers'
              : row.name === 'lead.archive'
                ? 'archived'
                : 'restored';
      return words(
        `${capital(what)} for ${lead?.title ?? 'a lead'}`,
        what,
        'lead',
        leadPerson(input.leadId),
      );
    }
    case 'message.send': {
      const person =
        personOf(input.personId) ?? personOf(names.conversationPerson(str(input.conversationId)));
      const email = input.channel === 'email';
      const to = forName(person, str(input.toPhone) ?? str(input.toEmail) ?? 'a customer');
      return words(
        `${email ? 'Email' : 'Text'} to ${to}`,
        email ? 'an email' : 'a text',
        email ? 'email' : 'text',
        person,
        quoteOf(input.body),
      );
    }
    case 'message.cancel_scheduled':
      return words('Cancel a scheduled text', 'a scheduled text cancelled', 'text', null);
    case 'task.create':
    case 'task.update':
    case 'task.complete':
    case 'task.reopen':
    case 'task.delete': {
      const task = names.task(str(input.taskId));
      const title = str(input.title) ?? task?.title ?? 'a task';
      const person = personOf(input.personId ?? task?.personId) ?? leadPerson(input.leadId);
      const verb = {
        'task.create': 'New task',
        'task.update': 'Changes to task',
        'task.complete': 'Done',
        'task.reopen': 'Reopened',
        'task.delete': 'Deleted task',
      }[row.name];
      return words(
        `${verb} · ${title}`,
        `${lower(verb)} ${title}`,
        'task',
        person,
        null,
        row.name === 'task.create' ? `the task “${title}” is saved` : undefined,
      );
    }
    case 'record.add_tag':
    case 'record.remove_tag': {
      const tag = names.tag(str(input.tagId)) ?? 'a tag';
      const person =
        input.recordType === 'person'
          ? personOf(input.recordId)
          : input.recordType === 'lead'
            ? leadPerson(input.recordId)
            : null;
      const added = row.name === 'record.add_tag';
      return words(
        `${added ? 'Tagged' : 'Untagged'} ${tag}`,
        `${added ? 'tagged' : 'untagged'} ${tag}`,
        'tag',
        person,
      );
    }
    case 'appointment.create':
    case 'appointment.reschedule':
    case 'appointment.cancel':
    case 'appointment.update':
    case 'appointment.set_status':
    case 'attendee.confirm': {
      const title = {
        'appointment.create': 'New appointment',
        'appointment.reschedule': 'Appointment moved',
        'appointment.cancel': 'Appointment cancelled',
        'appointment.update': 'Appointment details',
        'appointment.set_status': 'Appointment status',
        'attendee.confirm': 'Appointment confirmed',
      }[row.name];
      return words(title, lower(title), 'calendar', personOf(input.personId));
    }
    case 'invoice.record_cash_payment':
      return words('Cash payment recorded', 'a cash payment', 'money', null);
    case 'invoice.send':
      return words('Invoice sent', 'an invoice sent', 'money', null);
    case 'estimate.send':
      return words('Estimate sent', 'an estimate sent', 'money', null);
    case 'subscription.request_card':
      return words('Card requested', 'a card request', 'money', null);
    case 'ai_teammate.decide_draft':
      return words('Your answer to a draft', 'a draft answered', 'item', null);
    case 'workflow.decide_approval':
      return words('Your answer to an approval', 'an approval answered', 'item', null);
    case 'attention.let_handle':
      return words('Let HandsFreeOS handle', 'handed to HandsFreeOS', 'item', null);
    default:
      if (row.name.startsWith('attention.'))
        return words('A change on Home', 'a change on Home', 'item', null);
      if (row.name.startsWith('conversation.'))
        return words(
          'A change to a conversation',
          'a conversation changed',
          'inbox',
          personOf(names.conversationPerson(str(input.conversationId))),
        );
      return words('A change', 'a change', 'change', null);
  }
}

/** "Held until Rosa Delgado is saved, then it goes." */
export function heldWords(blockers: readonly { readonly words: ChangeWords | null }[]): string {
  if (blockers.length === 0) return 'Waiting its turn, then it goes.';
  if (blockers.some((b) => b.words === null))
    return 'It waited for a change that was discarded, so it can’t go.';
  if (blockers.length === 1) return `Held until ${blockers[0]!.words!.heldUntil}, then it goes.`;
  return `Held until the ${blockers.length} changes it waits for go through, then it goes.`;
}

/** The field names in a refusal's details, as the forms say them. */
const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Mobile',
  phoneAlt: 'Other phone',
  title: 'Title',
  body: 'Message',
  name: 'Name',
  'address.line1': 'Address',
  'address.city': 'City',
  'address.state': 'State',
  'address.postalCode': 'ZIP code',
};

export interface FieldProblem {
  readonly path: string;
  readonly label: string;
  readonly message: string;
}

/** The fields a refusal names, with the API's words for each. */
export function fieldProblems(answer: unknown): FieldProblem[] {
  const details = refusalOf(answer)?.details;
  if (!Array.isArray(details)) return [];
  return details
    .filter(
      (d): d is { path: string; message: string } =>
        !!d && typeof d === 'object' && typeof d.path === 'string' && typeof d.message === 'string',
    )
    .map((d) => ({
      path: d.path,
      label: FIELD_LABELS[d.path] ?? capital(d.path.replace(/([A-Z])/g, ' $1').toLowerCase()),
      message: d.message,
    }));
}

/**
 * The API's words for a refusal: its message, or for fields that need attention, each field and what's wrong with it
 * ("Email: Enter a valid email address.").
 */
export function refusalWords(answer: unknown, fallback: string | null): string {
  const error = refusalOf(answer);
  const problems = fieldProblems(answer);
  if (problems.length > 0) return problems.map((p) => `${p.label}: ${p.message}`).join(' ');
  return error?.message ?? fallback ?? 'HandsFreeOS couldn’t do this.';
}

// ----------------------------------------------------------------------------------------------------- names

interface PersonName {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

/** Looks up the names the changes mention, from the phone's copy and the outbox itself. */
export async function loadNames(runner: SqlRunner, rows: readonly OutboxRow[]): Promise<NameBook> {
  const ids = { person: new Set<string>(), lead: new Set<string>(), stage: new Set<string>() };
  const other = {
    company: new Set<string>(),
    conversation: new Set<string>(),
    tag: new Set<string>(),
    task: new Set<string>(),
  };
  const people = new Map<string, { name: string; first: string }>();
  for (const row of rows) {
    const input = parse(row.input);
    for (const key of ['personId', 'recordId'] as const) {
      const id = str(input[key]);
      if (id) ids.person.add(id);
    }
    for (const key of ['leadId', 'recordId'] as const) {
      const id = str(input[key]);
      if (id) ids.lead.add(id);
    }
    const stage = str(input.stageId);
    if (stage) ids.stage.add(stage);
    const company =
      str(input.companyId) ?? (input.recordType === 'company' ? str(input.recordId) : null);
    if (company) other.company.add(company);
    const conversation = str(input.conversationId);
    if (conversation) other.conversation.add(conversation);
    const tag = str(input.tagId);
    if (tag) other.tag.add(tag);
    const task = str(input.taskId);
    if (task) other.task.add(task);
    // A customer made on the phone is named from what was entered, even once the server refused it.
    if (row.name === 'person.create' && str(input.id)) {
      const name = fullName(input.firstName, input.lastName);
      if (name) people.set(String(input.id), { name, first: str(input.firstName) ?? name });
    }
  }
  // Customers made on the phone that haven't reached HandsFreeOS: a lead or photo for one is named after them.
  const unsaved = await runner.getAll<{ input: string }>(
    `SELECT input FROM outbox WHERE name = 'person.create' AND state != 'sent'`,
  );
  for (const row of unsaved) {
    const input = parse(row.input);
    const name = fullName(input.firstName, input.lastName);
    if (str(input.id) && name && !people.has(String(input.id)))
      people.set(String(input.id), { name, first: str(input.firstName) ?? name });
  }
  const select = async <T>(sql: string, set: Set<string>): Promise<T[]> =>
    set.size === 0
      ? []
      : runner.getAll<T>(sql.replace('(?)', `(${[...set].map(() => '?').join(', ')})`), [...set]);

  const leads = await select<{ id: string; title: string | null; person_id: string | null }>(
    'SELECT id, title, person_id FROM leads WHERE id IN (?)',
    ids.lead,
  );
  const tasks = await select<{ id: string; title: string | null; person_id: string | null }>(
    'SELECT id, title, person_id FROM tasks WHERE id IN (?)',
    other.task,
  );
  const conversations = await select<{ id: string; person_id: string | null }>(
    'SELECT id, person_id FROM conversations WHERE id IN (?)',
    other.conversation,
  );
  for (const r of [...leads, ...tasks, ...conversations])
    if (r.person_id) ids.person.add(r.person_id);
  const found = await select<PersonName>(
    'SELECT id, first_name, last_name FROM people WHERE id IN (?)',
    ids.person,
  );
  for (const p of found) {
    const name = fullName(p.first_name, p.last_name);
    if (name) people.set(p.id, { name, first: str(p.first_name) ?? name });
  }
  const stages = await select<{ id: string; name: string }>(
    'SELECT id, name FROM pipeline_stages WHERE id IN (?)',
    ids.stage,
  );
  const companies = await select<{ id: string; name: string }>(
    'SELECT id, name FROM companies WHERE id IN (?)',
    other.company,
  );
  const tags = await select<{ id: string; name: string }>(
    'SELECT id, name FROM tags WHERE id IN (?)',
    other.tag,
  );
  return bookOf({ people, leads, stages, companies, conversations, tags, tasks });
}

export function bookOf(found: {
  people?: Map<string, { name: string; first: string }>;
  leads?: readonly { id: string; title: string | null; person_id: string | null }[];
  stages?: readonly { id: string; name: string }[];
  companies?: readonly { id: string; name: string }[];
  conversations?: readonly { id: string; person_id: string | null }[];
  tags?: readonly { id: string; name: string }[];
  tasks?: readonly { id: string; title: string | null; person_id: string | null }[];
}): NameBook {
  const byId = <T extends { id: string }>(list: readonly T[] | undefined) =>
    new Map((list ?? []).map((r) => [r.id, r]));
  const leads = byId(found.leads);
  const stages = byId(found.stages);
  const companies = byId(found.companies);
  const conversations = byId(found.conversations);
  const tags = byId(found.tags);
  const tasks = byId(found.tasks);
  return {
    person: (id) => (id ? (found.people?.get(id) ?? null) : null),
    company: (id) => (id ? (companies.get(id)?.name ?? null) : null),
    lead: (id) => {
      const lead = id ? leads.get(id) : undefined;
      return lead ? { title: lead.title ?? 'A lead', personId: lead.person_id } : null;
    },
    stage: (id) => (id ? (stages.get(id)?.name ?? null) : null),
    conversationPerson: (id) => (id ? (conversations.get(id)?.person_id ?? null) : null),
    tag: (id) => (id ? (tags.get(id)?.name ?? null) : null),
    task: (id) => {
      const task = id ? tasks.get(id) : undefined;
      return task ? { title: task.title ?? 'A task', personId: task.person_id } : null;
    },
  };
}

/** The ids a change waits for. */
export const dependsOnOf = (row: Pick<OutboxRow, 'depends_on'>) => parseIds(row.depends_on);
