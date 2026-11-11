/**
 * Contractor Operations' part of a phone's copy (docs/contractor.md, "On the phone"), read once into what its field
 * pages work from, so they read the same with no signal as the web does with it.
 *
 * The phone holds tables, not answers: the job and property records, the add-on's rows as JSON
 * (`addon_phone_rows`: jobs, phases, team, crews, work orders with their items and subcontractors, materials, time
 * and notes), the links (a job's customer and property), and core's people, team members, appointments and files.
 * Every column arrives as text or 0/1 and any may be null. `contractorCopyOf` reads them once; each view below works
 * out what the server's query of the same name answers, and `packages/core/test/addons/contractor-phone.test.ts`
 * holds each to it.
 *
 * **No money is here** (the owner's decision 11): a phone keeps no price, budget or cost, so no view has one.
 *
 * **A visit's job** is known through its work order: a phone's appointments don't say which record they're for, and
 * every visit booked on a job gets a work order a moment later.
 *
 * Browser-safe and pure.
 */
import { JOB_STATUSES as VISIT_STAGES, type JobStatus as VisitStage } from '../../../schemas/job';
import {
  cellMs,
  cellObject,
  cellText,
  rowKey,
  type Cell,
  type SyncedPhoneRow,
} from '../../phone-rows';
import { checklistProgress, type ChecklistProgress, type ItemKind } from '../checklists';
import {
  isMissing,
  leftOf,
  materialState,
  neededOn,
  shortOf,
  type MaterialCounts,
  type MaterialState,
} from '../materials';
import { NOTE_LIMITS, TRANSCRIPT_STATES, type TranscriptState } from '../notes';
import {
  daysBetween,
  isOpen,
  JOB_STATUSES,
  jobPercent,
  PHASE_STATUSES,
  type JobKind,
  type JobStatus,
  type PhaseStatus,
} from '../progress';
import {
  secondsOf,
  TIME_KINDS,
  TIME_SOURCES,
  totalsOf,
  type TimeKind,
  type TimeSource,
  type TimeTotals,
} from '../time';
import { isTrade, type Trade } from '../trades';

export type { Cell, SyncedPhoneRow };

/** How many jobs, visits and stretches one answer holds, as the server's (`LIMITS` in ../schemas.ts). */
export const PHONE_LIMITS = { list: 300, visits: 50, timeEntries: 500 } as const;

// ---------- what the phone's SQL hands over ----------

export interface ContractorSource {
  /** `custom_records` of the add-on's two kinds, each with its kind's `key`. */
  readonly records: readonly {
    readonly id: Cell;
    readonly kind_key: Cell;
    readonly name: Cell;
    readonly archived_at: Cell;
  }[];
  /** The add-on's own rows (`addon_phone_rows`). */
  readonly rows: readonly SyncedPhoneRow[];
  /** `relationships` of the add-on's types, each with its type's `addon_key`. */
  readonly links: readonly {
    readonly addon_key: Cell;
    readonly a_person_id: Cell;
    readonly a_custom_record_id: Cell;
    readonly b_custom_record_id: Cell;
    readonly created_at: Cell;
  }[];
  readonly people: readonly {
    readonly id: Cell;
    readonly first_name: Cell;
    readonly last_name: Cell;
    readonly email: Cell;
    readonly phone_e164: Cell;
    readonly company_id: Cell;
    readonly archived_at: Cell;
  }[];
  readonly companies: readonly { readonly id: Cell; readonly name: Cell }[];
  readonly users: readonly { readonly id: Cell; readonly full_name: Cell; readonly email: Cell }[];
  readonly appointments: readonly {
    readonly id: Cell;
    readonly title: Cell;
    readonly starts_at: Cell;
    readonly ends_at: Cell;
    readonly status: Cell;
    readonly location: Cell;
    /** Core's job for the visit: where its crew has it. */
    readonly job_id: Cell;
  }[];
  readonly staff: readonly {
    readonly appointment_id: Cell;
    readonly user_id: Cell;
    readonly active: Cell;
    readonly created_at: Cell;
  }[];
  /** Core's visit jobs: a phone keeps the ones that aren't done or cancelled. */
  readonly visitJobs: readonly { readonly id: Cell; readonly status: Cell }[];
  readonly files: readonly {
    readonly id: Cell;
    readonly name: Cell;
    readonly mime_type: Cell;
    readonly status: Cell;
  }[];
}

// ---------- reading cells ----------

const text = cellText;
const ms = cellMs;
const iso = (t: number) => new Date(t).toISOString();
/**
 * A visit's address, from its saved place (`appointments.location`, which a phone keeps as JSON text): null when
 * the place has none, as a video call's or a visit with no place set.
 */
const addressIn = (location: unknown): string | null => {
  const saved = text(location);
  if (!saved) return null;
  try {
    const address = (JSON.parse(saved) as { address?: unknown } | null)?.address;
    return typeof address === 'string' && address.trim() ? address.trim() : null;
  } catch {
    return null;
  }
};
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const int = (v: unknown): number => Math.trunc(num(v));
const flag = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
const oneOf = <T extends string>(list: readonly T[], v: unknown, otherwise: T): T =>
  (list as readonly string[]).includes(String(v)) ? (v as T) : otherwise;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Postgres's `btrim`: spaces only. */
