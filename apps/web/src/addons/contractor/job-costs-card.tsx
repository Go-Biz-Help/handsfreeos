'use client';
/**
 * What a job is costing (docs/contractor.md, "Time and job costing"; the owner's decisions 10 and 11): what was
 * planned, what it has cost so far and what it's heading for, in labor, materials and other costs, with the profit
 * that leaves, labor by person, and the job's other costs (a permit, a dump fee, a subcontractor's bill), which are
 * added and removed here. Only people who may see job costs get this card: the server sends nobody else a figure.
 *
 * Every number comes worked out from the server (`contractor.job.costing`), the same math the profit page and the
 * AI read, so this never adds anything up itself.
 */
import { marginWords } from '@hfos/core/addons/contractor/estimating';
import { LIMITS } from '@hfos/core/addons/contractor/schemas';
import { CONTRACTOR_WORDS, hoursWords } from '@hfos/core/addons/contractor/words';
import { formatDateOnly, money, parseMoney } from '@hfos/core';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Margin } from './costing';
import { ConfirmDialog } from './job-dialogs';
import type { JobCosting, OtherCost } from './types';
import { useAct } from './use-act';

const C = CONTRACTOR_WORDS.costing;

const cents = (n: number | null): ReactNode =>
  n === null ? <span className="text-text-3">{C.notSet}</span> : money(n);

