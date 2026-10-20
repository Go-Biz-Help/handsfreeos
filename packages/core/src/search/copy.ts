/**
 * The phone's own search, with no signal (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Phone: no signal", decisions 10
 * and 11): what the phone keeps, searched on the phone, answered in the server's shape (`source: 'phone'`) so one row
 * draws both. The phone reads a bounded set of rows a kind (`apps/mobile/src/search/copy-sql.ts`); this decides which
 * of them match, ranks them with the server's tiers, says why each matched (`search/explain.ts`, the server's own),
 * and groups them as `search.everything` does. Browser-safe and pure: the rows, the person's permissions and the
 * business's time zone come in.
 *
 * - **What it searches:** contacts, companies and leads, tasks (open, or done in the last 90 days, as the phone keeps
 *   them), notes (`NOTE_LINES`, the last 12 months), the calendar (from 90 days back), live forms by name, and what an
 *   add-on finds in its own part of the copy (Real Estate's deals). Messages, money, files, form answers, knowledge
 *   and a business's own kinds wait for signal (`copyMissingKinds`).
 * - **Archived records aren't shown.** A customer in the Deleted bin reads as archived on a phone (docs/deleting.md),
 *   so none shows, nor lends its name to a lead, a task, a note or a visit.
 * - **Notes and tasks only on a customer, company or lead in the copy.** The server hides those on a turned-off
 *   add-on's records (gap 5), but a phone's tasks and timeline carry no record, so it can't tell: a row anchored to
 *   none of the three is left out, a property's unsealed note with it.
 * - **Accents:** names and titles fold as they do with signal, but SQLite can't fold: the phone's SQL reads a letter
 *   outside ASCII as any letter, so a name typed as it's stored is always read, while "jose" may miss "José".
 */
import { cellJson, cellMs, cellText } from '../addons/phone-rows';
import { localDayOf } from '../calendar/when';
import { formatPhone } from '../crm/phone';
import { companySearchText, personSearchText } from '../crm/search-text';
import type { SearchEverythingOutput, SearchGroup, SearchHit } from '../schemas/search';
import { closeMatches, closeWorthTrying } from './close';
import {
  explainAppointment,
  explainCompany,
  explainContact,
  explainLead,
  explainTask,
  fullNameOf,
} from './explain';
import { searchHref, type SearchRecordRef } from './href';
import { SEARCH_KINDS, type SearchKind } from './kinds';
import { countsAsContact, isNoteLine } from './lines';
import { probesOut, searchProbes, type SearchProbes } from './probes';
import { bestOf, orderGroups, rankHits, tierOf } from './rank';
import { digitsIn, fieldSnippet, hitOf, holdsAll, listedValues } from './hit';
import { snippetOf } from './snippet';
import { SEARCH_WORDS } from './words';

/** A column as the phone's SQLite gives it back: text, a number, or nothing. */
type Cell = string | number | null | undefined;

export interface CopyPerson {
  readonly id: string;
  readonly first_name: Cell;
  readonly last_name: Cell;
  readonly email: Cell;
  readonly phone: Cell;
  readonly phone_e164: Cell;
  readonly phone_alt: Cell;
  readonly address_line1: Cell;
  readonly address_line2: Cell;
  readonly city: Cell;
  readonly state: Cell;
  readonly postal_code: Cell;
  /** JSON text, as they sync. */
  readonly other_emails: Cell;
  readonly other_phones: Cell;
  readonly other_addresses: Cell;
  /** Their company's name, when it shows. */
  readonly company_name: Cell;
  readonly archived_at: Cell;
  readonly updated_at: Cell;
}

export interface CopyCompany {
  readonly id: string;
  readonly name: Cell;
  readonly email: Cell;
  readonly phone: Cell;
  readonly phone_e164: Cell;
  readonly website: Cell;
  readonly address_line1: Cell;
  readonly address_line2: Cell;
  readonly city: Cell;
  readonly state: Cell;
  readonly postal_code: Cell;
  readonly other_emails: Cell;
  readonly other_phones: Cell;
  readonly other_addresses: Cell;
  readonly archived_at: Cell;
  readonly updated_at: Cell;
}