const btrim = (s: string) => s.replace(/^ +| +$/g, '');
/** Postgres's `nullif(btrim(concat_ws(' ', a, b)), '')`. */
const fullName = (first: Cell, last: Cell): string | null => {
  const parts = [first, last].filter((v) => v !== null && v !== undefined).map(String);
  return btrim(parts.join(' ')) || null;
};
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

// ---------- the copy ----------

interface CopyJob {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly statusAt: number;
  readonly statusReason: string | null;
  readonly trade: Trade | null;
  readonly details: string | null;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
  readonly doneAt: number | null;
  readonly percentDone: number;
  readonly leadUserId: string | null;
  readonly updatedAt: number;
}
interface CopyPhase {
  readonly id: string;
  readonly position: number;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly percentDone: number;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
  readonly doneAt: number | null;
  readonly createdAt: number;
}
interface CopyOrder {
  readonly appointmentId: string;
  readonly jobId: string;
  readonly crewId: string | null;
  readonly instructions: string | null;
  readonly bring: string | null;
}
interface CopyItem {
  readonly id: string;
  readonly appointmentId: string;
  readonly position: number;
  readonly label: string;
  readonly kind: ItemKind;
  readonly required: boolean;
  readonly doneAt: number | null;
  readonly doneBy: string | null;
  readonly fileId: string | null;
  readonly skippedAt: number | null;
  readonly skippedBy: string | null;
  readonly skipReason: string | null;
  readonly createdAt: number;
}
interface CopySub {
  readonly id: string;
  readonly appointmentId: string;
  readonly personId: string;
  readonly toldAt: number | null;
  readonly doneAt: number | null;
  readonly doneBy: string | null;
  readonly note: string | null;
  readonly createdAt: number;
}
interface CopyMaterial extends MaterialCounts {
  readonly id: string;
  readonly jobId: string;
  readonly position: number;
  readonly name: string;
  readonly unitLabel: string;
  readonly appointmentId: string | null;
  readonly supplier: string | null;
  readonly expectedOn: string | null;
  readonly note: string | null;
  readonly createdAt: number;
}
interface CopyTime {
  readonly id: string;
  readonly jobId: string;
  readonly appointmentId: string | null;
  readonly userId: string | null;
  readonly kind: TimeKind;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly source: TimeSource;
  readonly autoStopped: boolean;
  readonly fixed: boolean;
}
interface CopyNote {
  readonly id: string;
  readonly jobId: string;
  readonly appointmentId: string | null;
  readonly body: string | null;
  readonly audioFileId: string | null;
  readonly transcript: string | null;
  readonly transcriptState: TranscriptState;
  readonly photoFileIds: readonly string[];
  readonly createdBy: string | null;
  readonly notedAt: number;
}
interface CopyVisit {
  readonly id: string;
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly status: string;
  readonly location: string | null;
  readonly coreJobId: string | null;
}

export interface ContractorCopy {
  readonly jobs: ReadonlyMap<string, CopyJob>;
  readonly phases: ReadonlyMap<string, readonly CopyPhase[]>;
  /** A job's team, in the order they were put on. */
  readonly team: ReadonlyMap<string, readonly string[]>;
  readonly crews: ReadonlyMap<string, string>;
  /** By the visit's appointment. */
  readonly orders: ReadonlyMap<string, CopyOrder>;
  readonly ordersOfJob: ReadonlyMap<string, readonly CopyOrder[]>;
  readonly items: ReadonlyMap<string, readonly CopyItem[]>;
  readonly subs: ReadonlyMap<string, readonly CopySub[]>;
  readonly materials: ReadonlyMap<string, readonly CopyMaterial[]>;
  readonly time: ReadonlyMap<string, readonly CopyTime[]>;
  readonly notes: ReadonlyMap<string, readonly CopyNote[]>;
  readonly visits: ReadonlyMap<string, CopyVisit>;
  /** The people on the business's team on a visit, in core's order. */
  readonly staff: ReadonlyMap<string, readonly string[]>;
  readonly visitJobs: ReadonlyMap<string, string>;
  readonly userNames: ReadonlyMap<string, string>;
  /** A job's customer and property, the first of each. */
  readonly customers: ReadonlyMap<string, { personId: string; name: string }>;
  readonly properties: ReadonlyMap<string, { recordId: string; name: string }>;
  readonly contacts: ReadonlyMap<
    string,
    { name: string; company: string | null; canText: boolean }
  >;
  readonly files: ReadonlyMap<string, { name: string; mimeType: string; ready: boolean }>;
  /** A contact's mobile number, by person: the phone's own, to call a customer from the job. */
  readonly phones: ReadonlyMap<string, string>;
}

