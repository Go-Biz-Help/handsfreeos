/**
 * A phone's synced rows, turned into the shapes the CRM's words take (M10 step 15) — the same job `inbox/rows.ts`
 * does for conversations and `attention/synced.ts` for the Action Center.
 *
 * The phone's copy holds the tables, not the API's answers: every column arrives as text (or 0/1 for a boolean) and
 * any of them can be null. These functions build a `PersonSummary`, a `LeadCard`, a `TaskOut`, a `FileOut` and a
 * `TimelineEntry` out of them, so the record page, the pipeline and the task list on the phone run the very code the
 * server's answers run through on the web.
 */
import type { TimelineEntry } from '../schemas/activity';
import type { TagRef } from '../schemas/crm';
import type { FileOut } from '../schemas/file';
import type { LeadCard } from '../schemas/lead';
import type { PersonSummary } from '../schemas/person';
import type { TaskOut } from '../schemas/task';
import type { OtherAddressOut, OtherEmailOut, OtherPhoneOut } from '../schemas/crm';
import { otherAddressesOut, otherEmailsOut, otherPhonesOut } from './contact-points';
import { formatPhone } from './phone';
import { isImageFile } from './file-words';
import { taskDueBucket } from './task-words';

/** Every synced column reads as text, an integer or nothing. */
type Cell = string | number | null | undefined;

