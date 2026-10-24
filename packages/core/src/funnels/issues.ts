/**
 * "Before it goes on" (step 8): what's missing or risky in a funnel. Red stops it from being turned on; yellow only
 * warns; ok says what's in place. Browser-safe: the rail shows them as the funnel is edited, and funnel.turn_on
 * refuses on a red one with the same words. Clients branch on `rule`.
 */
import type { FunnelDefinition } from './definition';

export interface FunnelIssue {
  readonly level: 'red' | 'yellow' | 'ok';
  readonly rule: string;
  readonly words: string;
}

export interface FunnelIssueContext {
  readonly pipelineName: string;
  /** The pipeline's stages, in order. */
  readonly stages: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: 'open' | 'won' | 'lost';
  }[];
  /** The teammate's name and status, or null with none set up. */
  readonly teammate: {
    readonly name: string;
    readonly status: 'off' | 'training' | 'automatic';
    readonly approved: number;
    readonly needed: number;
  } | null;
  /** Workflows that are on and start on a new lead in this pipeline (they'd text the same people). */
  readonly overlappingWorkflows: readonly string[];
}

export function funnelIssues(d: FunnelDefinition, c: FunnelIssueContext): FunnelIssue[] {
  const out: FunnelIssue[] = [];
  const red = (rule: string, words: string) => out.push({ level: 'red', rule, words });
  const yellow = (rule: string, words: string) => out.push({ level: 'yellow', rule, words });
  const ok = (rule: string, words: string) => out.push({ level: 'ok', rule, words });
  const stageById = new Map(c.stages.map((s) => [s.id, s]));
  const inFunnel = new Set(d.stages.map((s) => s.stageId));

  if (!c.teammate)
    red(
      'no_teammate',
      'This business has no AI teammate yet, and funnels are run by it. Set one up under AI teammate first.',
    );
  else if (c.teammate.status === 'off')
    red(
      'teammate_off',
      `${c.teammate.name} is off, so no funnel runs. Turn ${c.teammate.name} on under AI teammate.`,
    );

  if (d.stages.length === 0)
    red(
      'no_stages',
      `The funnel has no stages yet. Add the ${c.pipelineName} stages it uses in step 4.`,
    );
  const gone = d.stages.filter((s) => !stageById.has(s.stageId));
  if (gone.length)
    red(
      'stage_gone',
      `${gone.length === 1 ? 'A stage' : `${gone.length} stages`} in this funnel ${gone.length === 1 ? 'isn’t' : 'aren’t'} in the ${c.pipelineName} pipeline anymore. Take ${gone.length === 1 ? 'it' : 'them'} out in step 4.`,
    );
  const badMoves = d.stages.flatMap((s) =>
    s.moves.filter((m) => !inFunnel.has(m.to)).map(() => s.stageId),
  );
  if (badMoves.length)
    red(
      'move_nowhere',
      `${stageById.get(badMoves[0]!)?.name ?? 'A stage'} moves people to a stage that isn’t in the funnel. Pick another in step 4.`,
    );
  if (d.entry.rules.length === 0 && !d.entry.byHand && !d.entry.aiSuggests)
    red(
      'no_way_in',
      'Nobody can get in: there are no rules, and adding people by hand is off. Turn one on in step 3.',
    );
  if (d.entry.startStageId && !inFunnel.has(d.entry.startStageId))
    red('start_gone', 'The stage people start at isn’t in the funnel. Pick another in step 3.');

  if (c.teammate && c.teammate.status === 'training' && d.approval === 'teammate')
    yellow(
      'training_wheels',
      `${c.teammate.name} is in training wheels (${c.teammate.approved} of ${c.teammate.needed} approved), so each message waits for an OK until then.`,
    );
  for (const name of c.overlappingWorkflows)
    yellow(
      'workflow_overlap',
      `${name} also texts new leads in ${c.pipelineName}, so they’d hear from both.`,
    );
  const open = d.stages.filter((s) => stageById.get(s.stageId)?.kind === 'open');
  const noGoal = open.filter((s) => !s.goal.trim());
  if (noGoal.length)
    yellow(
      'no_goal',
      noGoal.length === 1
        ? `${stageById.get(noGoal[0]!.stageId)?.name} has no goal yet, so the teammate guesses what it’s for.`
        : `${noGoal.length} stages have no goal yet, so the teammate guesses what they’re for.`,
    );
  const stuck = open.filter((s) => s.moves.length === 0);
  if (stuck.length)
    yellow(
      'no_way_on',
      `Nothing moves people on from ${stuck.map((s) => stageById.get(s.stageId)?.name ?? 'a stage').join(', ')}. Add a move in step 4, or they stay there.`,
    );

  if (!out.some((i) => i.rule === 'no_goal') && open.length) ok('goals', 'Every stage has a goal');
  if (d.entry.rules.length)
    ok(
      'rules',
      d.entry.rules.length === 1
        ? 'One rule brings people in'
        : `${d.entry.rules.length} rules bring people in`,
    );
  const joinLink = d.stages.some((s) =>
    s.messages.some((m) =>
      m.wording === 'ai' ? /join/i.test(m.text) : m.text.includes('{join_link}'),
    ),
  );
  if (joinLink) ok('join_link', 'A message carries the Join link');
  return out;
}

/** The first red issue, or null: what stops it from being turned on. */
export const funnelBlocker = (issues: readonly FunnelIssue[]): FunnelIssue | null =>
  issues.find((i) => i.level === 'red') ?? null;