/** Reads the phone's rows once. */
export function contractorCopyOf(src: ContractorSource): ContractorCopy {
  const names = new Map<string, { name: string; archived: boolean; kind: string }>();
  for (const r of src.records) {
    const id = text(r.id);
    if (id)
      names.set(id, {
        name: text(r.name) ?? '',
        archived: text(r.archived_at) !== null,
        kind: text(r.kind_key) ?? '',
      });
  }
  const userNames = new Map<string, string>();
  for (const u of src.users) {
    const id = text(u.id);
    const name = btrim(text(u.full_name) ?? '') || text(u.email);
    if (id && name) userNames.set(id, name);
  }
  const companies = new Map<string, string>();
  for (const c of src.companies) {
    const id = text(c.id);
    if (id) companies.set(id, text(c.name) ?? '');
  }
  const personNames = new Map<string, string | null>();
  const phones = new Map<string, string>();
  const contacts = new Map<string, { name: string; company: string | null; canText: boolean }>();
  for (const p of src.people) {
    const id = text(p.id);
    if (!id) continue;
    const base = fullName(p.first_name, p.last_name) ?? text(p.email);
    const phone = text(p.phone_e164);
    personNames.set(id, base ?? phone);
    if (phone) phones.set(id, phone);
    if (text(p.archived_at) === null) {
      const companyId = text(p.company_id);
      contacts.set(id, {
        name: base ?? phone ?? 'Contact',
        company: companyId ? (companies.get(companyId) ?? null) : null,
        canText: phone !== null,
      });
    }
  }

  const jobs = new Map<string, CopyJob>();
  const phases = new Map<string, CopyPhase[]>();
  const teamRows = new Map<string, { userId: string; at: number }[]>();
  const crews = new Map<string, string>();
  const orders = new Map<string, CopyOrder>();
  const ordersOfJob = new Map<string, CopyOrder[]>();
  const items = new Map<string, CopyItem[]>();
  const subs = new Map<string, CopySub[]>();
  const materials = new Map<string, CopyMaterial[]>();
  const time = new Map<string, CopyTime[]>();
  const notes = new Map<string, CopyNote[]>();

  for (const row of src.rows) {
    const source = text(row.source);
    const key = rowKey(row.id);
    const jobId = text(row.record_id);
    const d = cellObject(row.data);
    if (source === 'crews') {
      // An archived crew keeps its name on the visits it was given.
      crews.set(key, text(d['name']) ?? 'Crew');
      continue;
    }
    if (!jobId) continue;
    if (source === 'jobs') {
      const record = names.get(jobId);
      // A job whose record isn't on the phone (yet) has no name to show.
      if (!record) continue;
      const trade = text(d['trade']);
      jobs.set(jobId, {
        id: jobId,
        name: record.name,
        archived: record.archived,
        kind: d['kind'] === 'project' ? 'project' : 'service',
        status: oneOf(JOB_STATUSES, d['status'], 'new'),
        statusAt: ms(d['status_at']) ?? 0,
        statusReason: text(d['status_reason']),
        trade: trade && isTrade(trade) ? trade : null,
        details: text(d['details']),
        startsOn: text(d['starts_on']),
        dueOn: text(d['due_on']),
        doneAt: ms(d['done_at']),
        percentDone: int(d['percent_done']),
        leadUserId: text(d['lead_user_id']),
        updatedAt: ms(d['updated_at']) ?? 0,
      });
    } else if (source === 'phases') {
      push(phases, jobId, {
        id: key,
        position: int(d['position']),
        name: text(d['name']) ?? '',
        status: oneOf(PHASE_STATUSES, d['status'], 'not_started'),
        percentDone: int(d['percent_done']),
        startsOn: text(d['starts_on']),
        dueOn: text(d['due_on']),
        doneAt: ms(d['done_at']),
        createdAt: ms(d['created_at']) ?? 0,
      });
    } else if (source === 'team') {
      const userId = text(d['user_id']);
      if (userId) push(teamRows, jobId, { userId, at: ms(d['created_at']) ?? 0 });
    } else if (source === 'work_orders') {
      const order: CopyOrder = {
        appointmentId: key,
        jobId,
        crewId: text(d['crew_id']),
        instructions: text(d['instructions']),
        bring: text(d['bring']),
      };
      orders.set(key, order);
      push(ordersOfJob, jobId, order);
    } else if (source === 'work_order_items') {
      const appointmentId = text(d['appointment_id']);
      if (appointmentId)
        push(items, appointmentId, {
          id: key,
          appointmentId,
          position: int(d['position']),
          label: text(d['label']) ?? '',
          kind: d['kind'] === 'photo' ? 'photo' : 'check',
          required: flag(d['required']),
          doneAt: ms(d['done_at']),
          doneBy: text(d['done_by']),
          fileId: text(d['file_id']),
          skippedAt: ms(d['skipped_at']),
          skippedBy: text(d['skipped_by']),
          skipReason: text(d['skip_reason']),
          createdAt: ms(d['created_at']) ?? 0,
        });
    } else if (source === 'work_order_subs') {
      const appointmentId = text(d['appointment_id']);
      const personId = text(d['person_id']);
      if (appointmentId && personId)
        push(subs, appointmentId, {
          id: key,
          appointmentId,
          personId,
          toldAt: ms(d['told_at']),
          doneAt: ms(d['done_at']),
          doneBy: text(d['done_by']),
          note: text(d['note']),
          createdAt: ms(d['created_at']) ?? 0,
        });
    } else if (source === 'materials') {
      push(materials, jobId, {
        id: key,
        jobId,
        position: int(d['position']),
        name: text(d['name']) ?? '',
        unitLabel: text(d['unit_label']) ?? 'each',
        appointmentId: text(d['appointment_id']),
        needed: num(d['needed']),
        ordered: num(d['ordered']),
        delivered: num(d['delivered']),
        used: num(d['used']),
        wasted: num(d['wasted']),
        returned: num(d['returned']),
        supplier: text(d['supplier']),
        expectedOn: text(d['expected_on']),
        note: text(d['note']),
        createdAt: ms(d['created_at']) ?? 0,
      });
    } else if (source === 'time_entries') {
      const startedAt = ms(d['started_at']);
      if (startedAt !== null)
        push(time, jobId, {
          id: key,
          jobId,
          appointmentId: text(d['appointment_id']),
          userId: text(d['user_id']),
          kind: oneOf(TIME_KINDS, d['kind'], 'work'),
          startedAt,
          endedAt: ms(d['ended_at']),
          source: oneOf(TIME_SOURCES, d['source'], 'status'),
          autoStopped: flag(d['auto_stopped']),
          fixed: text(d['fixed_at']) !== null,
        });
    } else if (source === 'notes') {
      const photos = d['photo_file_ids'];
      push(notes, jobId, {
        id: key,
        jobId,
        appointmentId: text(d['appointment_id']),
        body: text(d['body']),
        audioFileId: text(d['audio_file_id']),
        transcript: text(d['transcript']),
        transcriptState: oneOf(TRANSCRIPT_STATES, d['transcript_state'], 'none'),
        photoFileIds: Array.isArray(photos)
          ? photos.filter((x): x is string => typeof x === 'string')
          : [],
        createdBy: text(d['created_by']),
        notedAt: ms(d['noted_at']) ?? 0,
      });
    }
  }

  const team = new Map<string, string[]>();
  for (const [jobId, list] of teamRows)
    team.set(
      jobId,
      [...list].sort((a, b) => a.at - b.at || byText(a.userId, b.userId)).map((t) => t.userId),
    );
  for (const list of phases.values())
    list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  for (const list of items.values())
    list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  for (const list of subs.values())
    list.sort((a, b) => a.createdAt - b.createdAt || byText(a.id, b.id));
  for (const list of materials.values())
    list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || byText(a.id, b.id));
  for (const list of time.values())
    list.sort((a, b) => b.startedAt - a.startedAt || byText(a.id, b.id));
  for (const list of notes.values())
    list.sort((a, b) => b.notedAt - a.notedAt || byText(b.id, a.id));

  const visits = new Map<string, CopyVisit>();
  for (const a of src.appointments) {
    const id = text(a.id);
    const startsAt = ms(a.starts_at);
    const endsAt = ms(a.ends_at);
    if (!id || startsAt === null || endsAt === null) continue;
    visits.set(id, {
      id,
      title: text(a.title) ?? '',
      startsAt,
      endsAt,
      status: text(a.status) ?? 'scheduled',
      location: addressIn(a.location),
      coreJobId: text(a.job_id),
    });
  }
  const staffRows = new Map<string, { userId: string; at: number }[]>();
  for (const s of src.staff) {
    const appointmentId = text(s.appointment_id);
    const userId = text(s.user_id);
    if (appointmentId && userId && flag(s.active))
      push(staffRows, appointmentId, { userId, at: ms(s.created_at) ?? 0 });
  }
  const staff = new Map<string, string[]>();
  for (const [appointmentId, list] of staffRows)
    staff.set(
      appointmentId,
      [...list].sort((a, b) => a.at - b.at || byText(a.userId, b.userId)).map((s) => s.userId),
    );
  const visitJobs = new Map<string, string>();
  for (const j of src.visitJobs) {
    const id = text(j.id);
    const status = text(j.status);
    if (id && status) visitJobs.set(id, status);
  }

  // A job's customer and property: the first link of each kind, as the server picks them.
  const firstLink = new Map<string, { at: number; other: string }>();
  for (const l of src.links) {
    const kind = text(l.addon_key);
    const at = ms(l.created_at) ?? 0;
    const [jobId, other] =
      kind === 'contractor_customer'
        ? [text(l.b_custom_record_id), text(l.a_person_id)]
        : kind === 'contractor_site'
          ? [text(l.a_custom_record_id), text(l.b_custom_record_id)]
          : [null, null];
    if (!jobId || !other) continue;
    // Only a link whose other end is on the phone counts, as the server's join has it.
    if (kind === 'contractor_customer' ? !personNames.has(other) : !names.has(other)) continue;
    const key = `${kind}:${jobId}`;
    const had = firstLink.get(key);
    if (!had || at < had.at) firstLink.set(key, { at, other });
  }
  const customers = new Map<string, { personId: string; name: string }>();
  const properties = new Map<string, { recordId: string; name: string }>();
  for (const [key, link] of firstLink) {
    const jobId = key.slice(key.indexOf(':') + 1);
    if (key.startsWith('contractor_customer:'))
      customers.set(jobId, {
        personId: link.other,
        name: personNames.get(link.other) ?? 'Customer',
      });
    else properties.set(jobId, { recordId: link.other, name: names.get(link.other)?.name ?? '' });
  }

  const files = new Map<string, { name: string; mimeType: string; ready: boolean }>();
  for (const f of src.files) {
    const id = text(f.id);
    if (id)
      files.set(id, {
        name: text(f.name) ?? '',
        mimeType: (text(f.mime_type) ?? '').toLowerCase(),
        ready: text(f.status) === 'ready',
      });
  }

  return {
    jobs,
    phases,
    team,
    crews,
    orders,
    ordersOfJob,
    items,
    subs,
    materials,
    time,
    notes,
    visits,
    staff,
    visitJobs,
    userNames,
    customers,
    properties,
    contacts,
    files,
    phones,
  };
}

