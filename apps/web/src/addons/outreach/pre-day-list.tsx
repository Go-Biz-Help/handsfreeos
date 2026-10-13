'use client';
/**
 * The live checklist of the steps before the person's first day (docs/outreach.md, decision 60 "Lists first"): save
 * the friends list, the friend requests got and sent, and the groups; check the groups; work out who to unfriend;
 * check friends for good fits. Each is ticked once HandsFreeOS has it noted, and the one under way shows what the
 * extension says it's doing now ("Reading your friends… 1,240 friends so far."), from the live status that already
 * comes with `outreach.live`. Shown under Start my day, on Today's strip and the Live view; gone once all are done.
 */
import { isOffline } from '@hfos/core/addons/outreach/live';
import { PRE_DAY_TITLE, preDayCount, preDaySteps } from '@hfos/core/addons/outreach/lists';
import { Check, Circle, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Live } from './types';

export function PreDayList({
  live,
  now,
  className,
}: {
  live: Live;
  now: number;
  className?: string;
}) {
  const computer = live.computer;
  // What the computer says now is the step's progress only while it works and is online.
  const working =
    computer !== null && computer.state === 'working' && !isOffline(computer.lastSeenAt, now);
  const steps = preDaySteps(live.lists, { line: working ? (live.status?.line ?? null) : null });
  if (!steps.length || live.day.state !== 'started') return null;
  return (
    <section
      className={cn('grid gap-2', className)}
      data-testid="pre-day"
      aria-label={PRE_DAY_TITLE}
    >
      <p className="text-[13px]">
        <span className="font-semibold">{PRE_DAY_TITLE}</span>
        <span className="text-text-2"> · {preDayCount(steps)}</span>
      </p>
      <ol className="grid gap-1.5">
        {steps.map((step) => (
          <li
            key={step.key}
            className="grid grid-cols-[18px_1fr] items-start gap-2 text-[13px]"
            aria-current={step.state === 'now' ? 'step' : undefined}
            data-testid={`pre-day-${step.key}`}
            data-state={step.state}
          >
            {step.state === 'done' ? (
              <Check className="mt-0.5 h-4 w-4 text-success" strokeWidth={2} aria-hidden="true" />
            ) : step.state === 'now' ? (
              <LoaderCircle
                className="mt-0.5 h-4 w-4 animate-spin text-accent motion-reduce:animate-none"
                strokeWidth={2}
                aria-hidden="true"
              />
            ) : (
              <Circle
                className="mt-0.5 h-4 w-4 text-text-3"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                step.state === 'done' && 'text-text-2',
                step.state === 'now' && 'font-medium',
                step.state === 'next' && 'text-text-3',
              )}
            >
              {step.label}
              <span className="sr-only">
                {step.state === 'done'
                  ? ': done'
                  : step.state === 'now'
                    ? ': under way'
                    : ': to come'}
              </span>
            </span>
            {step.progress ? (
              <span className="col-start-2 text-[12.5px] text-text-2" role="status">
                {step.progress}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
