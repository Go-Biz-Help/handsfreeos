'use client';
/**
 * Making and changing the maintenance plans a business sells (design/m9 Plans: New plan). The plan.create,
 * plan.update and plan.archive commands were there from the start; the screen that calls them was not, so the
 * catalogue could only be filled by the seed, and the empty Plans page pointed at Settings → Products, which
 * pointed back here.
 *
 * Repricing a plan never reprices anyone already on it: selling a plan copies it (plan-start.tsx).
 */
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PlanRow } from '@/lib/api/types';
import { MoneyInput } from './money-input';

type Interval = PlanRow['interval'];

/** How often a plan bills, in the words a business uses: the four nearly every plan is. */
const EVERY: readonly { interval: Interval; count: number; label: string }[] = [
  { interval: 'month', count: 1, label: 'Every month' },
  { interval: 'quarter', count: 1, label: 'Every 3 months' },
  { interval: 'month', count: 6, label: 'Every 6 months' },
  { interval: 'year', count: 1, label: 'Every year' },
];
const everyKey = (interval: string, count: number) => `${interval}:${count}`;

export function NewPlanButton({
  workspaceId,
  taxableByDefault,
}: {
  workspaceId: string;
  /** Settings → Payments' "New items start taxable". */
  taxableByDefault: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        className="max-md:h-11 max-md:flex-1"
        onClick={() => setOpen(true)}
        data-testid="plan-new"
      >
        <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
        New plan
      </Button>
      {open ? (
        <PlanEditorDialog
          workspaceId={workspaceId}
          plan={null}
          taxableByDefault={taxableByDefault}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** A plan's name in the catalogue: for whoever manages money, it opens the plan to change or archive it. */
export function PlanNameButton({
  workspaceId,
  plan,
  canManage,
  card = false,
}: {
  workspaceId: string;
  plan: PlanRow;
  canManage: boolean;
  /** The phone's card rather than the table's row: both are on the page, one hidden. */
  card?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!canManage) return <>{plan.name}</>;
  return (
    <>
      <button
        type="button"
        className="text-left font-semibold hover:underline"
        onClick={() => setOpen(true)}
        data-testid={`plan-edit-${card ? 'card-' : ''}${plan.name}`}
      >
        {plan.name}
      </button>
      {open ? (
        <PlanEditorDialog
          workspaceId={workspaceId}
          plan={plan}
          taxableByDefault={plan.taxable}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function PlanEditorDialog({
  workspaceId,
  plan,
  taxableByDefault,
  onClose,
}: {
  workspaceId: string;
  /** Null makes a new one. */
  plan: PlanRow | null;
  taxableByDefault: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(plan?.name ?? '');
  const [priceCents, setPriceCents] = useState(plan?.priceCents ?? 0);
  const [priceBad, setPriceBad] = useState(false);
  const [every, setEvery] = useState(everyKey(plan?.interval ?? 'month', plan?.intervalCount ?? 1));
  const [includes, setIncludes] = useState((plan?.includes ?? []).join('\n'));
  const [taxable, setTaxable] = useState(plan?.taxable ?? taxableByDefault);
  const [busy, setBusy] = useState(false);

  // A plan saved another way (the Assistant, an import) keeps its own schedule as a choice of its own.
  const choices = EVERY.some((e) => everyKey(e.interval, e.count) === every)
    ? EVERY
    : [
        ...EVERY,
        {
          interval: plan!.interval,
          count: plan!.intervalCount,
          label: `Every ${plan!.intervalCount} ${plan!.interval}s`,
        },
      ];
  const picked = choices.find((e) => everyKey(e.interval, e.count) === every) ?? EVERY[0]!;
  const lines = includes
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const nameBad = !name.trim();

  async function save() {
    setBusy(true);
    try {
      const body = {
        workspaceId,
        name: name.trim(),
        priceCents,
        interval: picked.interval,
        intervalCount: picked.count,
        includes: lines,
        taxable,
      };
      if (plan)
        unwrap(
          await apiBrowser().POST('/v1/commands/plan.update', {
            body: { ...body, planId: plan.id },
          }),
        );
      else unwrap(await apiBrowser().POST('/v1/commands/plan.create', { body }));
      toast.success(plan ? `Saved ${body.name}.` : `${body.name} is ready to sell.`);
      onClose();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!plan) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/plan.archive', {
          body: { workspaceId, planId: plan.id, archived: true },
        }),
      );
      toast.success(`${plan.name} isn’t sold any more. Anyone on it stays on it.`);
      onClose();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent
        title={plan ? plan.name : 'New plan'}
        description={
          plan
            ? 'A new price is for people who join from now on. Anyone already on it keeps what they signed up for.'
            : 'A plan bills itself on a schedule. Put customers on it from Money → Plans or their own page.'
        }
      >
        <div className="mt-4 flex flex-col gap-3.5" data-testid="plan-editor">
          <Field label="Name" htmlFor="plan-name">
            <Input
              id="plan-name"
              value={name}
              placeholder="Comfort Club"
              maxLength={160}
              invalid={nameBad && name !== ''}
              onChange={(e) => setName(e.target.value)}
              data-testid="plan-editor-name"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price" htmlFor="plan-price">
              <MoneyInput
                id="plan-price"
                valueCents={priceCents}
                onChange={setPriceCents}
                // Shares a name with the DOM's onInvalid, as on Products: only a plain true means unreadable.
                onInvalid={(v: boolean | SyntheticEvent<HTMLInputElement>) =>
                  setPriceBad(v === true)
                }
                data-testid="plan-editor-price"
              />
            </Field>
            <Field label="Bills" htmlFor="plan-every">
              <Select
                id="plan-every"
                value={every}
                onChange={(e) => setEvery(e.target.value)}
                data-testid="plan-editor-every"
              >
                {choices.map((e) => (
                  <option key={everyKey(e.interval, e.count)} value={everyKey(e.interval, e.count)}>
                    {e.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="What it includes"
            htmlFor="plan-includes"
            hint="One a line. The customer sees these on their plan’s page."
          >
            <Textarea
              id="plan-includes"
              rows={3}
              value={includes}
              placeholder={'Two tune-ups a year\n15% off repairs'}
              onChange={(e) => setIncludes(e.target.value)}
              data-testid="plan-editor-includes"
            />
          </Field>
          <Checkbox
            label="Charge sales tax on it"
            checked={taxable}
            onChange={(e) => setTaxable(e.target.checked)}
            data-testid="plan-editor-taxable"
          />
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          {plan ? (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              disabled={busy}
              onClick={() => void archive()}
              data-testid="plan-editor-archive"
            >
              Stop selling it
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={busy || nameBad || priceBad}
            onClick={() => void save()}
            data-testid="plan-editor-save"
          >
            {plan ? 'Save' : 'Add plan'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