// ---------- a visit ----------

const isStage = (s: string): s is VisitStage => (VISIT_STAGES as readonly string[]).includes(s);

/**
 * Where a visit stands, from what a phone keeps: a cancelled visit is cancelled; one whose crew has pressed a button
 * is where they left it; and since a phone keeps only the visit jobs still going, one that has left is done.
 */
function stageOf(copy: ContractorCopy, v: CopyVisit): VisitStage {
  if (v.status === 'cancelled') return 'cancelled';
  if (v.coreJobId) {
    const stage = copy.visitJobs.get(v.coreJobId);
    return stage && isStage(stage) ? stage : 'done';
  }
  return v.status === 'completed' ? 'done' : 'scheduled';
}

const progressOf = (list: readonly CopyItem[]): ChecklistProgress =>
  checklistProgress(
    list.map((i) => ({
      required: i.required,
      done: i.doneAt !== null,
      skipped: i.skippedAt !== null,
    })),
  );

const missingOn = (copy: ContractorCopy, jobId: string, appointmentId: string): number =>
  (copy.materials.get(jobId) ?? []).filter((m) => neededOn(m, appointmentId) && isMissing(m))
    .length;

/** A job's visits a phone keeps: the ones with a work order whose appointment is here. */
function visitsOf(copy: ContractorCopy, jobId: string): CopyVisit[] {
  return (copy.ordersOfJob.get(jobId) ?? []).flatMap((o) => {
    const v = copy.visits.get(o.appointmentId);
    return v ? [v] : [];
  });
}