export function JobCostsCard({
  workspaceId,
  costing: c,
  today,
}: {
  workspaceId: string;
  costing: JobCosting;
  /** The business's today, the day a new cost starts on. */
  today: string;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<OtherCost | null>(null);
  const over = !c.finished && c.overCents !== null && c.overCents > 0;
  const under = c.underMargin && c.profit.headingMarginBp !== null;
  const line = (
    label: string,
    l: JobCosting['total'],
    opts: { strong?: boolean; testId?: string } = {},
  ) => (
    <tr className={cn(opts.strong && 'font-semibold')} data-testid={opts.testId}>
      <th
        scope="row"
        className={cn(
          'py-1.5 pr-3 text-left font-normal',
          opts.strong ? 'font-semibold' : 'text-text-2',
        )}
      >
        {label}
      </th>
      <td className="py-1.5 pl-3 text-right tabular-nums">{cents(l.budgetCents)}</td>
      <td className="py-1.5 pl-3 text-right tabular-nums">{money(l.actualCents)}</td>
      <td
        className={cn(
          'py-1.5 pl-3 text-right tabular-nums',
          l.budgetCents !== null &&
            l.headingCents > l.budgetCents &&
            !c.finished &&
            'text-danger-text',
        )}
      >
        {money(l.headingCents)}
      </td>
    </tr>
  );
  return (
    <Card className="p-0" data-testid="job-costs">
      <div className="border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">{C.title}</h2>
        <p className="text-[12.5px] text-text-3">{C.hint}</p>
      </div>
      <div className="overflow-x-auto px-5 py-3">
        <table className="w-full min-w-[420px] text-[13.5px]">
          <thead>
            <tr className="text-[12px] font-medium uppercase tracking-wide text-text-3">
              <th scope="col" className="pb-1.5 text-left font-medium">
                <span className="sr-only">{C.total}</span>
              </th>
              <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                {C.planned}
              </th>
              <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                {C.soFar}
              </th>
              <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                {C.heading}
              </th>
            </tr>
          </thead>
          <tbody>
            {line(C.labor, c.labor, { testId: 'costs-labor' })}
            {line(C.materials, c.materials, { testId: 'costs-materials' })}
            {line(C.other, c.other, { testId: 'costs-other' })}
            {line(C.total, c.total, { strong: true, testId: 'costs-total' })}
            <tr className="text-text-2" data-testid="costs-hours">
              <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                {C.hours}
              </th>
              <td className="py-1.5 pl-3 text-right tabular-nums">
                {c.hours.budget === null ? (
                  <span className="text-text-3">{C.notSet}</span>
                ) : (
                  hoursWords(c.hours.budget)
                )}
              </td>
              <td className="py-1.5 pl-3 text-right tabular-nums">{hoursWords(c.hours.actual)}</td>
              <td className="py-1.5 pl-3 text-right tabular-nums">{hoursWords(c.hours.heading)}</td>
            </tr>
          </tbody>
          <tbody className="border-t border-border">
            <tr data-testid="costs-price">
              <th scope="row" className="pb-1.5 pr-3 pt-2.5 text-left font-normal text-text-2">
                {C.price}
              </th>
              <td colSpan={3} className="pb-1.5 pl-3 pt-2.5 text-right tabular-nums">
                {cents(c.priceCents)}
              </td>
            </tr>
            <tr className="font-semibold" data-testid="costs-profit">
              <th scope="row" className="py-1.5 pr-3 text-left font-semibold">
                {C.profit}
              </th>
              <td className="py-1.5 pl-3 text-right tabular-nums">
                {cents(c.profit.plannedCents)}
              </td>
              <td className="py-1.5 pl-3 text-right tabular-nums">{cents(c.profit.soFarCents)}</td>
              <td
                className={cn(
                  'py-1.5 pl-3 text-right tabular-nums',
                  c.profit.headingCents !== null && c.profit.headingCents < 0 && 'text-danger-text',
                )}
              >
                {cents(c.profit.headingCents)}
              </td>
            </tr>
            <tr data-testid="costs-margin">
              <th scope="row" className="py-1.5 pr-3 text-left font-normal text-text-2">
                {C.margin}
              </th>
              <td className="py-1.5 pl-3 text-right tabular-nums">
                <Margin bp={c.profit.plannedMarginBp} minBp={c.minMarginBp} />
              </td>
              <td className="py-1.5 pl-3 text-right text-text-3">—</td>
              <td className="py-1.5 pl-3 text-right tabular-nums">
                <Margin
                  bp={c.profit.headingMarginBp}
                  minBp={c.minMarginBp}
                  className="font-semibold"
                  testId="costs-heading-margin"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="space-y-1.5 border-t border-border px-5 py-3 text-[12.5px]">
        {c.finished ? (
          <p className="text-text-2">{C.finished}</p>
        ) : over || under ? (
          <div
            className="space-y-1 rounded-menu bg-danger-soft px-3 py-2.5 leading-[1.45] text-danger-text"
            role="status"
            data-testid="costs-warning"
          >
            {over ? (
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={2} />
                <span>{C.over(money(c.overCents ?? 0))}</span>
              </p>
            ) : null}
            {under ? (
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={2} />
                <span>
                  {C.underMargin(
                    marginWords(c.profit.headingMarginBp ?? 0),
                    marginWords(c.minMarginBp),
                  )}
                </span>
              </p>
            ) : null}
          </div>
        ) : c.total.budgetCents !== null ? (
          <p className="flex items-start gap-2 text-text-2" data-testid="costs-on-track">
            <CheckCircle2
              className="mt-px h-3.5 w-3.5 flex-none text-success-text"
              strokeWidth={2}
            />
            <span>{C.onTrack}</span>
          </p>
        ) : null}
        {c.priceCents === null ? <p className="text-text-2">{C.noPrice}</p> : null}
        {c.uncostedHours > 0 ? (
          <p className="text-text-2" data-testid="costs-uncosted-hours">
            {C.uncostedHours(hoursWords(c.uncostedHours))}
          </p>
        ) : null}
        {c.uncostedMaterials > 0 ? (
          <p className="text-text-2">{C.uncostedMaterials(c.uncostedMaterials)}</p>
        ) : null}
        {c.finished ? null : <p className="text-text-3">{C.pace}</p>}
      </div>
      {c.people.length ? (
        <div className="border-t border-border px-5 py-3" data-testid="costs-people">
          <h3 className="text-[12px] font-medium uppercase tracking-wide text-text-3">
            {C.byPerson}
          </h3>
          <ul className="mt-1.5 space-y-1 text-[13.5px]">
            {c.people.map((p) => (
              <li key={p.userId ?? p.name} className="flex items-center justify-between gap-3">
                <span className="truncate">{p.name}</span>
                <span className="flex-none tabular-nums text-text-2">
                  {hoursWords(p.hours)} · <span className="text-text">{money(p.costCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="border-t border-border px-5 py-3" data-testid="other-costs">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-[12px] font-medium uppercase tracking-wide text-text-3">
              {C.otherTitle}
            </h3>
            <p className="text-[12.5px] text-text-3">{C.otherHint}</p>
          </div>
          {c.canChange ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAdding(true)}
              data-testid="other-cost-add"
            >
              {C.otherAdd}
            </Button>
          ) : null}
        </div>
        {c.otherCosts.length === 0 ? (
          <p className="mt-1.5 text-[13.5px] text-text-2">{C.otherNone}</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5 text-[13.5px]">
            {c.otherCosts.map((o) => (
              <li
                key={o.id}
                className="flex items-start justify-between gap-3"
                data-testid={`other-cost-${o.name}`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{o.name}</span>
                  <span className="block text-[12.5px] text-text-3">
                    {formatDateOnly(o.spentOn)}
                    {o.note ? ` · ${o.note}` : ''}
                  </span>
                </span>
                <span className="flex flex-none items-center gap-1.5">
                  <span className="tabular-nums">{money(o.amountCents)}</span>
                  {c.canChange ? (
                    <button
                      type="button"
                      className="rounded p-1 text-text-3 hover:bg-card-2 hover:text-text"
                      aria-label={`${C.otherRemove}: ${o.name}`}
                      onClick={() => setRemoving(o)}
                      data-testid="other-cost-remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title={C.otherAddTitle} description={C.otherHint}>
          {adding ? (
            <OtherCostForm
              workspaceId={workspaceId}
              jobId={c.jobId}
              today={today}
              onClose={() => setAdding(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? C.otherRemoveTitle(removing.name) : C.otherRemove}
        description={C.otherRemoveAsk}
        submit={C.otherRemove}
        done={removing ? C.otherRemoved(removing.name) : ''}
        run={async () =>
          removing &&
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.other_cost.remove', {
              body: { workspaceId, costId: removing.id },
            }),
          )
        }
      />
    </Card>
  );
}

/** Something else the job cost: what it was for, what it came to, the day, and a note. */
function OtherCostForm({
  workspaceId,
  jobId,
  today,
  onClose,
}: {
  workspaceId: string;
  jobId: string;
  today: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState(today);
  const [note, setNote] = useState('');
  const { busy, errors, setErrors, act } = useAct(onClose);
  const submit = () => {
    const amountCents = parseMoney(amount.trim());
    if (!amount.trim() || amountCents === null)
      return setErrors({ amountCents: 'Type an amount, like 185 or 42.50.' });
    void act(
      'save',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/contractor.other_cost.add', {
            body: {
              workspaceId,
              jobId,
              name: name.trim(),
              amountCents,
              ...(spentOn ? { spentOn } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          }),
        ),
      C.otherAdded(name.trim()),
    );
  };
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="other-cost-form"
    >
      <Field label={C.otherName} htmlFor="other-cost-name" error={errors.name}>
        <Input
          id="other-cost-name"
          value={name}
          maxLength={LIMITS.otherCostName}
          placeholder={C.otherNamePlaceholder}
          onChange={(e) => setName(e.target.value)}
          data-testid="other-cost-name"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={C.otherAmount} htmlFor="other-cost-amount" error={errors.amountCents}>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-3">
              $
            </span>
            <Input
              id="other-cost-amount"
              inputMode="decimal"
              autoComplete="off"
              className="pl-7 tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="other-cost-amount"
            />
          </div>
        </Field>
        <Field label={C.otherDay} htmlFor="other-cost-day" error={errors.spentOn}>
          <Input
            id="other-cost-day"
            type="date"
            value={spentOn}
            onChange={(e) => setSpentOn(e.target.value)}
          />
        </Field>
      </div>
      <Field label={C.otherNote} htmlFor="other-cost-note" error={errors.note}>
        <Textarea
          id="other-cost-note"
          rows={2}
          value={note}
          maxLength={LIMITS.otherCostNote}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {C.cancel}
        </Button>
        <Button
          type="submit"
          loading={busy === 'save'}
          disabled={!name.trim() || !amount.trim()}
          data-testid="other-cost-save"
        >
          {C.save}
        </Button>
      </div>
    </form>
  );
}