export interface CopyLead {
  readonly id: string;
  readonly title: Cell;
  readonly status: Cell;
  readonly value_cents: Cell;
  readonly archived_at: Cell;
  readonly updated_at: Cell;
  readonly stage_name: Cell;
  readonly pipeline_name: Cell;
  /** Who it's for, when they show: the customer's first and last name, and the company's name. */
  readonly person_first: Cell;
  readonly person_last: Cell;
  readonly company_name: Cell;
  readonly owner_name: Cell;
}

/** What a task or a note hangs off, from the copy: a customer, company or lead that shows (not archived), or none. */
export interface CopyAnchor {
  readonly on_person_id: Cell;
  readonly on_person_first: Cell;
  readonly on_person_last: Cell;
  readonly on_company_id: Cell;
  readonly on_company_name: Cell;
  readonly on_lead_id: Cell;
  readonly on_lead_title: Cell;
}

export interface CopyTask extends CopyAnchor {
  readonly id: string;
  readonly title: Cell;
  readonly notes: Cell;
  readonly due_at: Cell;
  readonly done_at: Cell;
  readonly updated_at: Cell;
  readonly owner_name: Cell;
}

export interface CopyNote extends CopyAnchor {
  readonly id: string;
  readonly kind: Cell;
  readonly subtype: Cell;
  readonly body: Cell;
  readonly occurred_at: Cell;
}

export interface CopyAppointment {
  readonly id: string;
  readonly title: Cell;
  readonly status: Cell;
  readonly starts_at: Cell;
  readonly ends_at: Cell;
  /** The place, JSON text as it syncs. */
  readonly location: Cell;
  readonly notes: Cell;
  /** Who's coming, together: each one's name, phone and email (customers who show lend their name). */
  readonly attendees: Cell;
  /** Who's coming, by name: "Dana Smith, Jo Smithers". */
  readonly who: Cell;
}

export interface CopyForm {
  readonly id: string;
  readonly name: Cell;
  readonly updated_at: Cell;
}

/** A name close matches may offer: a contact's, a company's or a lead's that shows. */
export interface CopyCloseRow {
  readonly kind: 'contacts' | 'companies' | 'leads';
  readonly id: string;
  readonly name: Cell;
  readonly updated_at: Cell;
}

/** What an add-on found in its own part of the copy (a phone add-on's `search`): one group of its own kind. */
export interface CopyGroup {
  /** `<add-on id>.<kind>`: `realestate.deals`. */
  readonly kind: string;
  readonly label: string;
  readonly icon: string | null;
  readonly hits: readonly SearchHit[];
}

/** The details the rows read don't hold, read for those rows alone: a contact's last contact, a company's counts. */
export interface CopyFacts {
  /** A contact's newest real contact (decision 35), by their id. */
  readonly lastContact?: ReadonlyMap<
    string,
    { readonly kind: string; readonly subtype: string | null; readonly at: string }
  >;
  /** A company's people and open leads, by its id. */
  readonly companies?: ReadonlyMap<string, { readonly people: number; readonly openLeads: number }>;
}

/** The rows the phone read for a search: each kind's, add-ons' groups, the names for close matches, and facts. */
export interface CopyRows {
  readonly people?: readonly CopyPerson[];
  readonly companies?: readonly CopyCompany[];
  readonly leads?: readonly CopyLead[];
  readonly tasks?: readonly CopyTask[];
  readonly notes?: readonly CopyNote[];
  readonly appointments?: readonly CopyAppointment[];
  readonly forms?: readonly CopyForm[];
  readonly addons?: readonly CopyGroup[];
  readonly close?: readonly CopyCloseRow[];
  readonly facts?: CopyFacts;
}

export interface CopySearchOptions {
  readonly workspaceId: string;
  /** The person's permissions here: the same gates as on the server (`SEARCH_KINDS`). */
  readonly permissions: readonly string[];
  /** Where the business is: the day a visit opens on. */
  readonly timeZone: string;
  /** The chips picked; none is every kind. */
  readonly kinds?: readonly string[] | null;
  /** Hits kept a group: 3 in the box, more on one kind's own page. */
  readonly perKind?: number;
  /** A setting matched on the phone, so close matches aren't looked for. */
  readonly settingsMatched?: boolean;
}

