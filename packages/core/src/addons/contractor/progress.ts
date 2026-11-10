/**
 * Where a job stands (docs/contractor.md): its status, how far along it is, whether it's late, and its budget's
 * total. One copy of these rules, which the server keeps on each job and both apps and the AI read. Pure and
 * browser-safe.
 *
 * A job is a **service call** (one visit or a few, one piece of work) until it has phases; then it's a **project**
 * (the owner's decision 2, 2026-11-10). A project's % done is the average of its phases' (a done phase counts 100);
 * a service call's is what someone set, and 100 once it's done.
 */

export const JOB_KINDS = ['service', 'project'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  'new',
  'scheduled',
  'in_progress',
  'on_hold',
  'done',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that need a reason: why it's waiting, why it was called off. */
export const STATUSES_WITH_REASON: readonly JobStatus[] = ['on_hold', 'cancelled'];

/** Still being worked: shown on the board, counted as late when past its deadline. */
export const OPEN_STATUSES: readonly JobStatus[] = ['new', 'scheduled', 'in_progress', 'on_hold'];
export const isOpen = (s: JobStatus) => OPEN_STATUSES.includes(s);

export const PHASE_STATUSES = ['not_started', 'in_progress', 'done'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export interface PhaseProgress {
  readonly status: PhaseStatus;
  readonly percentDone: number;
}

const clampPercent = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** A phase's % as it counts: a done phase is 100, whatever was typed. */
export const phasePercent = (p: PhaseProgress) =>
  p.status === 'done' ? 100 : clampPercent(p.percentDone);

/** A project's % done: the average of its phases', rounded. No phases: 0. */
export function projectPercent(phases: readonly PhaseProgress[]): number {
  if (!phases.length) return 0;
  return clampPercent(phases.reduce((sum, p) => sum + phasePercent(p), 0) / phases.length);
}

/** A job's % done, as it's kept on the job: from its phases for a project, else what was set (100 once done). */
export function jobPercent(
  job: { readonly kind: JobKind; readonly status: JobStatus; readonly percentDone: number },
  phases: readonly PhaseProgress[],
): number {
  if (job.status === 'done') return 100;
  if (job.kind === 'project' && phases.length) return projectPercent(phases);
  return clampPercent(job.percentDone);
}

/** The status a phase takes from its %: 100 is done, anything above 0 has started. */
export function phaseStatusFromPercent(percent: number): PhaseStatus {
  const p = clampPercent(percent);
  return p >= 100 ? 'done' : p > 0 ? 'in_progress' : 'not_started';
}

/** The % a phase shows once its status is set by hand: done is 100; back to not started is 0. */
export function phasePercentFromStatus(status: PhaseStatus, percent: number): number {
  if (status === 'done') return 100;
  if (status === 'not_started') return 0;
  const p = clampPercent(percent);
  return p >= 100 ? 90 : p;
}

/**
 * The business's today, as `YYYY-MM-DD`, in its time zone: deadlines are days, and a job due today isn't late until
 * the day is over there.
 */
export function todayIn(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Past its deadline and not finished. Days compare as `YYYY-MM-DD` text. */
export const isLate = (dueOn: string | null, finished: boolean, today: string) =>
  !!dueOn && !finished && dueOn < today;

/** Whole days between two `YYYY-MM-DD` days (b − a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** A job's budget, as it's set: what each part should cost, in cents, and the labor hours. */
export interface JobBudget {
  readonly laborCents: number | null;
  readonly materialsCents: number | null;
  readonly otherCents: number | null;
}

/** What it all should cost; null when nothing was set. */
export function budgetTotal(b: JobBudget): number | null {
  const parts = [b.laborCents, b.materialsCents, b.otherCents].filter(
    (n): n is number => n !== null,
  );
  return parts.length ? parts.reduce((a, n) => a + n, 0) : null;
}

/**
 * The profit the job was priced for: its price less what it should cost, and that as a share of the price (basis
 * points, 2,500 is 25%). Null when either is missing.
 */
export function plannedProfit(
  priceCents: number | null,
  b: JobBudget,
): { readonly cents: number; readonly marginBp: number | null } | null {
  const cost = budgetTotal(b);
  if (priceCents === null || cost === null) return null;
  const cents = priceCents - cost;
  return { cents, marginBp: priceCents > 0 ? Math.round((cents / priceCents) * 10_000) : null };
}
