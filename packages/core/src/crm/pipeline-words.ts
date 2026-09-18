/**
 * The pipeline: its totals, a lead card's lines, moving a lead, and the words on a lead's own page (M10 step 15).
 * Browser-safe, so the board on the web and one stage at a time on the phone agree.
 *
 * The totals were worked out twice — once in `lead.board`'s handler and once again in the web's board when it moved
 * a card — and the words were inline in `components/pipeline/*`. Both are here now.
 */
import { money } from '../money/format';
import { daysSince, formatDate, timeOfDay } from './format';

export type StageKind = 'open' | 'won' | 'lost';

export interface StageRef {
  readonly id: string;
  readonly name: string;
  readonly kind: StageKind;
  readonly position: number;
}

export interface LeadOnBoard {
  readonly id: string;
  readonly stageId: string;
  readonly valueCents: number;
}

export interface StageWithLeads<L extends LeadOnBoard> extends StageRef {
  readonly count: number;
  readonly valueCents: number;
  /** Mutable, so a query's answer (whose arrays are plain) can be built straight from it. */
  readonly leads: L[];
}

/** Each stage with the leads in it, how many, and what they come to — the board's one piece of arithmetic. */
export function boardStages<L extends LeadOnBoard>(
  stages: readonly StageRef[],
  leads: readonly L[],
): StageWithLeads<L>[] {
  return stages.map((s) => {
    const inStage = leads.filter((l) => l.stageId === s.id);
    return {
      ...s,
      count: inStage.length,
      valueCents: inStage.reduce((a, l) => a + l.valueCents, 0),
      leads: inStage,
    };
  });
}

/** "4 open leads · $21,850" over the board, from the open stages only. */
export function pipelineSummary(openCount: number, openValueCents: number): string {
  return `${openCount} open lead${openCount === 1 ? '' : 's'} · ${money(openValueCents)}`;
}

/** "4 leads · $21,850" under a stage's name on the phone. */
export function stageTotals(count: number, valueCents: number): string {
  return `${count} lead${count === 1 ? '' : 's'} · ${money(valueCents)}`;
}

/**
 * How long a lead has been in its stage, as the canvas's card reads it: "21 min ago" and "1 h ago" while it's fresh,
 * "today" for the rest of the day it arrived, then "2 days in stage".
 */
export function stageAgeWords(stageEnteredAt: string, now = Date.now()): string {
  const at = new Date(stageEnteredAt).getTime();
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 4) return `${hours} h ago`;
  const days = daysSince(stageEnteredAt, now);
  if (days === 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'} in stage`;
}

/** The lead card's second line: "Website form · 21 min ago", or just one of them. */
export function leadCardWhen(
  source: string | null | undefined,
  stageEnteredAt: string,
  now = Date.now(),
): string {
  return [source?.trim() || null, stageAgeWords(stageEnteredAt, now)].filter(Boolean).join(' · ');
}

/** "New AC install won.", "New AC install marked lost.", "New AC install moved to Contacted." */
export function moveToast(leadTitle: string, stage: Pick<StageRef, 'name' | 'kind'>): string {
  if (stage.kind === 'won') return `${leadTitle} won.`;
  if (stage.kind === 'lost') return `${leadTitle} marked lost.`;
  return `${leadTitle} moved to ${stage.name}.`;
}

export interface MoveChoice {
  readonly id: string;
  readonly name: string;
  readonly kind: StageKind;
  /** "Now" for the stage it is in, "Marks it won", "Asks why" for Lost. */
  readonly note: string | null;
  readonly current: boolean;
}

/** The Move to… sheet: every stage of this lead's pipeline, with what the unusual ones do. */
export function moveChoices(
  stages: readonly StageRef[],
  currentStageId: string,
): readonly MoveChoice[] {
  return stages.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    current: s.id === currentStageId,
    note:
      s.id === currentStageId
        ? 'Now'
        : s.kind === 'won'
          ? 'Marks it won'
          : s.kind === 'lost'
            ? 'Asks why'
            : null,
  }));
}

/** "Move New AC install to…" and the line under it: "Maria Lopez · $18,500 · Sales". */
export function moveSheetTitle(leadTitle: string): string {
  return `Move ${leadTitle} to…`;
}
export function moveSheetSubtitle(
  who: string | null,
  valueCents: number,
  pipelineName: string,
): string {
  return [who?.trim() || null, money(valueCents), pipelineName].filter(Boolean).join(' · ');
}

/** The latest real contact either way: "Today", "Yesterday", "2 days ago", or "No contact yet". */
export function lastContactWords(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'No contact yet';
  const days = daysSince(iso, now);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
}

export const PIPELINE_WORDS = {
  title: 'Pipeline',
  newLead: 'New lead',
  noLeadsTitle: 'No leads yet',
  noLeadsBody:
    'A lead is a job you might win. Add one for a person or company and move it across the stages.',
  dropHere: 'Drop a lead here',
  moveTo: 'Move to…',
  /** Under the Move to… sheet, where a stage move made with no signal is explained. */
  moveOffline:
    'Works with no signal. If someone moves it first, theirs stands and the phone tells you why yours didn’t go.',
  cancel: 'Cancel',
  won: 'Won',
  lost: 'Lost',
  reopen: 'Reopen',
  /** The next action, as the web words it. */
  nextPrefix: 'Next:',
  noFollowUp: 'No follow-up scheduled',
  noFollowUpDot: 'No follow-up scheduled.',
  goCold: 'Leads without a next action go cold.',
  noneCompact: 'None',
  change: 'Change',
  set: 'Set',
  setNextAction: 'Set a next action',
  nextActionPlaceholder: 'What is next? e.g. Call Mike',
  /** The canvas's words on the phone's lead page, where there is room for a sentence. */
  noNextAction: 'No next action',
  sayWhatHappens: 'Say what happens next, and when',
  nextActionSet: 'Next action set.',
  /** The lead page's own labels. */
  customer: 'Customer',
  assigned: 'Assigned',
  source: 'Source',
  inStageSince: 'In stage',
  lastContact: 'Last contact',
  expectedClose: 'Expected close',
  tags: 'Tags',
  latest: 'Latest',
  archiveLead: 'Archive lead',
  restoreLead: 'Restore lead',
  leadArchived: 'Lead archived.',
  leadRestored: 'Lead restored.',
  wonNote: 'Jobs and invoices arrive in a later milestone.',
  lostPrefix: 'Lost:',
} as const;

/** "Since 7:51 AM today" under In stage on the lead's page, else "Since Sep 14". */
export function inStageSince(stageEnteredAt: string, now = Date.now()): string {
  const at = new Date(stageEnteredAt);
  if (Number.isNaN(at.getTime())) return '';
  return at.toDateString() === new Date(now).toDateString()
    ? `Since ${timeOfDay(stageEnteredAt)} today`
    : `Since ${formatDate(stageEnteredAt, {}, new Date(now))}`;
}
