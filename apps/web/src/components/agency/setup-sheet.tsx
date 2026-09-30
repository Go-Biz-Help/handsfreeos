'use client';
import { AGENCY_SETUP_WORDS, relativeTimeAgo, stepPath, stepTitle, stepWords } from '@hfos/core';
import { AlertCircle, ArrowUpRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { StateMark } from '@/components/home/getting-started';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { OnboardingClient, OnboardingStep } from '@/lib/api/types';
import { publicEnv } from '@/lib/env';

export const GROUP_BADGE: Record<OnboardingClient['group'], BadgeVariant> = {
  stuck: 'danger',
  setup: 'pending',
  done: 'ok',
};

/** Steps only the owner can do: their own team, and their own sign-in to Stripe or Square. */
const OWNERS_CALL: Partial<Record<OnboardingStep['key'], string>> = {
  team: AGENCY_SETUP_WORDS.ownersCall,
  payments: AGENCY_SETUP_WORDS.ownerSignsIn,
};

/**
 * One client business's setup, beside Client businesses (board 11): what needs a fix first, then its steps in two
 * groups, each still to do with "Do it for them" (the client's own screen for it, where the agency's owners and
 * admins can act) unless only the owner can. At the foot, a reminder to its own owners, once a day, and the way
 * into the business.
 */
export function SetupSheet({
  organizationId,
  client,
  onOpenChange,
}: {
  organizationId: string;
  client: OnboardingClient | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const w = AGENCY_SETUP_WORDS;

  async function remind(c: OnboardingClient) {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/onboarding.remind', {
          body: { organizationId, workspaceId: c.workspaceId },
        }),
      );
      toast.success(w.reminded(out.to.join(', ')));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const c = client;
  const fix = c?.steps.find((s) => s.state === 'needs_fix') ?? null;
  const group = (basics: boolean) => c?.steps.filter((s) => s.mustDo === basics) ?? [];
  const first = c?.owner?.name.split(/\s+/)[0] ?? null;
  const canRemind = !!c && !!c.owner && c.enabled && c.group !== 'done' && !c.remindedAt;

  return (
    <Sheet open={!!c} onOpenChange={onOpenChange}>
      {c ? (
        <SheetContent
          title={c.name}
          description={w.owner(
            c.owner?.name ?? '',
            c.done,
            c.total,
            c.lastSignInAt ? relativeTimeAgo(c.lastSignInAt) : null,
          )}
          className="sm:w-[560px]"
        >
          <div className="flex flex-col gap-4" data-testid="setup-sheet">
            <div className="flex items-center gap-2">
              <Badge variant={GROUP_BADGE[c.group]}>{c.badge}</Badge>
              <span className="text-[13px] text-text-2">{c.note}</span>
            </div>
            {fix ? (
              <div className="flex items-start gap-3 rounded-menu bg-danger-soft px-4 py-3.5">
                <AlertCircle
                  className="mt-0.5 h-4 w-4 flex-none text-danger-text"
                  strokeWidth={1.75}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-medium text-danger-text">
                    {stepTitle(fix.key, fix.note.name)}
                  </span>
                  <span className="text-[13px] text-text">{stepWords(fix).detail}</span>
                </div>
              </div>
            ) : null}
            {(
              [
                [true, w.basics],
                [false, w.later],
              ] as const
            ).map(([basics, label]) =>
              group(basics).length ? (
                <section key={label}>
                  <h3 className="px-0.5 pb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                    {label}
                  </h3>
                  <ul className="flex flex-col">
                    {group(basics).map((s) => (
                      <Step key={s.key} workspaceId={c.workspaceId} step={s} enabled={c.enabled} />
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
            <div className="sticky bottom-0 -mx-5 mt-2 flex flex-wrap items-center gap-2 border-t border-border bg-card px-5 py-3 sm:-mx-6 sm:px-6">
              <Button
                variant="secondary"
                loading={busy}
                disabled={!canRemind}
                onClick={() => void remind(c)}
                data-testid="setup-remind"
              >
                {first ? w.remind(first) : w.remindNoOwner}
              </Button>
              <ButtonLink href={`/app/w/${c.workspaceId}`} variant="ghost">
                {w.openWorkspace}
                <ArrowUpRight className="h-4 w-4" strokeWidth={1.5} />
              </ButtonLink>
              {c.remindedAt ? (
                <p className="basis-full text-xs text-text-3">{w.remindedToday}</p>
              ) : !c.owner ? (
                <p className="basis-full text-xs text-text-3">{w.noOwner(c.name)}</p>
              ) : null}
            </div>
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function Step({
  workspaceId,
  step,
  enabled,
}: {
  workspaceId: string;
  step: OnboardingStep;
  enabled: boolean;
}) {
  const words = stepWords(step);
  const open = step.state === 'todo' || step.state === 'needs_fix';
  const owners = OWNERS_CALL[step.key];
  const href = stepPath(workspaceId, step.key, {
    passkeys: publicEnv.passkeysEnabled,
    phase: step.note.phase,
  });
  return (
    <li
      className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0"
      data-testid={`setup-step-${step.key}`}
      data-state={step.state}
    >
      <StateMark state={step.state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{words.title}</span>
        <span className="truncate text-xs text-text-3" title={words.detail}>
          {open && owners ? owners : words.detail}
        </span>
      </span>
      {words.badge && step.state !== 'needs_fix' ? (
        <Badge variant={step.state === 'skipped' ? 'gray' : 'pending'}>{words.badge}</Badge>
      ) : null}
      {/* The client's own screen for it, while Getting started is on (the wizard is off with it). */}
      {open && !owners && enabled && href ? (
        <ButtonLink href={href} variant="secondary" size="sm" data-testid={`setup-do-${step.key}`}>
          {AGENCY_SETUP_WORDS.doItForThem}
        </ButtonLink>
      ) : null}
    </li>
  );
}
