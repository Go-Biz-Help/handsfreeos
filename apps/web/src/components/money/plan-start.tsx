'use client';
/**
 * Putting a customer on a maintenance plan (design/m9 Plans).
 *
 * The plan is copied as it is sold **today** — its price, how often it bills and what it includes — so
 * repricing the catalogue next spring never reprices the person who signed up this autumn.
 *
 * The account it will bill through is picked here rather than assumed, because it decides two things the
 * business has to know before it presses the button: Square plans are card-only, and a plan lives inside one
 * provider account for life.
 */
import { money } from '@hfos/core';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PaymentConnectionRow, PlanRow } from '@/lib/api/types';
import { PersonPicker, type PickedPerson } from './person-picker';
import { planPriceLabel } from './plans-list';

/** "Stripe · Lone Star HVAC", the way every money screen names an account. */
export function connectionLabel(c: PaymentConnectionRow): string {
  const provider =
    c.provider === 'square' ? 'Square' : c.provider === 'stripe' ? 'Stripe' : c.provider;
  const name = c.label ?? c.displayName ?? c.externalAccountId;
  return name ? `${provider} · ${name}` : provider;
}

/** What a provider will and will not do with a plan, said before the button is pressed, not after. */
export function providerTruths(provider: string | null): string[] {
  if (provider === 'square')
    return [
      'Square plans are card-only — a bank transfer cannot bill a plan there.',
      'Square cancels a plan at the end of the period it has already been paid for, never straight away.',
    ];
  if (provider === 'stripe')
    return ['Stripe Billing retries a failed card and keeps an expiring card working on its own.'];
  return [];
}

export function StartPlanDialog({
  workspaceId,
  plans,
  connections,
  person,
  trigger,
}: {
  workspaceId: string;
  plans: readonly PlanRow[];
  connections: readonly PaymentConnectionRow[];
  /** Fixed on a customer's own page; picked here on the Plans page. */
  person?: PickedPerson;
  trigger?: 'button' | 'none';
}) {
  const router = useRouter();
  const live = plans.filter((p) => !p.archivedAt);
  // Connected, and one this person may bill into (0104).
  const usable = connections.filter((c) => c.status === 'active' && c.usableByMe);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<PickedPerson | null>(person ?? null);
  const [planId, setPlanId] = useState(live[0]?.id ?? '');
  const [connectionId, setConnectionId] = useState(
    usable.find((c) => c.isDefault)?.id ?? usable[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);
  const plan = live.find((p) => p.id === planId) ?? null;
  const account = usable.find((c) => c.id === connectionId) ?? null;

  async function start() {
    if (!picked || !plan) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/subscription.start', {
          body: {
            workspaceId,
            personId: picked.id,
            planId: plan.id,
            connectionId: connectionId || null,
          },
        }),
      );
      setOpen(false);
      toast.success(`${picked.fullName} is on ${plan.name}.`);
      router.push(`/app/w/${workspaceId}/money/plans/${out.subscriptionId}`);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {trigger === 'none' ? null : (
        <Button
          variant="secondary"
          className="max-md:h-11 max-md:flex-1"
          onClick={() => setOpen(true)}
          data-testid="plan-start"
        >
          <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
          Put someone on a plan
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Put someone on a plan"
          description="The plan is copied as it is sold today, so repricing the catalogue never reprices them."
        >
          <div className="mt-4 flex flex-col gap-3.5" data-testid="start-plan-dialog">
            {person ? (
              <div>
                <p className="mb-1 text-xs font-medium text-text-3">Customer</p>
                <p className="text-[13px] font-medium">{person.fullName}</p>
              </div>
            ) : (
              <Field label="Customer" htmlFor="money-person">
                {picked ? (
                  <p className="flex items-center gap-2 text-[13px]">
                    <span className="font-medium">{picked.fullName}</span>
                    <button
                      type="button"
                      className="text-xs text-accent-text hover:underline"
                      onClick={() => setPicked(null)}
                    >
                      Change
                    </button>
                  </p>
                ) : (
                  <PersonPicker workspaceId={workspaceId} onPick={setPicked} autoFocus />
                )}
              </Field>
            )}

            <Field label="Plan" htmlFor="plan-choice">
              <Select
                id="plan-choice"
                value={planId}
                data-testid="plan-choice"
                onChange={(e) => setPlanId(e.target.value)}
              >
                {live.length === 0 ? <option value="">No plans in the catalogue yet</option> : null}
                {live.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {planPriceLabel(p.priceCents, p.interval, p.intervalCount)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Paid into" htmlFor="plan-connection">
              <Select
                id="plan-connection"
                value={connectionId}
                data-testid="plan-connection"
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {usable.length === 0 ? (
                  <option value="">
                    {connections.some((c) => c.status === 'active')
                      ? 'None of the accounts is yours to bill into'
                      : 'No connected account'}
                  </option>
                ) : null}
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {connectionLabel(c)}
                    {c.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {plan ? (
              <p className="text-[13px] text-text-2" data-testid="plan-summary">
                {money(plan.priceCents)}{' '}
                {planPriceLabel(plan.priceCents, plan.interval, plan.intervalCount).replace(
                  /^\S+\s/,
                  '',
                )}
                {plan.includes.length ? ` · ${plan.includes.join(', ')}` : ''}
              </p>
            ) : null}

            <ul className="flex flex-col gap-1.5 text-xs leading-[1.45] text-text-3">
              <li>
                The plan bills itself at the provider from here on — their retries, their card
                updater, their bank checks. HandsFreeOS keeps each cycle as an invoice and a
                payment.
              </li>
              <li>
                A plan lives inside the account it starts in. Moving it later means cancelling this
                one and starting another.
              </li>
              {providerTruths(account?.provider ?? null).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Not yet</Button>
            </DialogClose>
            <Button
              loading={busy}
              disabled={!picked || !plan || usable.length === 0}
              data-testid="plan-start-confirm"
              onClick={() => void start()}
            >
              Start the plan
            </Button>
          </div>
          {usable.length === 0 ? (
            <p className="mt-2 text-right text-xs text-text-3">
              Connect an account in Settings → Payments first — a plan needs somewhere to bill.
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
