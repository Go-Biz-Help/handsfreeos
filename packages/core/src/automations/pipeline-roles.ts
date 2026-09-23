/**
 * "Move deals along for you": which of a business's own stages means what. Browser-safe.
 *
 * A deal moves when something happens that its stage hasn't caught up with: someone got back to them
 * (`contacted`), a quote went out (`quoted`), a visit was booked (`booked`), or the customer said yes, by accepting
 * the quote or having the job done (`won`, the pipeline's won stage). Each open stage's role is guessed from its
 * name ("Estimate sent" is `quoted`), and the business can fix a guess in the row's Adjust sheet. A stage with no
 * role is never moved into.
 *
 * Forward only: a deal moves to a stage later than the one it's in, never back, and never out of won or lost.
 */

export const STAGE_ROLES = ['contacted', 'quoted', 'booked'] as const;
export type StageRole = (typeof STAGE_ROLES)[number];
/** What happened, in the order a deal usually goes. `won` is the pipeline's won stage. */
export type DealStep = StageRole | 'won';
export const DEAL_STEPS: readonly DealStep[] = [...STAGE_ROLES, 'won'];

export const STAGE_ROLE_LABELS: Readonly<Record<StageRole, string>> = {
  contacted: 'Someone got back to them',
  quoted: 'A quote went out',
  booked: 'A visit was booked',
};

const GUESSES: ReadonlyArray<readonly [StageRole, RegExp]> = [
  // Checked in this order: "Quote after site visit" is about the quote.
  ['quoted', /\b(estimate|quot(e|ed|ing)|proposal|bid|pric(e|ed|ing))/i],
  [
    'booked',
    /\b(book|schedul|appointment|visit|consult|inspection|walkthrough|walk-through|job set)/i,
  ],
  [
    'contacted',
    /\b(contact|reached|respon|replied|spoke|talk|engag|in touch|conversation|follow)/i,
  ],
];

/** A stage's role, from its name alone; null when the name says none of them ("New", "Qualified"). */
export function guessStageRole(name: string): StageRole | null {
  for (const [role, pattern] of GUESSES) if (pattern.test(name)) return role;
  return null;
}

export interface RoleStage {
  readonly id: string;
  readonly name: string;
  readonly kind: 'open' | 'won' | 'lost';
  readonly position: number;
}

/** The business's own choice for a stage: a role, or `none` for "never move a deal here". */
export type RoleOverride = StageRole | 'none';

/** Each open stage's role: the business's choice where it made one, else the guess from the name. */
export function stageRoleOf(
  stage: RoleStage,
  overrides: Readonly<Record<string, RoleOverride>>,
): StageRole | null {
  if (stage.kind !== 'open') return null;
  const chosen = overrides[stage.id];
  if (chosen === 'none') return null;
  return chosen ?? guessStageRole(stage.name);
}

/**
 * Where each step leads in one pipeline: the first open stage with that role, and the first won stage for `won`.
 * A step with no stage is missing from the map.
 */
export function stepStages(
  stages: readonly RoleStage[],
  overrides: Readonly<Record<string, RoleOverride>>,
): Partial<Record<DealStep, RoleStage>> {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const out: Partial<Record<DealStep, RoleStage>> = {};
  for (const s of sorted) {
    if (s.kind === 'won') {
      out.won ??= s;
      continue;
    }
    const role = stageRoleOf(s, overrides);
    if (role) out[role] ??= s;
  }
  return out;
}

/** Something that happened to a deal: which step, when, and in words for its timeline ("Quote 1042 went out"). */
export interface DealEvidence {
  readonly step: DealStep;
  readonly at: number;
  readonly why: string;
}

export interface DealMove {
  readonly stage: RoleStage;
  readonly step: DealStep;
  readonly why: string;
  readonly at: number;
}

/**
 * The move a deal is owed, or null. The furthest step that happened after the deal entered its stage (so a deal
 * someone moved back by hand stays where they put it until something new happens), whose stage is later than the
 * one it's in. Won and lost deals never move.
 */
export function dealMoveOf(
  deal: {
    readonly status: 'open' | 'won' | 'lost';
    readonly stageId: string;
    readonly stageEnteredAt: number;
  },
  stages: readonly RoleStage[],
  overrides: Readonly<Record<string, RoleOverride>>,
  evidence: readonly DealEvidence[],
): DealMove | null {
  if (deal.status !== 'open') return null;
  const current = stages.find((s) => s.id === deal.stageId);
  if (!current) return null;
  const targets = stepStages(stages, overrides);
  let best: DealMove | null = null;
  for (const e of evidence) {
    if (e.at <= deal.stageEnteredAt) continue;
    const stage = targets[e.step];
    if (!stage) continue;
    // Won is always ahead of any open stage, whatever its position on the board.
    const ahead = stage.kind === 'won' || stage.position > current.position;
    if (!ahead) continue;
    const further =
      !best ||
      (stage.kind === 'won' ? 1 : 0) > (best.stage.kind === 'won' ? 1 : 0) ||
      (stage.kind === best.stage.kind && stage.position > best.stage.position);
    if (further) best = { stage, step: e.step, why: e.why, at: e.at };
  }
  return best;
}