/** Where an answer came from: HandsFreeOS, or the phone's own copy. */
export type SearchSource = 'server' | 'phone';

export type CopyAnswer = SearchEverythingOutput & { readonly source: 'phone' };

/** A count is cut here, as the server cuts it: "100+". */
const COUNT_ROWS = 101;

/** The kinds the phone searches in its own copy, in kind order. */
export const COPY_KINDS: readonly SearchKind[] = SEARCH_KINDS.filter(
  (k) => k.offline && k.where === 'server' && k.key !== 'close',
);

/** The phone's own kinds this person may search, and of those, the chips picked (none: all of them). */
export function copyKindsFor(
  permissions: readonly string[],
  picked?: readonly string[] | null,
): readonly SearchKind[] {
  return COPY_KINDS.filter(
    (k) => permissions.includes(k.needs) && (!picked?.length || picked.includes(k.key)),
  );
}

/**
 * The kinds that wait for signal, as chips that can't be picked: those this person may search with signal that the
 * phone doesn't keep (Money, Messages, Files, Knowledge). A business's own kinds have no one chip, and the Deleted bin
 * is never a chip, so they're left out.
 */
export function copyMissingKinds(permissions: readonly string[]): readonly SearchKind[] {
  return SEARCH_KINDS.filter(
    (k) =>
      k.chip &&
      !k.offline &&
      k.where === 'server' &&
      k.key !== 'records' &&
      k.key !== 'bin' &&
      permissions.includes(k.needs),
  );
}

const text = (v: Cell): string | null => cellText(v);
const isoOf = (v: Cell): string | null => {
  const t = cellMs(v);
  return t === null ? null : new Date(t).toISOString();
};
/** A synced JSON list, parsed; nothing when it isn't one. */
const listOf = (v: Cell): unknown[] => {
  const parsed = cellJson(v);
  return Array.isArray(parsed) ? parsed : [];
};
/** Whether every typed word, as typed and lower-cased, sits in these texts together (the server's LIKE). */
const wordsIn = (texts: readonly Cell[], p: SearchProbes): boolean => {
  const all = texts
    .map((t) => text(t) ?? '')
    .join(' ')
    .toLowerCase();
  return p.words.length > 0 && p.words.every((w) => all.includes(w));
};

// ---------- each kind ----------

function contactHit(r: CopyPerson, p: SearchProbes, o: CopySearchOptions, f?: CopyFacts) {
  if (text(r.archived_at)) return null;
  const otherPhones = listOf(r.other_phones);
  const otherEmails = listOf(r.other_emails);
  const phones = [text(r.phone_e164), ...listedValues(otherPhones, 'phone')];
  const emails = [text(r.email), ...listedValues(otherEmails, 'email')].map(
    (e) => e?.toLowerCase() ?? null,
  );
  const name = fullNameOf(text(r.first_name), text(r.last_name));
  const searchText = personSearchText({
    first_name: text(r.first_name),
    last_name: text(r.last_name),
    email: text(r.email),
    phone_e164: text(r.phone_e164),
    city: text(r.city),
    address_line1: text(r.address_line1),
    other_emails: text(r.other_emails),
    other_phones: text(r.other_phones),
    other_addresses: text(r.other_addresses),
  });
  const matched =
    (!!p.phoneE164 && phones.includes(p.phoneE164)) ||
    (!!p.email && emails.includes(p.email)) ||
    (!!p.domain && emails.some((e) => e?.endsWith(`@${p.domain}`))) ||
    tierOf(name, p) !== null ||
    wordsIn(
      [searchText, r.company_name, r.address_line2, r.state, r.postal_code, r.phone_alt],
      p,
    ) ||
    (!!p.digits &&
      (searchText.includes(p.digits) || digitsIn(text(r.phone_alt)).includes(p.digits)));
  if (!matched) return null;
  const phoneE164 = text(r.phone_e164);
  const email = text(r.email);
  const lastContact = f?.lastContact?.get(r.id);
  const where = [text(r.address_line1), text(r.city)].filter(Boolean).join(', ');
  return hitOf({
    kind: 'contacts',
    id: r.id,
    title: name || SEARCH_WORDS.noName,
    href: searchHref(o.workspaceId, { type: 'person', id: r.id }),
    ...explainContact(
      {
        first_name: text(r.first_name),
        last_name: text(r.last_name),
        email,
        phone_e164: phoneE164,
        phone_alt: text(r.phone_alt),
        other_phones: otherPhones,
        other_emails: otherEmails,
        other_addresses: listOf(r.other_addresses),
        address_line1: text(r.address_line1),
        address_line2: text(r.address_line2),
        city: text(r.city),
        state: text(r.state),
        postal_code: text(r.postal_code),
        company_name: text(r.company_name),
        custom_text: null,
      },
      p,
    ),
    at: lastContact?.at ?? isoOf(r.updated_at),
    contact: { personId: r.id, phoneE164, email },
    facts: {
      ...(phoneE164 || text(r.phone_alt)
        ? { phone: phoneE164 ? formatPhone(phoneE164) : text(r.phone_alt)! }
        : {}),
      ...(email ? { email } : {}),
      ...(where ? { where } : {}),
      ...(text(r.company_name) ? { company: text(r.company_name)! } : {}),
      ...(lastContact ? { lastContact } : {}),
    },
  });
}

