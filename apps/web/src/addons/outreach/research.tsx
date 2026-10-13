'use client';
/**
 * **Research** on a person's row (docs/outreach.md, decision 46a): it asks the person's computer to check that one
 * person for fit next, ahead of the daily order, within the day's checks. The row then says **Researching…** until
 * the AI has read them, and its answer after: a good fit, might fit or not, with the short why. Nothing shows for
 * someone never pitched. The rules and words are core's (`researchShown`, `RESEARCH_WORDS`), the phone's too.
 */
import { latestAsk, researchAskState, researchTarget } from '@hfos/core/addons/outreach/asks';
import {
  CHECK_VERDICTS,
  RESEARCH_WORDS,
  researchShown,
  type CheckVerdict,
} from '@hfos/core/addons/outreach/checks';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { AskButton, AskLine } from './asks';
import type { Asks } from './types';

const TONE: Record<CheckVerdict, BadgeVariant> = {
  waiting: 'gray',
  good: 'ok',
  maybe: 'accent',
  not: 'gray',
  failed: 'gray',
};

export function ResearchSlot({
  workspaceId,
  asks,
  profileId,
  name,
  check,
  neverPitched,
  showResult = true,
  badge = true,
  onAsked,
}: {
  workspaceId: string;
  /** The tab's asks, with Research's: null where they couldn't be had, and the button waits. */
  asks: Asks | null;
  profileId: string;
  name: string;
  check: {
    readonly verdict: CheckVerdict;
    readonly playbookName: string | null;
    readonly why: readonly string[];
  } | null;
  neverPitched: boolean;
  /** Say the AI's answer here: off where the row shows it already. */
  showResult?: boolean;
  /** Its verdict's badge too: off where the row has that badge already. */
  badge?: boolean;
  onAsked?: () => void;
}) {
  const latest = latestAsk(asks, 'research', researchTarget(profileId));
  const shown = researchShown({ check, neverPitched, ask: researchAskState(latest) });
  if (shown === 'hidden') return null;
  if (shown === 'result') {
    if (!showResult || !check) return null;
    return (
      <div className="mt-1.5 text-[12.5px]" data-testid="research-result">
        {badge ? (
          <Badge variant={TONE[check.verdict]}>
            {CHECK_VERDICTS[check.verdict]}
            {check.playbookName ? ` · ${check.playbookName}` : ''}
          </Badge>
        ) : null}
        {check.why.length ? (
          <p className={badge ? 'mt-1 text-text-2' : 'text-text-2'}>{check.why.join(' · ')}</p>
        ) : null}
      </div>
    );
  }
  if (shown === 'researching')
    return (
      <div className="mt-1.5" data-testid="research-working">
        <Badge variant="accent">{RESEARCH_WORDS.working}</Badge>
      </div>
    );
  if (shown === 'tomorrow')
    return (
      <div className="mt-1.5" data-testid="research-tomorrow">
        <Badge variant="pending" title={latest?.line ?? undefined}>
          {RESEARCH_WORDS.queued}
        </Badge>
      </div>
    );
  if (!asks) return null;
  return (
    <div className="mt-1.5" data-testid="research">
      <div title={RESEARCH_WORDS.title(name)}>
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'research', profileId }}
          label={RESEARCH_WORDS.button}
          variant="ghost"
          showLine={false}
          testId="ask-research"
          onAsked={onAsked}
        />
      </div>
      {latest && researchAskState(latest) === 'failed' ? (
        <AskLine workspaceId={workspaceId} asks={asks} ask={latest} className="mt-1.5" />
      ) : null}
    </div>
  );
}
