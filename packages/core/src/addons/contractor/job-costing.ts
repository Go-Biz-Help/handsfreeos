/**
 * What a job is costing (docs/contractor.md, "Time and job costing"; the owner's decisions 10 and 11): what was
 * planned, what's been spent so far, and what it's heading for, for labor, materials and everything else, and the
 * profit that leaves. One copy of this math, which the job's page, the profit page and the AI all read. Pure and
 * browser-safe.
 *
 * - **So far** is what's recorded: time tracked at what each hour cost, materials the job has taken at what each
 *   costs, and the other costs someone typed in.
 * - **Heading for** is where the cost ends up if the job goes on as it has. Labor is paced by the job's own % done
 *   (half done with 6 hours spent heads for 12). Materials and other costs head for the larger of the plan and
 *   what's spent, since they're bought in lumps. A finished job heads for exactly what it cost.
 */
import type { JobStatus } from './progress';

/** The least a job must be along before its % done says anything about its pace. */
export const PACE_FROM_PERCENT = 10;

export interface CostingBudget {
  readonly priceCents: number | null;
  readonly laborCents: number | null;
  readonly materialsCents: number | null;
  readonly otherCents: number | null;
  readonly laborHours: number | null;
}

export interface CostingActual {
  /** Time tracked (work and travel) at what each hour cost. */
  readonly laborCents: number;
  /** Work and travel time, in seconds. */
  readonly laborSeconds: number;
  /** Of that, the time nobody has put a cost on. */
  readonly uncostedSeconds: number;
  /** What the job has taken of its materials, at what each costs. */
  readonly materialsCents: number;
  /** What the whole materials list would cost. */
  readonly materialsPlannedCents: number;
  /** Materials with no cost yet. */
  readonly uncostedMaterials: number;
  readonly otherCents: number;
}

export interface CostLine {
  /** What was planned; null when nobody set it. */
  readonly budgetCents: number | null;
  readonly actualCents: number;
  readonly headingCents: number;
}

export interface JobCosting {
  readonly labor: CostLine;
  readonly materials: CostLine;
  readonly other: CostLine;
  readonly total: CostLine;
  readonly hours: {
    readonly budget: number | null;
    readonly actual: number;
    readonly heading: number;
  };
  readonly priceCents: number | null;
  readonly profit: {
    readonly plannedCents: number | null;
    readonly plannedMarginBp: number | null;
    /** The price less what's been spent so far. */
    readonly soFarCents: number | null;
    readonly headingCents: number | null;
    readonly headingMarginBp: number | null;
  };
  /** How far over its planned cost it's heading; 0 when it isn't, null when no cost was planned. */
  readonly overCents: number | null;
  /** The job is done or cancelled: what it's heading for is what it cost. */
  readonly finished: boolean;
  readonly uncostedHours: number;
  readonly uncostedMaterials: number;
}

const marginBp = (profitCents: number, priceCents: number | null) =>
  priceCents !== null && priceCents > 0 ? Math.round((profitCents / priceCents) * 10_000) : null;

const hours = (seconds: number) => Math.round(seconds / 36) / 100;

/** Where something paced by the job's progress ends up: what's spent, scaled to the whole job. */
function paced(actual: number, budget: number | null, percentDone: number): number {
  if (actual > 0 && percentDone >= PACE_FROM_PERCENT && percentDone < 100)
    return Math.max(actual, Math.round((actual * 100) / percentDone));
  return Math.max(budget ?? 0, actual);
}

export function costJob(
  job: { readonly status: JobStatus; readonly percentDone: number },
  budget: CostingBudget,
  actual: CostingActual,
): JobCosting {
  const finished = job.status === 'done' || job.status === 'cancelled';
  const heading = {
    labor: finished
      ? actual.laborCents
      : paced(actual.laborCents, budget.laborCents, job.percentDone),
    materials: finished
      ? actual.materialsCents
      : Math.max(budget.materialsCents ?? 0, actual.materialsPlannedCents, actual.materialsCents),
    other: finished ? actual.otherCents : Math.max(budget.otherCents ?? 0, actual.otherCents),
  };
  const planned = [budget.laborCents, budget.materialsCents, budget.otherCents].filter(
    (n): n is number => n !== null,
  );
  const budgetTotal = planned.length ? planned.reduce((a, n) => a + n, 0) : null;
  const actualTotal = actual.laborCents + actual.materialsCents + actual.otherCents;
  const headingTotal = heading.labor + heading.materials + heading.other;
  const price = budget.priceCents;
  const plannedProfit = price !== null && budgetTotal !== null ? price - budgetTotal : null;
  const headingProfit = price !== null ? price - headingTotal : null;
  const budgetSeconds = budget.laborHours === null ? null : Math.round(budget.laborHours * 3600);
  return {
    labor: {
      budgetCents: budget.laborCents,
      actualCents: actual.laborCents,
      headingCents: heading.labor,
    },
    materials: {
      budgetCents: budget.materialsCents,
      actualCents: actual.materialsCents,
      headingCents: heading.materials,
    },
    other: {
      budgetCents: budget.otherCents,
      actualCents: actual.otherCents,
      headingCents: heading.other,
    },
    total: { budgetCents: budgetTotal, actualCents: actualTotal, headingCents: headingTotal },
    hours: {
      budget: budget.laborHours,
      actual: hours(actual.laborSeconds),
      heading: hours(
        finished ? actual.laborSeconds : paced(actual.laborSeconds, budgetSeconds, job.percentDone),
      ),
    },
    priceCents: price,
    profit: {
      plannedCents: plannedProfit,
      plannedMarginBp: plannedProfit === null ? null : marginBp(plannedProfit, price),
      soFarCents: price === null ? null : price - actualTotal,
      headingCents: headingProfit,
      headingMarginBp: headingProfit === null ? null : marginBp(headingProfit, price),
    },
    overCents: budgetTotal === null ? null : Math.max(0, headingTotal - budgetTotal),
    finished,
    uncostedHours: hours(actual.uncostedSeconds),
    uncostedMaterials: actual.uncostedMaterials,
  };
}