const text = (v: Cell): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const words = (v: Cell): string => text(v) ?? '';
const int = (v: Cell): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const bool = (v: Cell): boolean => int(v) !== 0;
/** A synced time is already ISO 8601 text; a bad one reads as nothing rather than "Invalid Date". */
const time = (v: Cell): string | null => {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const timeOr = (v: Cell, fallback: string): string => time(v) ?? fallback;

const json = (v: Cell): Record<string, unknown> => {
  const s = text(v);
  if (!s) return {};
  try {
    const parsed: unknown = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Names for the people, companies, leads, tags and teammates a row points at. */
export interface SyncedNames {
  person(id: string | null): { readonly fullName: string; readonly archived: boolean } | null;
  company(id: string | null): { readonly name: string; readonly archived: boolean } | null;
  lead(id: string | null): { readonly title: string } | null;
  user(id: string | null): string | null;
  tags(recordId: string): readonly TagRef[];
}

/** An empty name book, for a screen that hasn't loaded one yet. */
export const NO_NAMES: SyncedNames = {
  person: () => null,
  company: () => null,
  lead: () => null,
  user: () => null,
  tags: () => [],
};

const userRef = (id: Cell, names: SyncedNames) => {
  const userId = text(id);
  return userId ? { id: userId, fullName: names.user(userId) ?? 'Former member' } : null;
};

/** Everyone else on a customer (0104), from the phone's copy: a Postgres array arrives as JSON text. */
const teamOf = (ids: Cell, names: SyncedNames): { id: string; fullName: string }[] => {
  const s = text(ids);
  if (!s) return [];
  let list: unknown;
  try {
    list = JSON.parse(s);
  } catch {
    // An array PowerSync didn't turn into JSON reads '{a,b}'.
    list = s.replace(/^\{|\}$/g, '').split(',');
  }
  return (Array.isArray(list) ? list : [])
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => ({ id: id.trim(), fullName: names.user(id.trim()) ?? 'Former member' }));
};

const personRef = (id: Cell, names: SyncedNames) => {
  const personId = text(id);
  if (!personId) return null;
  const found = names.person(personId);
  return { id: personId, fullName: found?.fullName ?? '', archived: found?.archived ?? false };
};

const companyRef = (id: Cell, names: SyncedNames) => {
  const companyId = text(id);
  if (!companyId) return null;
  const found = names.company(companyId);
  return { id: companyId, name: found?.name ?? '', archived: found?.archived ?? false };
};

export interface SyncedPersonRow {
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
  readonly country: Cell;
  /** JSON text (0103); a phone that hasn't caught up has none. */
  readonly other_emails?: Cell;
  readonly other_phones?: Cell;
  readonly other_addresses?: Cell;
  readonly notes: Cell;
  readonly source: Cell;
  readonly company_id: Cell;
  readonly owner_user_id: Cell;
  /** A JSON array of ids (0104); a phone that hasn't caught up has none. */
  readonly team_user_ids?: Cell;
  readonly archived_at: Cell;
  readonly possible_duplicate_of: Cell;
  readonly created_at: Cell;
  readonly updated_at: Cell;
}

/**
 * One person as `person.get` answers, plus their notes and the record they may duplicate. A phone makes a new
 * customer's id itself, so it can't check for a match first: the server flags one afterwards and the phone shows
 * "Possible duplicate of …" rather than merging (M10's decision).
 */
export function personOfSynced(
  row: SyncedPersonRow,
  names: SyncedNames,
  counts: { readonly openLeads?: number; readonly lastActivityAt?: string | null } = {},
): PersonSummary & {
  readonly notes: string | null;
  readonly possibleDuplicateOf: string | null;
} {
  const first = words(row.first_name);
  const last = words(row.last_name);
  const otherPhones = otherPhonesOut(row.other_phones ?? null);
  return {
    id: row.id,
    firstName: first,
    lastName: last,
    fullName: `${first} ${last}`.trim(),
    email: text(row.email),
    phone: text(row.phone) ?? (text(row.phone_e164) ? formatPhone(words(row.phone_e164)) : null),
    phoneE164: text(row.phone_e164),
    phoneAlt: otherPhones[0]?.phone ?? text(row.phone_alt),
    address: {
      line1: text(row.address_line1),
      line2: text(row.address_line2),
      city: text(row.city),
      state: text(row.state),
      postalCode: text(row.postal_code),
      // The column is never empty on a saved record; a phone that hasn't caught up reads it as US, as the table does.
      country: text(row.country) ?? 'US',
    },
    otherEmails: otherEmailsOut(row.other_emails ?? null),
    otherPhones,
    otherAddresses: otherAddressesOut(row.other_addresses ?? null),
    source: text(row.source),
    company: companyRef(row.company_id, names),
    owner: userRef(row.owner_user_id, names),
    team: teamOf(row.team_user_ids, names),
    tags: [...names.tags(row.id)],
    openLeads: counts.openLeads ?? 0,
    lastActivityAt: counts.lastActivityAt ?? null,
    archivedAt: time(row.archived_at),
    createdAt: timeOr(row.created_at, new Date(0).toISOString()),
    updatedAt: timeOr(row.updated_at, new Date(0).toISOString()),
    notes: text(row.notes),
    possibleDuplicateOf: text(row.possible_duplicate_of),
  };
}

export interface SyncedCompanyRow {
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
  readonly country: Cell;
  /** JSON text (0103); a phone that hasn't caught up has none. */
  readonly other_emails?: Cell;
  readonly other_phones?: Cell;
  readonly other_addresses?: Cell;
  readonly notes: Cell;
  readonly source: Cell;
  readonly owner_user_id: Cell;
  /** A JSON array of ids (0104); a phone that hasn't caught up has none. */
  readonly team_user_ids?: Cell;
  readonly archived_at: Cell;
  readonly created_at: Cell;
  readonly updated_at: Cell;
}

export interface SyncedCompany {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly phoneE164: string | null;
  readonly website: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly country: string | null;
  };
  readonly otherEmails: readonly OtherEmailOut[];
  readonly otherPhones: readonly OtherPhoneOut[];
  readonly otherAddresses: readonly OtherAddressOut[];
  readonly notes: string | null;
  readonly source: string | null;
  readonly owner: { readonly id: string; readonly fullName: string } | null;
  readonly team: readonly { readonly id: string; readonly fullName: string }[];
  readonly tags: readonly TagRef[];
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function companyOfSynced(row: SyncedCompanyRow, names: SyncedNames): SyncedCompany {
  return {
    id: row.id,
    name: words(row.name),
    email: text(row.email),
    phone: text(row.phone) ?? (text(row.phone_e164) ? formatPhone(words(row.phone_e164)) : null),
    phoneE164: text(row.phone_e164),
    website: text(row.website),
    address: {
      line1: text(row.address_line1),
      line2: text(row.address_line2),
      city: text(row.city),
      state: text(row.state),
      postalCode: text(row.postal_code),
      country: text(row.country),
    },
    otherEmails: otherEmailsOut(row.other_emails ?? null),
    otherPhones: otherPhonesOut(row.other_phones ?? null),
    otherAddresses: otherAddressesOut(row.other_addresses ?? null),
    notes: text(row.notes),
    source: text(row.source),
    owner: userRef(row.owner_user_id, names),
    team: teamOf(row.team_user_ids, names),
    tags: names.tags(row.id),
    archivedAt: time(row.archived_at),
    createdAt: timeOr(row.created_at, new Date(0).toISOString()),
    updatedAt: timeOr(row.updated_at, new Date(0).toISOString()),
  };
}

export interface SyncedLeadRow {
  readonly id: string;
  readonly pipeline_id: Cell;
  readonly stage_id: Cell;
  readonly person_id: Cell;
  readonly company_id: Cell;
  readonly title: Cell;
  readonly value_cents: Cell;
  readonly source: Cell;
  readonly assignee_user_id: Cell;
  readonly expected_close_on: Cell;
  readonly next_action: Cell;
  readonly next_action_at: Cell;
  readonly status: Cell;
  readonly won_at: Cell;
  readonly lost_at: Cell;
  readonly lost_reason: Cell;
  readonly position: Cell;
  readonly stage_entered_at: Cell;
  readonly last_contact_at: Cell;
  readonly archived_at: Cell;
  readonly created_at: Cell;
  readonly updated_at: Cell;
}

export interface SyncedStageRow {
  readonly id: string;
  readonly pipeline_id: Cell;
  readonly name: Cell;
  readonly kind: Cell;
  readonly position: Cell;
}

const stageKindOf = (kind: Cell): 'open' | 'won' | 'lost' =>
  kind === 'won' ? 'won' : kind === 'lost' ? 'lost' : 'open';

/** One lead as `lead.board` and `lead.get` answer, from the phone's copy. */
export function leadCardOfSynced(
  row: SyncedLeadRow,
  stage: SyncedStageRow | null,
  names: SyncedNames,
  now = Date.now(),
): LeadCard {
  const status = row.status === 'won' ? 'won' : row.status === 'lost' ? 'lost' : 'open';
  const nextActionAt = time(row.next_action_at);
  const created = timeOr(row.created_at, new Date(0).toISOString());
  return {
    id: row.id,
    title: words(row.title),
    pipelineId: words(row.pipeline_id),
    stageId: words(row.stage_id),
    stageName: words(stage?.name),
    stageKind: stageKindOf(stage?.kind),
    status,
    person: personRef(row.person_id, names),
    company: companyRef(row.company_id, names),
    valueCents: int(row.value_cents),
    source: text(row.source),
    assignee: userRef(row.assignee_user_id, names),
    expectedCloseOn: text(row.expected_close_on),
    nextAction: text(row.next_action),
    nextActionAt,
    needsNextAction: status === 'open' && !text(row.next_action),
    nextActionOverdue: status === 'open' && !!nextActionAt && Date.parse(nextActionAt) <= now,
    lastContactAt: time(row.last_contact_at),
    wonAt: time(row.won_at),
    lostAt: time(row.lost_at),
    lostReason: text(row.lost_reason),
    position: int(row.position),
    tags: [...names.tags(row.id)],
    stageEnteredAt: timeOr(row.stage_entered_at, created),
    archivedAt: time(row.archived_at),
    createdAt: created,
    updatedAt: timeOr(row.updated_at, created),
  };
}

export interface SyncedTaskRow {
  readonly id: string;
  readonly title: Cell;
  readonly notes: Cell;
  readonly due_at: Cell;
  readonly all_day: Cell;
  readonly assignee_user_id: Cell;
  readonly person_id: Cell;
  readonly company_id: Cell;
  readonly lead_id: Cell;
  readonly done_at: Cell;
  readonly done_by: Cell;
  readonly created_by: Cell;
  readonly created_at: Cell;
  readonly updated_at: Cell;
}

/** One task as `task.list` answers, its due bucket worked out where the business is. */
export function taskOfSynced(
  row: SyncedTaskRow,
  names: SyncedNames,
  timeZone: string,
  now: Date = new Date(),
): TaskOut {
  const dueAt = time(row.due_at);
  const doneAt = time(row.done_at);
  const allDay = bool(row.all_day);
  const leadId = text(row.lead_id);
  const created = timeOr(row.created_at, new Date(0).toISOString());
  return {
    id: row.id,
    title: words(row.title),
    notes: text(row.notes),
    dueAt,
    allDay,
    dueBucket: taskDueBucket({ dueAt, allDay, doneAt }, timeZone, now),
    assignee: userRef(row.assignee_user_id, names),
    person: personRef(row.person_id, names),
    company: companyRef(row.company_id, names),
    lead: leadId ? { id: leadId, title: names.lead(leadId)?.title ?? '' } : null,
    // Kinds of records a business makes up (0101) don't reach the phone yet: a task about one reads as the rest.
    customRecord: null,
    doneAt,
    doneBy: userRef(row.done_by, names),
    createdBy: userRef(row.created_by, names),
    createdAt: created,
    updatedAt: timeOr(row.updated_at, created),
  };
}

export interface SyncedFileRow {
  readonly id: string;
  readonly record_type: Cell;
  readonly record_id: Cell;
  readonly bucket: Cell;
  readonly object_path: Cell;
  readonly name: Cell;
  readonly mime_type: Cell;
  readonly size_bytes: Cell;
  readonly status: Cell;
  readonly created_by: Cell;
  readonly created_at: Cell;
  /** Locked (a signed document, Real Estate step 3); absent on a phone whose copy predates it. */
  readonly locked_at?: Cell;
}

/** One file as `file.list` answers. */
export function fileOfSynced(row: SyncedFileRow, names: SyncedNames): FileOut {
  const mimeType = text(row.mime_type);
  return {
    id: row.id,
    recordType: (text(row.record_type) ?? 'person') as FileOut['recordType'],
    recordId: words(row.record_id),
    bucket: words(row.bucket),
    objectPath: words(row.object_path),
    name: words(row.name),
    mimeType,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : int(row.size_bytes),
    isImage: isImageFile(mimeType),
    locked: text(row.locked_at ?? null) !== null,
    uploadedBy: userRef(row.created_by, names),
    createdAt: timeOr(row.created_at, new Date(0).toISOString()),
  };
}

export interface SyncedActivityRow {
  readonly id: string;
  readonly kind: Cell;
  readonly subtype: Cell;
  readonly person_id: Cell;
  readonly company_id: Cell;
  readonly lead_id: Cell;
  readonly body: Cell;
  readonly occurred_at: Cell;
  readonly author_user_id: Cell;
  readonly actor_type: Cell;
  readonly meta: Cell;
  readonly created_at: Cell;
}

/** One timeline entry as `timeline.list` answers, from an activity on the phone. */
export function timelineEntryOfSynced(row: SyncedActivityRow, names: SyncedNames): TimelineEntry {
  return {
    id: row.id,
    entry: 'activity',
    kind: words(row.kind),
    subtype: text(row.subtype),
    body: text(row.body),
    occurredAt: timeOr(row.occurred_at, timeOr(row.created_at, new Date(0).toISOString())),
    actor: userRef(row.author_user_id, names),
    actorType: text(row.actor_type) ?? 'user',
    personId: text(row.person_id),
    companyId: text(row.company_id),
    leadId: text(row.lead_id),
    // Not synced yet (0101): the phone shows an entry on the customer, company or lead it's also on.
    customRecordId: null,
    meta: json(row.meta),
  };
}

/**
 * Newest first, the order every timeline reads in. Completing a task and adding a file already write their own
 * `task_done` and `file_added` activities, so nothing is folded in here: the phone reads exactly the rows the web's
 * `timeline.list` reads.
 */
export function timelineOrder(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort(
    (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id < b.id ? 1 : -1),
  );
}
