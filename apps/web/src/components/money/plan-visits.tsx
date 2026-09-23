'use client';
/**
 * A maintenance plan's visits (Automations' "Maintenance due"): the service it covers and how often its members
 * are due. Members get the maintenance reminder on that schedule, worded as included in their plan.
 */
import { everyMonthsWords } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PlanRow } from '@/lib/api/types';

export interface ServiceChoice {
  readonly id: string;
  readonly name: string;
}

/** "AC tune-up every 6 months", or null when the plan covers no service. */
export function planVisitsWords(
  plan: Pick<PlanRow, 'serviceId' | 'visitEveryMonths'>,
  services: readonly ServiceChoice[],
): string | null {
  if (!plan.serviceId || !plan.visitEveryMonths) return null;
  const name = services.find((s) => s.id === plan.serviceId)?.name ?? 'A service';
  return `${name} ${everyMonthsWords(plan.visitEveryMonths)}`;
}

export function PlanVisitsButton({
  workspaceId,
  plan,
  services,
  canManage,
}: {
  workspaceId: string;
  plan: PlanRow;
  services: readonly ServiceChoice[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serviceId, setServiceId] = useState(plan.serviceId ?? '');
  const [months, setMonths] = useState(plan.visitEveryMonths ? String(plan.visitEveryMonths) : '6');
  const [busy, setBusy] = useState(false);
  const words = planVisitsWords(plan, services);
  const n = Number(months);
  const bad = !Number.isInteger(n) || n < 1 || n > 60;

  async function save(clear: boolean) {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/plan.update', {
          body: {
            workspaceId,
            planId: plan.id,
            serviceId: clear ? null : serviceId,
            visitEveryMonths: clear ? null : n,
          },
        }),
      );
      toast.success(clear ? 'The plan covers no visits now.' : 'Saved the plan’s visits.');
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) return <span className="text-text-2">{words ?? '—'}</span>;
  return (
    <>
      <button
        type="button"
        className="text-left font-medium text-accent-text hover:underline"
        onClick={() => setOpen(true)}
        data-testid={`plan-visits-${plan.name}`}
      >
        {words ?? 'Set visits'}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`${plan.name}: visits`}
          description="Members are reminded to book this service on this schedule, in a text that says it’s included in their plan."
        >
          <div className="mt-4 flex flex-col gap-3">
            <Select
              selectSize="sm"
              aria-label="Service the plan covers"
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              data-testid="plan-visits-service"
            >
              <option value="">Pick a service…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-[13px] text-text-2">
              Every
              <Input
                inputSize="sm"
                inputMode="numeric"
                className="w-20"
                aria-label="Every how many months"
                value={months}
                invalid={bad}
                onChange={(e) => setMonths(e.target.value)}
                data-testid="plan-visits-months"
              />
              months
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            {words ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save(true)}>
                No visits
              </Button>
            ) : null}
            <DialogClose asChild>
              <Button variant="secondary" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              disabled={busy || !serviceId || bad}
              onClick={() => void save(false)}
              data-testid="plan-visits-save"
            >
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