/** A job heading under the business's lowest margin, or for a loss: worth a look before it's too late. */
export const headsUnderMargin = (c: JobCosting, minMarginBp: number): boolean =>
  c.profit.headingMarginBp !== null && c.profit.headingMarginBp < minMarginBp;

// ------------------------------------------------------------------------------------------------ the profit page

/** How the profit page can be split. "Service" is the job's trade: the kind of work it was. */
export const PROFIT_GROUPS = ['job', 'customer', 'crew', 'trade'] as const;
export type ProfitGroup = (typeof PROFIT_GROUPS)[number];

/** Which jobs the profit page counts: done in a stretch of time, or still open (what they're heading for). */
export const PROFIT_PERIODS = ['month', 'last_month', 'quarter', 'year', 'all', 'open'] as const;
export type ProfitPeriod = (typeof PROFIT_PERIODS)[number];

/**
 * The days a period covers, first to last, given the business's today (`YYYY-MM-DD`): whole calendar months,
 * quarters and years. Null for all time and for open jobs, which no days bound.
 */
export function periodOf(
  period: ProfitPeriod,
  today: string,
): { readonly from: string; readonly to: string } | null {
  if (period === 'all' || period === 'open') return null;
  const [y = 1970, m = 1] = today.split('-').map(Number);
  // Months overflow on purpose: month 13 is next January, and day 0 of a month is the last day of the one before.
  const day = (yy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  if (period === 'month') return { from: day(y, m, 1), to: day(y, m + 1, 0) };
  if (period === 'last_month') return { from: day(y, m - 1, 1), to: day(y, m, 0) };
  if (period === 'quarter') {
    const first = Math.floor((m - 1) / 3) * 3 + 1;
    return { from: day(y, first, 1), to: day(y, first + 3, 0) };
  }
  return { from: day(y, 1, 1), to: day(y, 12, 31) };
}

/** One job as the profit page counts it: its price, what it cost (or is heading for), and who and what it was. */
export interface ProfitJob {
  readonly jobId: string;
  readonly name: string;
  readonly priceCents: number;
  readonly costCents: number;
  readonly laborSeconds: number;
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly crew: { readonly id: string; readonly name: string } | null;
  readonly trade: string | null;
}

export interface ProfitRow {
  /** The job, customer, crew or trade; null for the jobs that have none. */
  readonly key: string | null;
  readonly name: string | null;
  readonly jobs: number;
  readonly priceCents: number;
  readonly costCents: number;
  readonly profitCents: number;
  readonly marginBp: number | null;
  readonly laborHours: number;
}

const rowOf = (key: string | null, name: string | null, list: readonly ProfitJob[]): ProfitRow => {
  const price = list.reduce((a, j) => a + j.priceCents, 0);
  const cost = list.reduce((a, j) => a + j.costCents, 0);
  return {
    key,
    name,
    jobs: list.length,
    priceCents: price,
    costCents: cost,
    profitCents: price - cost,
    marginBp: marginBp(price - cost, price),
    laborHours: hours(list.reduce((a, j) => a + j.laborSeconds, 0)),
  };
};

/** Every job counted once, as one line. */
export const profitTotal = (list: readonly ProfitJob[]): ProfitRow => rowOf(null, null, list);

/**
 * The jobs split by job, customer, crew or trade, the most profit first. Each job counts in one row only, so the
 * rows add up to the total; a job with no customer, crew or trade goes in a row of its own kind (key null).
 */
export function groupProfit(list: readonly ProfitJob[], by: ProfitGroup): ProfitRow[] {
  const groups = new Map<string, { key: string | null; name: string | null; jobs: ProfitJob[] }>();
  for (const j of list) {
    const of =
      by === 'job'
        ? { id: j.jobId, name: j.name }
        : by === 'customer'
          ? j.customer
          : by === 'crew'
            ? j.crew
            : j.trade
              ? { id: j.trade, name: j.trade }
              : null;
    const k = of?.id ?? '';
    const g = groups.get(k) ?? { key: of?.id ?? null, name: of?.name ?? null, jobs: [] };
    g.jobs.push(j);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => rowOf(g.key, g.name, g.jobs))
    .sort((a, b) => b.profitCents - a.profitCents || (a.name ?? '￿').localeCompare(b.name ?? '￿'));
}