function companyHit(r: CopyCompany, p: SearchProbes, o: CopySearchOptions, f?: CopyFacts) {
  if (text(r.archived_at)) return null;
  const name = text(r.name) ?? '';
  const otherPhones = listOf(r.other_phones);
  const otherEmails = listOf(r.other_emails);
  const phones = [text(r.phone_e164), ...listedValues(otherPhones, 'phone')];
  const emails = [text(r.email), ...listedValues(otherEmails, 'email')].map(
    (e) => e?.toLowerCase() ?? null,
  );
  const website = text(r.website);
  const searchText = companySearchText({
    name,
    email: text(r.email),
    phone_e164: text(r.phone_e164),
    city: text(r.city),
    address_line1: text(r.address_line1),
    other_emails: text(r.other_emails),
    other_phones: text(r.other_phones),
    other_addresses: text(r.other_addresses),
  });
  const matched =
    (!!p.phoneE164 && phones.includes(p.phoneE164)) ||
    (!!p.email && emails.includes(p.email)) ||
    (!!p.domain &&
      ((website ?? '').toLowerCase().includes(p.domain) ||
        emails.some((e) => e?.endsWith(`@${p.domain}`)))) ||
    tierOf(name, p) !== null ||
    wordsIn([searchText, website, r.address_line2, r.state, r.postal_code], p) ||
    (!!p.digits && (searchText.includes(p.digits) || digitsIn(text(r.phone)).includes(p.digits)));
  if (!matched) return null;
  const phoneE164 = text(r.phone_e164);
  const email = text(r.email);
  const counts = f?.companies?.get(r.id);
  const where = [text(r.address_line1), text(r.city)].filter(Boolean).join(', ');
  return hitOf({
    kind: 'companies',
    id: r.id,
    title: name,
    href: searchHref(o.workspaceId, { type: 'company', id: r.id }),
    ...explainCompany(
      {
        name,
        email,
        phone_e164: phoneE164,
        website,
        other_phones: otherPhones,
        other_emails: otherEmails,
        other_addresses: listOf(r.other_addresses),
        address_line1: text(r.address_line1),
        address_line2: text(r.address_line2),
        city: text(r.city),
        state: text(r.state),
        postal_code: text(r.postal_code),
        custom_text: null,
      },
      p,
    ),
    at: isoOf(r.updated_at),
    contact: phoneE164 || email ? { personId: null, phoneE164, email } : null,
    facts: {
      ...(phoneE164 ? { phone: formatPhone(phoneE164) } : {}),
      ...(email ? { email } : {}),
      ...(where ? { where } : {}),
      ...(counts ? { people: counts.people, openLeads: counts.openLeads } : {}),
    },
  });
}

