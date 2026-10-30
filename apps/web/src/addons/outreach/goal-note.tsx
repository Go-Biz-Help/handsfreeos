'use client';
/**
 * Today's note on a network short of the day's first messages (docs/outreach.md, decision 126, answer 7a): how many
 * short, the real reason, and two or three things to try, each a button to where it's done
 * (packages/core/src/addons/outreach/goal.ts). Get ready says what's left before it starts, so it isn't said twice.
 */
import {
  GOAL_TRIES,
  goalNote,
  goalTryPlace,
  type TodayGoal,
} from '@hfos/core/addons/outreach/goal';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { ButtonLink } from '@/components/ui/button';
import { outreachHref } from './address';

export function GoalNote({
  workspaceId,
  platform,
  goal,
}: {
  workspaceId: string;
  platform: Platform;
  goal: TodayGoal;
}) {
  const words = goal.why === 'not_ready' ? null : goalNote(goal, platform);
  if (!words) return null;
  return (
    <div
      data-testid="today-goal"
      className="rounded-card bg-warning-soft p-3.5 text-[13px] text-warning-text"
    >
      <p>{words}</p>
      {goal.tries.length ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {goal.tries.map((t) => (
            <li key={t}>
              <ButtonLink
                size="sm"
                href={outreachHref(workspaceId, goalTryPlace(t, platform))}
                title={GOAL_TRIES[t].line}
                data-testid={`today-goal-${t}`}
              >
                {GOAL_TRIES[t].label}
              </ButtonLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
