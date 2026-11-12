'use client';
/**
 * Setting up on its own (docs/socialcontent.md, "Setting up on its own"; decisions 28 to 33), on top of Creators: each
 * step with where it stands, worked out by core's `setupSteps` (the phone's is the same), and a link to fix what one
 * waits on. Shown until every step is done or turned off.
 */
import { setupDone, setupSteps, type SetupStep } from '@hfos/core/addons/socialcontent/picking';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { Check, Circle, Loader2, MinusCircle } from 'lucide-react';
import { useState } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Overview } from './types';

const ICONS = {
  done: Check,
  doing: Loader2,
  waiting: Circle,
  off: MinusCircle,
} as const;

function fixHref(workspaceId: string, fix: NonNullable<SetupStep['fix']>): string | null {
  if (fix === 'settings') return `/app/w/${workspaceId}/a/socialcontent/settings`;
  if (fix === 'main-offer' || fix === 'main-offer-lists')
    return `/app/w/${workspaceId}/settings/main-offer`;
  return null;
}

export function SetupCard({ workspaceId, overview }: { workspaceId: string; overview: Overview }) {
  // When the page was read: "in 2 days" needn't tick.
  const [now] = useState(() => Date.now());
  if (!overview.setup) return null;
  const steps = setupSteps(overview.setup, now);
  if (setupDone(steps)) return null;
  return (
    <Card className="p-4 md:p-5" data-testid="socialcontent-setup">
      <h2 className="text-[15px] font-semibold">{W.setup.title}</h2>
      <p className="mt-1 text-[13px] text-text-2">{W.setup.intro}</p>
      <ol className="mt-3 space-y-2.5">
        {steps.map((s) => {
          const Icon = ICONS[s.state];
          const href = s.fix ? fixHref(workspaceId, s.fix) : null;
          return (
            <li
              key={s.key}
              className="flex items-start gap-2.5"
              data-testid={`socialcontent-setup-${s.key}`}
              data-state={s.state}
            >
              <Icon
                aria-label={W.setup.states[s.state]}
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  s.state === 'done' && 'text-success-text',
                  s.state === 'doing' && 'animate-spin text-accent-text',
                  (s.state === 'waiting' || s.state === 'off') && 'text-text-3',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{s.title}</div>
                <div className="text-[13px] text-text-2">{s.line}</div>
              </div>
              {href && overview.mayManage ? (
                <ButtonLink href={href} size="sm" variant="secondary">
                  {W.setup.fix[s.fix!]}
                </ButtonLink>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
