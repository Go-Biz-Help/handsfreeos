import { BILLING_WORDS, FOUNDING_PLAN_WORDS, type FoundingPlanFacts } from '@hfos/core';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * A founding spot paid by the month or the year (20261027009500, 20261027012700), on Settings → Usage & balance: what
 * it costs and when it renews, and the way to Settings → Billing, where its cards, its payment date, stopping it and a
 * payment that didn't go through are (20261027023600). It keeps the `founding` id, which older emails link to.
 */
export function FoundingPlanCard({
  workspaceId,
  plan,
}: {
  workspaceId: string;
  plan: FoundingPlanFacts & { readonly paidThrough: string };
}) {
  const refused = plan.renewalProblem !== null;
  // A code's discount comes off while it lasts (20261027014300).
  const nextCents = plan.nextChargeCents ?? plan.priceCents;
  return (
    <Card id="founding" className="px-[22px] py-5" data-testid="usage-founding">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
            {FOUNDING_PLAN_WORDS.title}
          </h2>
          <p className="mt-1 max-w-[460px] text-[13px] text-text-2">
            {FOUNDING_PLAN_WORDS.price(plan.priceCents, plan.plan)}
          </p>
        </div>
        <ButtonLink
          href={`/app/w/${workspaceId}/settings/billing`}
          variant={refused ? 'primary' : 'secondary'}
          data-testid="usage-founding-billing"
        >
          {BILLING_WORDS.openBilling}
        </ButtonLink>
      </div>
      {refused ? (
        <p className="mt-4 rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
          {BILLING_WORDS.owedTitle}. {BILLING_WORDS.usagePointer}
        </p>
      ) : (
        <p className="mt-4 text-[13px]" data-testid="usage-founding-line">
          {plan.trialEndsAt
            ? plan.renewing
              ? FOUNDING_PLAN_WORDS.trial(plan.trialEndsAt, nextCents)
              : FOUNDING_PLAN_WORDS.trialStopped(plan.trialEndsAt)
            : plan.renewing
              ? BILLING_WORDS.payDayLine(plan.paidThrough, nextCents)
              : FOUNDING_PLAN_WORDS.stopped(plan.paidThrough)}{' '}
          <span className="text-text-2">{BILLING_WORDS.usagePointer}</span>
        </p>
      )}
    </Card>
  );
}