export interface PhoneVisit {
  readonly appointmentId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly stage: VisitStage;
  readonly crew: string | null;
  readonly checklist: ChecklistProgress | null;
  readonly materialsMissing: number;
}

function visitOut(copy: ContractorCopy, jobId: string, v: CopyVisit): PhoneVisit {
  const order = copy.orders.get(v.id);
  return {
    appointmentId: v.id,
    title: v.title,
    startsAt: iso(v.startsAt),
    endsAt: iso(v.endsAt),
    status: v.status,
    stage: stageOf(copy, v),
    crew: order?.crewId ? (copy.crews.get(order.crewId) ?? null) : null,
    checklist: order ? progressOf(copy.items.get(v.id) ?? []) : null,
    materialsMissing: missingOn(copy, jobId, v.id),
  };
}

// ---------- jobs ----------

/** A job in a list: what `contractor.job.list` answers for each. */
export interface PhoneJobRow {
  readonly id: string;
  readonly name: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly statusAt: string;
  readonly statusReason: string | null;
  readonly trade: Trade | null;
  readonly percentDone: number;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
  readonly daysLate: number | null;
  readonly lead: { readonly userId: string; readonly name: string } | null;
  readonly customer: { readonly personId: string; readonly name: string } | null;
  readonly property: { readonly recordId: string; readonly name: string } | null;
  readonly phases: { readonly count: number; readonly done: number };
  readonly nextVisitAt: string | null;
  readonly updatedAt: string;
}

export interface PhoneNow {
  /** The business's today, `YYYY-MM-DD`. */
  readonly today: string;
  readonly now: number;
}

function jobRow(copy: ContractorCopy, j: CopyJob, at: PhoneNow): PhoneJobRow {
  const late = isOpen(j.status) && j.dueOn && j.dueOn < at.today;
  const leadName = j.leadUserId ? copy.userNames.get(j.leadUserId) : undefined;
  const list = copy.phases.get(j.id) ?? [];
  const next = visitsOf(copy, j.id)
    .filter((v) => v.status !== 'cancelled' && v.endsAt > at.now)
    .reduce<number | null>((min, v) => (min === null || v.startsAt < min ? v.startsAt : min), null);
  return {
    id: j.id,
    name: j.name,
    kind: j.kind,
    status: j.status,
    statusAt: iso(j.statusAt),
    statusReason: j.statusReason,
    trade: j.trade,
    // Worked out as the server keeps it, so a phase moved on with no signal moves its project along at once.
    percentDone: jobPercent(j, list),
    startsOn: j.startsOn,
    dueOn: j.dueOn,
    daysLate: late ? daysBetween(j.dueOn!, at.today) : null,
    lead: j.leadUserId && leadName ? { userId: j.leadUserId, name: leadName } : null,
    customer: copy.customers.get(j.id) ?? null,
    property: copy.properties.get(j.id) ?? null,
    phases: { count: list.length, done: list.filter((p) => p.status === 'done').length },
    nextVisitAt: next === null ? null : iso(next),
    updatedAt: iso(j.updatedAt),
  };
}

/** Open jobs first, by deadline (none last), then the latest changed: the server's order. */
const byJobOrder = (a: CopyJob, b: CopyJob) =>
  Number(!isOpen(a.status)) - Number(!isOpen(b.status)) ||
  (a.dueOn === null
    ? b.dueOn === null
      ? 0
      : 1
    : b.dueOn === null
      ? -1
      : byText(a.dueOn, b.dueOn)) ||
  b.updatedAt - a.updatedAt;