function leadHit(r: CopyLead, p: SearchProbes, o: CopySearchOptions) {
  if (text(r.archived_at)) return null;
  const title = text(r.title) ?? '';
  const personName = fullNameOf(text(r.person_first), text(r.person_last)) || null;
  const company = text(r.company_name);
  if (tierOf(title, p) === null && !holdsAll([personName, company], p)) return null;
  const status = text(r.status) ?? 'open';
  const customer = personName || company;
  const owner = text(r.owner_name);
  return hitOf({
    kind: 'leads',
    id: r.id,
    title,
    href: searchHref(o.workspaceId, { type: 'lead', id: r.id }),
    ...explainLead({ title, person_name: personName, company_name: company }, p),
    badges: status === 'open' ? [] : [status],
    at: isoOf(r.updated_at),
    amount: { cents: Number(r.value_cents ?? 0), currency: 'USD' },
    facts: {
      ...(customer ? { customer } : {}),
      ...(text(r.pipeline_name) ? { pipeline: text(r.pipeline_name)! } : {}),
      ...(text(r.stage_name) ? { stage: text(r.stage_name)! } : {}),
      ...(owner ? { owner } : {}),
      status,
    },
  });
}

/** The record a task or a note opens on, and its name: the customer first, then the company, then the lead. */
function anchorOf(r: CopyAnchor): { ref: SearchRecordRef; name: string } | null {
  const person = text(r.on_person_id);
  if (person)
    return {
      ref: { type: 'person', id: person },
      name: fullNameOf(text(r.on_person_first), text(r.on_person_last)),
    };
  const company = text(r.on_company_id);
  if (company)
    return { ref: { type: 'company', id: company }, name: text(r.on_company_name) ?? '' };
  const lead = text(r.on_lead_id);
  if (lead) return { ref: { type: 'lead', id: lead }, name: text(r.on_lead_title) ?? '' };
  return null;
}

function taskHit(r: CopyTask, p: SearchProbes, o: CopySearchOptions) {
  const on = anchorOf(r);
  if (!on) return null;
  const title = text(r.title) ?? '';
  if (tierOf(title, p) === null && !wordsIn([r.notes], p)) return null;
  const due = isoOf(r.due_at);
  const done = isoOf(r.done_at);
  const owner = text(r.owner_name);
  return hitOf({
    kind: 'tasks',
    id: r.id,
    title,
    href: searchHref(o.workspaceId, { type: 'task', id: r.id }),
    ...explainTask({ title, notes: text(r.notes) }, p),
    badges: done ? ['done'] : [],
    at: isoOf(r.updated_at),
    facts: {
      ...(due ? { dueAt: due } : {}),
      ...(done ? { doneAt: done } : {}),
      ...(owner ? { owner } : {}),
      ...(on.name.trim() ? { on: on.name.trim() } : {}),
    },
  });
}

/** A note's title: its first line, cut to about this; found by who it's on, this much of it shows. */
const NOTE_TITLE = 80;
const NOTE_OPENING = 120;

/** The first `n` characters of a text, its spaces made one, with "…" when it was cut. */
function cut(value: string | null, n: number): string {
  const whole = (value ?? '').replace(/\s+/g, ' ').trim();
  return whole.length > n ? `${whole.slice(0, n).trimEnd()}…` : whole;
}

function noteHit(r: CopyNote, p: SearchProbes, o: CopySearchOptions) {
  if (!isNoteLine(text(r.kind), text(r.subtype))) return null;
  const on = anchorOf(r);
  if (!on) return null;
  const body = text(r.body);
  const inWords = wordsIn([body], p);
  // Decision 34: found by who it's on (each of the customer, the company and the lead together, as the server folds
  // them), after the notes whose own words matched.
  const onNames = [
    fullNameOf(text(r.on_person_first), text(r.on_person_last)),
    text(r.on_company_name),
    text(r.on_lead_title),
  ];
  if (!inWords && !holdsAll(onNames, p)) return null;
  const opening = cut(body, NOTE_OPENING);
  return hitOf({
    kind: 'notes',
    id: r.id,
    title: cut(body?.split('\n')[0] ?? null, NOTE_TITLE) || SEARCH_WORDS.untitledNote,
    href: searchHref(o.workspaceId, { type: 'activity', id: r.id, on: on.ref }),
    tier: 4,
    why: {
      field: inWords ? 'note' : 'customer',
      label: null,
      snippet: inWords
        ? snippetOf(body, p)
        : opening
          ? (fieldSnippet(opening, p) ?? { text: opening, marks: [] })
          : null,
      page: null,
    },
    at: isoOf(r.occurred_at),
    facts: on.name.trim() ? { on: on.name.trim() } : {},
  });
}

