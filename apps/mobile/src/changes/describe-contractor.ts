import { JOB_STATUS_WORDS, PHASE_STATUS_WORDS } from '@hfos/core/addons/contractor/words';

import type { ChangeIcon } from './describe';
import type { SqlRunner } from './outbox';

/**
 * Words for Contractor Operations' changes made on the phone (docs/contractor.md, "On the phone"), as Changes on this
 * phone and the Sign out? sheet say them: "Ticked “Photo of the panel”", "Counted 12/2 wire", "Started a break",
 * "Voice note from the field", "“Rough-in” marked done", each about its job, so Changes groups them under it
 * ("3 changes for Hart kitchen remodel"). What a change points at is named from the phone's copy: the job's record,
 * and the checklist item, material or phase it's for.
 */

export interface ContractorNames {
  /** A job's name. */
  job(id: string | null): string | null;
  /** One of the add-on's rows on a job (`work_order_items`, `materials`, `phases`…): its job and its columns. */
  row(
    source: string,
    id: string | null,
  ): { readonly jobId: string | null; readonly data: Readonly<Record<string, unknown>> } | null;
}

export const NO_CONTRACTOR_NAMES: ContractorNames = { job: () => null, row: () => null };

export interface ContractorWords {
  readonly title: string;
  readonly part: string;
  readonly icon: ChangeIcon;
  readonly quote: string | null;
  /** The job it's about, when the phone's copy names it. */
  readonly job: { readonly id: string; readonly name: string } | null;
  readonly heldUntil: string;
}

type Input = Readonly<Record<string, unknown>>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
const wordsOf = <K extends string>(table: Readonly<Record<K, string>>, key: unknown) =>
  typeof key === 'string' && key in table ? table[key as K].toLowerCase() : null;

/** The phone's rows a change's input points at, by the input's key (`addon_phone_rows` sources). */
const POINTS = {
  itemId: 'work_order_items',
  materialId: 'materials',
  phaseId: 'phases',
  noteId: 'notes',
  // A visit's work order is named for the visit's appointment.
  appointmentId: 'work_orders',
} as const;

export function describeContractor(
  name: string,
  input: Input,
  names: ContractorNames,
): ContractorWords | null {
  if (!name.startsWith('contractor.')) return null;
  const pointed = (key: keyof typeof POINTS) => names.row(POINTS[key], str(input[key]));
  const words = (
    title: string,
    part: string,
    icon: ChangeIcon,
    jobId: string | null | undefined,
    quote: string | null = null,
  ): ContractorWords => {
    const jobName = names.job(jobId ?? null);
    return {
      title,
      part,
      icon,
      quote,
      job: jobId && jobName ? { id: jobId, name: jobName } : null,
      heldUntil: `${lower(title)} goes through`,
    };
  };
  switch (name) {
    case 'contractor.work_order.item_set': {
      const item = pointed('itemId');
      const label = str(item?.data.label);
      const what = label ? `“${label}”` : 'a checklist item';
      return input.done === false
        ? words(`Unticked ${what}`, 'a checklist item unticked', 'task', item?.jobId)
        : words(`Ticked ${what}`, 'a checklist item ticked', 'task', item?.jobId);
    }
    case 'contractor.material.count': {
      const material = pointed('materialId');
      return words(
        `Counted ${str(material?.data.name) ?? 'materials used'}`,
        'a count of materials',
        'item',
        material?.jobId,
      );
    }
    case 'contractor.time.set_break': {
      const jobId = pointed('appointmentId')?.jobId;
      return input.onBreak === false
        ? words('Back to work after a break', 'back to work', 'calendar', jobId)
        : words('Started a break', 'a break', 'calendar', jobId);
    }
    case 'contractor.note.add': {
      const body = str(input.body);
      const photos = Array.isArray(input.photoFileIds) && input.photoFileIds.length > 0;
      const jobId = str(input.jobId);
      if (str(input.audioFileId))
        return words('Voice note from the field', 'a voice note', 'note', jobId);
      if (photos && !body) return words('Photo from the field', 'a photo', 'photo', jobId);
      return words('Note from the field', 'a note', 'note', jobId, body);
    }
    case 'contractor.note.remove':
      return words('Removed a note', 'a note removed', 'note', pointed('noteId')?.jobId);
    case 'contractor.job.set_percent': {
      const p = typeof input.percentDone === 'number' ? Math.round(input.percentDone) : null;
      return words(
        p === null ? 'Set how far along a job is' : `Marked ${p}% done`,
        '% done',
        'task',
        str(input.jobId),
      );
    }
    case 'contractor.job.set_status': {
      const status = wordsOf(JOB_STATUS_WORDS, input.status);
      return words(
        status ? `Marked ${status}` : 'Changed a job’s status',
        'the job’s status',
        'task',
        str(input.jobId),
      );
    }
    case 'contractor.phase.update': {
      const phase = pointed('phaseId');
      const what = str(phase?.data.name);
      const status = wordsOf(PHASE_STATUS_WORDS, input.status);
      return words(
        what && status
          ? `“${what}” marked ${status}`
          : what
            ? `Moved “${what}” along`
            : 'Moved a phase along',
        'a phase moved along',
        'task',
        phase?.jobId,
      );
    }
    default:
      return words('A change in Contractor Operations', 'a change', 'change', str(input.jobId));
  }
}

/** The jobs and rows the changes name, from the phone's copy. */
export async function loadContractorNames(
  runner: SqlRunner,
  inputs: readonly Input[],
): Promise<ContractorNames> {
  const rowIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const input of inputs) {
    for (const [key, source] of Object.entries(POINTS)) {
      const id = str(input[key]);
      if (id) rowIds.add(`${source}:${id}`);
    }
    // A photo or a recording kept for a job is on its record.
    const job =
      str(input.jobId) ?? (input.recordType === 'custom_record' ? str(input.recordId) : null);
    if (job) jobIds.add(job);
  }
  if (rowIds.size === 0 && jobIds.size === 0) return NO_CONTRACTOR_NAMES;
  const select = <T>(sql: string, set: Set<string>): Promise<T[]> =>
    set.size === 0
      ? Promise.resolve([])
      : runner.getAll<T>(sql.replace('(?)', `(${[...set].map(() => '?').join(', ')})`), [...set]);
  const ROWS =
    "SELECT id, record_id, data FROM addon_phone_rows WHERE addon_id = 'contractor' AND id IN (?)";
  const byRow = new Map<string, { jobId: string | null; data: Record<string, unknown> }>();
  for (const r of await select<{ id: string; record_id: string | null; data: string | null }>(
    ROWS,
    rowIds,
  )) {
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(r.data ?? '{}');
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
    byRow.set(r.id, { jobId: r.record_id, data });
    if (r.record_id) jobIds.add(r.record_id);
  }
  const jobs = await select<{ id: string; name: string | null }>(
    'SELECT id, name FROM custom_records WHERE id IN (?)',
    jobIds,
  );
  const byJob = new Map(jobs.map((j) => [j.id, j.name]));
  return {
    job: (id) => (id ? (byJob.get(id) ?? null) : null),
    row: (source, id) => (id ? (byRow.get(`${source}:${id}`) ?? null) : null),
  };
}