export interface PhoneJobFilter {
  /** `mine`: jobs I lead or am on the team of. `late`: open jobs past their deadline. */
  readonly filter: 'all' | 'mine' | 'late';
  /** Done and cancelled ones too. */
  readonly includeClosed?: boolean;
  /** Words in its name, its customer's or its property's. */
  readonly search?: string;
  readonly me: string | null;
}

/** The business's jobs as `contractor.job.list` answers them. */
export function phoneJobList(
  copy: ContractorCopy,
  f: PhoneJobFilter,
  at: PhoneNow,
): { readonly jobs: PhoneJobRow[]; readonly truncated: boolean } {
  const words = (f.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const list = [...copy.jobs.values()].filter((j) => {
    if (j.archived) return false;
    if (!f.includeClosed && !isOpen(j.status)) return false;
    if (f.filter === 'mine')
      return !!f.me && (j.leadUserId === f.me || (copy.team.get(j.id) ?? []).includes(f.me));
    if (f.filter === 'late') return isOpen(j.status) && !!j.dueOn && j.dueOn < at.today;
    return true;
  });
  list.sort(byJobOrder);
  // The server reads one more than it answers, then looks for the words in those.
  const read = list.slice(0, PHONE_LIMITS.list + 1);
  let rows = read.map((j) => jobRow(copy, j, at));
  if (words.length)
    rows = rows.filter((r) => {
      const hay = [r.name, r.customer?.name, r.property?.name].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  return { jobs: rows.slice(0, PHONE_LIMITS.list), truncated: rows.length > PHONE_LIMITS.list };
}

export interface PhonePhase {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly status: PhaseStatus;
  readonly percentDone: number;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
  readonly doneAt: string | null;
  readonly daysLate: number | null;
}

/** One job whole, as `contractor.job.get` answers it, without its money. */
export interface PhoneJob extends PhoneJobRow {
  readonly details: string | null;
  readonly doneAt: string | null;
  readonly archived: boolean;
  readonly team: readonly { readonly userId: string; readonly name: string }[];
  readonly phaseList: readonly PhonePhase[];
  /** The newest first: the visits this phone keeps. */
  readonly visits: readonly PhoneVisit[];
}

export function phoneJob(copy: ContractorCopy, jobId: string, at: PhoneNow): PhoneJob | null {
  const j = copy.jobs.get(jobId);
  if (!j) return null;
  return {
    ...jobRow(copy, j, at),
    details: j.details,
    doneAt: j.doneAt === null ? null : iso(j.doneAt),
    archived: j.archived,
    team: (copy.team.get(jobId) ?? []).flatMap((userId) => {
      const name = copy.userNames.get(userId);
      return name ? [{ userId, name }] : [];
    }),
    phaseList: (copy.phases.get(jobId) ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      status: p.status,
      percentDone: p.status === 'done' ? 100 : p.percentDone,
      startsOn: p.startsOn,
      dueOn: p.dueOn,
      doneAt: p.doneAt === null ? null : iso(p.doneAt),
      daysLate:
        p.status !== 'done' && p.dueOn && p.dueOn < at.today
          ? daysBetween(p.dueOn, at.today)
          : null,
    })),
    visits: visitsOf(copy, jobId)
      .sort((a, b) => b.startsAt - a.startsAt)
      .slice(0, PHONE_LIMITS.visits)
      .map((v) => visitOut(copy, jobId, v)),
  };
}

// ---------- materials ----------

/** A material as everyone reads it: never with what it costs. */
export interface PhoneMaterial extends MaterialCounts {
  readonly id: string;
  readonly position: number;
  readonly name: string;
  readonly unitLabel: string;
  readonly appointmentId: string | null;
  readonly short: number;
  readonly left: number;
  readonly state: MaterialState;
  readonly supplier: string | null;
  readonly expectedOn: string | null;
  readonly note: string | null;
}

const materialOut = (m: CopyMaterial): PhoneMaterial => ({
  id: m.id,
  position: m.position,
  name: m.name,
  unitLabel: m.unitLabel,
  appointmentId: m.appointmentId,
  needed: m.needed,
  ordered: m.ordered,
  delivered: m.delivered,
  used: m.used,
  wasted: m.wasted,
  returned: m.returned,
  short: shortOf(m),
  left: leftOf(m),
  state: materialState(m),
  supplier: m.supplier,
  expectedOn: m.expectedOn,
  note: m.note,
});

/** A job's materials, or only what one visit needs, as `contractor.material.list` answers them without costs. */
export function phoneMaterials(
  copy: ContractorCopy,
  jobId: string,
  appointmentId?: string,
): { readonly materials: PhoneMaterial[]; readonly missing: number } {
  const list = (copy.materials.get(jobId) ?? [])
    .filter((m) => !appointmentId || neededOn(m, appointmentId))
    .map(materialOut);
  return { materials: list, missing: list.filter(isMissing).length };
}

// ---------- a work order ----------

export interface PhoneItem {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly kind: ItemKind;
  readonly required: boolean;
  readonly done: boolean;
  readonly doneAt: string | null;
  readonly doneBy: string | null;
  readonly file: { readonly id: string; readonly name: string } | null;
  readonly skipped: {
    readonly by: string | null;
    readonly at: string;
    readonly reason: string;
  } | null;
}

export interface PhoneSub {
  readonly personId: string;
  readonly name: string;
  readonly company: string | null;
  readonly canText: boolean;
  readonly toldAt: string | null;
  readonly done: boolean;
  readonly doneAt: string | null;
  readonly doneBy: string | null;
  readonly note: string | null;
}

/** A visit's work order, as `contractor.work_order.get` answers it. */
export interface PhoneWorkOrder {
  readonly appointmentId: string;
  readonly started: true;
  readonly visit: {
    readonly title: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: string;
    readonly stage: VisitStage;
    /** Its address, as its appointment's place says: the phone's own, for directions. */
    readonly location: string | null;
  };
  readonly job: {
    readonly id: string;
    readonly name: string;
    readonly kind: JobKind;
    readonly status: JobStatus;
    readonly trade: Trade | null;
    readonly details: string | null;
    readonly customer: { readonly personId: string; readonly name: string } | null;
    readonly property: { readonly recordId: string; readonly name: string } | null;
  };
  readonly crew: { readonly id: string; readonly name: string } | null;
  readonly people: readonly { readonly userId: string; readonly name: string }[];
  readonly subs: readonly PhoneSub[];
  readonly instructions: string | null;
  readonly bring: string | null;
  readonly items: readonly PhoneItem[];
  readonly progress: ChecklistProgress;
  readonly materials: readonly PhoneMaterial[];
}

/**
 * A visit's work order. Null when the phone doesn't have it: the visit isn't on a job, its work order hasn't
 * arrived yet, or its job has left phones.
 */
export function phoneWorkOrder(copy: ContractorCopy, appointmentId: string): PhoneWorkOrder | null {
  const order = copy.orders.get(appointmentId);
  const visit = copy.visits.get(appointmentId);
  const job = order ? copy.jobs.get(order.jobId) : undefined;
  if (!order || !visit || !job || job.archived) return null;
  const items = copy.items.get(appointmentId) ?? [];
  return {
    appointmentId,
    started: true,
    visit: {
      title: visit.title,
      startsAt: iso(visit.startsAt),
      endsAt: iso(visit.endsAt),
      status: visit.status,
      stage: stageOf(copy, visit),
      location: visit.location,
    },
    job: {
      id: job.id,
      name: job.name,
      kind: job.kind,
      status: job.status,
      trade: job.trade,
      details: job.details,
      customer: copy.customers.get(job.id) ?? null,
      property: copy.properties.get(job.id) ?? null,
    },
    crew: order.crewId ? { id: order.crewId, name: copy.crews.get(order.crewId) ?? 'Crew' } : null,
    people: (copy.staff.get(appointmentId) ?? []).flatMap((userId) => {
      const name = copy.userNames.get(userId);
      return name ? [{ userId, name }] : [];
    }),
    subs: (copy.subs.get(appointmentId) ?? []).flatMap((s) => {
      const contact = copy.contacts.get(s.personId);
      return contact
        ? [
            {
              personId: s.personId,
              ...contact,
              toldAt: s.toldAt === null ? null : iso(s.toldAt),
              done: s.doneAt !== null,
              doneAt: s.doneAt === null ? null : iso(s.doneAt),
              doneBy: s.doneBy ? (copy.userNames.get(s.doneBy) ?? null) : null,
              note: s.note,
            },
          ]
        : [];
    }),
    instructions: order.instructions,
    bring: order.bring,
    items: items.map((i) => {
      const file = i.fileId ? copy.files.get(i.fileId) : undefined;
      return {
        id: i.id,
        position: i.position,
        label: i.label,
        kind: i.kind,
        required: i.required,
        done: i.doneAt !== null,
        doneAt: i.doneAt === null ? null : iso(i.doneAt),
        doneBy: i.doneBy ? (copy.userNames.get(i.doneBy) ?? null) : null,
        file: i.fileId && file ? { id: i.fileId, name: file.name || 'Photo' } : null,
        skipped:
          i.skippedAt !== null && i.skipReason
            ? {
                by: i.skippedBy ? (copy.userNames.get(i.skippedBy) ?? null) : null,
                at: iso(i.skippedAt),
                reason: i.skipReason,
              }
            : null,
      };
    }),
    progress: progressOf(items),
    materials: phoneMaterials(copy, job.id, appointmentId).materials,
  };
}

// ---------- time ----------

export interface PhoneTimeEntry {
  readonly id: string;
  readonly userId: string | null;
  /** Null for someone who has left HandsFreeOS. */
  readonly name: string | null;
  readonly appointmentId: string | null;
  readonly kind: TimeKind;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly seconds: number;
  readonly source: TimeSource;
  readonly autoStopped: boolean;
  /** Someone who may fixed it. Who and why are on the web. */
  readonly fixed: boolean;
}

/** The time on a job, or on one of its visits, as `contractor.time.list` answers it. Never what it cost. */
export function phoneTime(
  copy: ContractorCopy,
  jobId: string,
  o: { readonly appointmentId?: string; readonly me: string | null; readonly now: number },
): {
  readonly entries: PhoneTimeEntry[];
  readonly totals: TimeTotals;
  readonly mine: {
    readonly entryId: string;
    readonly appointmentId: string | null;
    readonly kind: TimeKind;
  } | null;
  readonly truncated: boolean;
} {
  const all = (copy.time.get(jobId) ?? []).filter(
    (t) => !o.appointmentId || t.appointmentId === o.appointmentId,
  );
  const entries = all.slice(0, PHONE_LIMITS.timeEntries).map((t) => ({
    id: t.id,
    userId: t.userId,
    name: t.userId ? (copy.userNames.get(t.userId) ?? null) : null,
    appointmentId: t.appointmentId,
    kind: t.kind,
    startedAt: iso(t.startedAt),
    endedAt: t.endedAt === null ? null : iso(t.endedAt),
    seconds: secondsOf(t, o.now),
    source: t.source,
    autoStopped: t.autoStopped,
    fixed: t.fixed,
  }));
  const mine = o.me ? entries.find((e) => e.userId === o.me && e.endedAt === null) : undefined;
  return {
    entries,
    totals: totalsOf(all, o.now),
    mine: mine ? { entryId: mine.id, appointmentId: mine.appointmentId, kind: mine.kind } : null,
    truncated: all.length > PHONE_LIMITS.timeEntries,
  };
}

// ---------- notes ----------

export interface PhoneNote {
  readonly id: string;
  readonly appointmentId: string | null;
  readonly body: string | null;
  readonly audio: {
    readonly fileId: string | null;
    readonly transcript: string | null;
    readonly state: TranscriptState;
  } | null;
  readonly photoFileIds: readonly string[];
  readonly by: { readonly userId: string; readonly name: string } | null;
  readonly notedAt: string;
}

/** A job's notes from the field, the newest first, as `contractor.note.list` answers them. */
export function phoneNotes(
  copy: ContractorCopy,
  jobId: string,
  appointmentId?: string,
): { readonly notes: PhoneNote[]; readonly truncated: boolean } {
  const all = (copy.notes.get(jobId) ?? []).filter(
    (n) => !appointmentId || n.appointmentId === appointmentId,
  );
  return {
    notes: all.slice(0, NOTE_LIMITS.list).map((n) => {
      const by = n.createdBy ? copy.userNames.get(n.createdBy) : undefined;
      return {
        id: n.id,
        appointmentId: n.appointmentId,
        body: n.body,
        audio:
          n.transcriptState === 'none'
            ? null
            : {
                fileId: n.audioFileId && copy.files.has(n.audioFileId) ? n.audioFileId : null,
                transcript: n.transcript,
                state: n.transcriptState,
              },
        photoFileIds: n.photoFileIds.filter((id) => copy.files.has(id)),
        by: n.createdBy && by ? { userId: n.createdBy, name: by } : null,
        notedAt: iso(n.notedAt),
      };
    }),
    truncated: all.length > NOTE_LIMITS.list,
  };
}

// ---------- my day ----------

/** A visit on a job in a day's list, as dispatch answers each. */
export interface PhoneDayVisit {
  readonly appointmentId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly stage: VisitStage;
  readonly job: { readonly id: string; readonly name: string; readonly status: JobStatus };
  readonly customer: string | null;
  readonly property: string | null;
  readonly crew: string | null;
  readonly userIds: readonly string[];
  readonly subs: { readonly total: number; readonly done: number };
  readonly checklist: ChecklistProgress | null;
  readonly materialsMissing: number;
}

/**
 * The visits on jobs that touch a stretch of time (a day, from its first moment to the next day's), the earliest
 * first, as `contractor.dispatch` answers them; `me` keeps to the ones that person is on.
 */
export function phoneDayVisits(
  copy: ContractorCopy,
  o: { readonly from: number; readonly to: number; readonly me?: string | null },
): PhoneDayVisit[] {
  const out: (PhoneDayVisit & { readonly at: number })[] = [];
  for (const order of copy.orders.values()) {
    const v = copy.visits.get(order.appointmentId);
    const job = copy.jobs.get(order.jobId);
    if (!v || !job || job.archived || v.status === 'cancelled') continue;
    if (!(v.startsAt < o.to && v.endsAt > o.from)) continue;
    const userIds = copy.staff.get(v.id) ?? [];
    if (o.me && !userIds.includes(o.me)) continue;
    const subs = copy.subs.get(v.id) ?? [];
    out.push({
      at: v.startsAt,
      appointmentId: v.id,
      title: v.title,
      startsAt: iso(v.startsAt),
      endsAt: iso(v.endsAt),
      stage: stageOf(copy, v),
      job: { id: job.id, name: job.name, status: job.status },
      customer: copy.customers.get(job.id)?.name ?? null,
      property: copy.properties.get(job.id)?.name ?? null,
      crew: order.crewId ? (copy.crews.get(order.crewId) ?? null) : null,
      userIds,
      subs: { total: subs.length, done: subs.filter((s) => s.doneAt !== null).length },
      checklist: progressOf(copy.items.get(v.id) ?? []),
      materialsMissing: missingOn(copy, job.id, v.id),
    });
  }
  return out
    .sort((a, b) => a.at - b.at || byText(a.appointmentId, b.appointmentId))
    .map(({ at: _at, ...v }) => v);
}