function appointmentHit(r: CopyAppointment, p: SearchProbes, o: CopySearchOptions) {
  const title = text(r.title) ?? '';
  const place = cellJson(r.location ?? null) as Record<string, unknown> | null;
  const address =
    [place?.address, place?.postalCode]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' ') || null;
  const attendees = text(r.attendees);
  const coming = (attendees ?? '').toLowerCase().split(/\s+/);
  const exactPhone = !!p.phoneE164 && coming.includes(p.phoneE164.toLowerCase());
  const exactEmail = !!p.email && coming.includes(p.email);
  const matched =
    exactPhone ||
    exactEmail ||
    tierOf(title, p) !== null ||
    wordsIn([title, address, r.notes, attendees], p) ||
    holdsAll([attendees], p);
  if (!matched) return null;
  const startsAt = isoOf(r.starts_at);
  const endsAt = isoOf(r.ends_at);
  if (!startsAt || !endsAt) return null;
  const status = text(r.status) ?? 'scheduled';
  const who = text(r.who);
  return hitOf({
    kind: 'calendar',
    id: r.id,
    title,
    href: searchHref(o.workspaceId, {
      type: 'appointment',
      id: r.id,
      day: localDayOf(startsAt, o.timeZone),
    }),
    ...explainAppointment(
      {
        title,
        address,
        notes: text(r.notes),
        attendees,
        who,
        exact_phone: exactPhone,
        exact_email: exactEmail,
      },
      p,
    ),
    badges: status === 'cancelled' ? ['cancelled'] : [],
    at: startsAt,
    facts: {
      startsAt,
      endsAt,
      status,
      ...(who ? { who } : {}),
      ...(address ? { where: address } : {}),
    },
  });
}

function formHit(r: CopyForm, p: SearchProbes, o: CopySearchOptions) {
  const name = text(r.name) ?? '';
  const tier = tierOf(name, p);
  if (tier === null) return null;
  return hitOf({
    kind: 'forms',
    id: r.id,
    title: name,
    href: searchHref(o.workspaceId, { type: 'form', id: r.id }),
    tier,
    why: { field: 'form_name', label: null, snippet: null, page: null },
    at: isoOf(r.updated_at),
  });
}

const REF: Record<CopyCloseRow['kind'], SearchRecordRef['type']> = {
  contacts: 'person',
  companies: 'company',
  leads: 'lead',
};

// ---------- the answer ----------

const groupOf = (
  kind: string,
  label: string | null,
  icon: string | null,
  ranked: readonly SearchHit[],
  perKind: number,
): SearchGroup => ({
  kind,
  label,
  icon,
  total: Math.min(ranked.length, COUNT_ROWS - 1),
  capped: ranked.length >= COUNT_ROWS,
  complete: true,
  searchedBack: null,
  unavailable: null,
  items: ranked.slice(0, perKind),
});

const empty = (p: SearchProbes): CopyAnswer => ({
  q: p.q,
  tooShort: p.tooShort,
  probes: probesOut(p),
  total: 0,
  capped: false,
  best: null,
  groups: [],
  archived: null,
  bin: null,
  close: false,
  noneActive: false,
  source: 'phone',
});

/**
 * The phone's answer for what was typed, from the rows it read: the server's groups, order and words for the kinds it
 * keeps, close matches when nothing matched (and the names were read), never Archived or the Deleted bin.
 */
export function searchCopy(q: string, rows: CopyRows, o: CopySearchOptions): CopyAnswer {
  const p = searchProbes(q);
  if (p.tooShort) return empty(p);
  const perKind = o.perKind ?? 3;
  const keys = new Set(copyKindsFor(o.permissions, o.kinds).map((k) => k.key));
  const found: SearchGroup[] = [];
  const add = <R>(
    key: string,
    list: readonly R[] | undefined,
    hit: (r: R) => SearchHit | null,
  ): void => {
    if (!keys.has(key)) return;
    const hits = (list ?? []).map(hit).filter((h): h is SearchHit => !!h);
    if (hits.length) found.push(groupOf(key, null, null, rankHits(hits), perKind));
  };
  add('contacts', rows.people, (r) => contactHit(r, p, o, rows.facts));
  add('companies', rows.companies, (r) => companyHit(r, p, o, rows.facts));
  add('leads', rows.leads, (r) => leadHit(r, p, o));
  add('calendar', rows.appointments, (r) => appointmentHit(r, p, o));
  add('tasks', rows.tasks, (r) => taskHit(r, p, o));
  add('notes', rows.notes, (r) => noteHit(r, p, o));
  add('forms', rows.forms, (r) => formHit(r, p, o));
  for (const g of rows.addons ?? []) {
    if (o.kinds?.length && !o.kinds.includes(g.kind)) continue;
    if (g.hits.length) found.push(groupOf(g.kind, g.label, g.icon, rankHits(g.hits), perKind));
  }

  // Close matches, only when nothing matched, no setting did, and a word is long enough (decision 26).
  let close: SearchGroup | null = null;
  if (
    found.length === 0 &&
    !o.settingsMatched &&
    o.permissions.includes('records.read') &&
    closeWorthTrying(p.folded) &&
    rows.close?.length
  ) {
    const asked = rows.close.filter((r) => !o.kinds?.length || o.kinds.includes(r.kind));
    const hits = closeMatches(asked, (r) => text(r.name) ?? '', p.folded).map((r) =>
      hitOf({
        kind: r.kind,
        id: r.id,
        title: text(r.name)?.trim() || SEARCH_WORDS.noName,
        href: searchHref(o.workspaceId, { type: REF[r.kind], id: r.id }),
        tier: 5,
        why: { field: 'close', label: null, snippet: null, page: null },
        at: isoOf(r.updated_at),
      }),
    );
    if (hits.length) close = groupOf('close', null, null, hits, perKind);
  }

  const groups = orderGroups(close ? [close] : found);
  const total = groups.reduce((n, g) => n + g.total, 0);
  return {
    ...empty(p),
    tooShort: false,
    total,
    capped: groups.some((g) => g.capped),
    best: close ? null : bestOf(groups),
    groups,
    close: !!close,
  };
}

/**
 * Whether the names for close matches are worth reading: nothing matched, no setting did, and a word is long enough.
 */
export function copyWantsClose(answer: SearchEverythingOutput, settingsMatched: boolean): boolean {
  return (
    !answer.tooShort &&
    !settingsMatched &&
    answer.total === 0 &&
    !answer.close &&
    closeWorthTrying(searchProbes(answer.q).folded)
  );
}

/**
 * Each contact's newest real contact (decision 35) from their timeline lines in the copy, newest first: a message, a
 * call, a note or a visit, or a booking (`countsAsContact`), never a bookkeeping line.
 */
export function lastContactsOf(
  lines: readonly { person_id: Cell; kind: Cell; subtype: Cell; occurred_at: Cell }[],
): Map<string, { kind: string; subtype: string | null; at: string }> {
  const out = new Map<string, { kind: string; subtype: string | null; at: string }>();
  for (const l of lines) {
    const person = text(l.person_id);
    const kind = text(l.kind);
    const at = isoOf(l.occurred_at);
    if (!person || !kind || !at || !countsAsContact(kind, text(l.subtype))) continue;
    const before = out.get(person);
    if (!before || Date.parse(at) > Date.parse(before.at))
      out.set(person, { kind, subtype: text(l.subtype), at });
  }
  return out;
}

/** A hit an add-on builds from its part of the copy, with everything it doesn't say left empty. */
export function copyHit(
  h: Pick<SearchHit, 'kind' | 'id' | 'title' | 'href' | 'tier'> & Partial<SearchHit>,
): SearchHit {
  return hitOf(h);
}
