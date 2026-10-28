'use client';

/**
 * Discount and trial codes (20261027014300): the list, with each code's deal, plan, link and uses, and the form that
 * makes one. The same on an affiliate's own page and on staff's, which pass in how a code is made and turned.
 *
 * A code is never changed, only made and turned off or on, so the form makes a new one each time.
 */
import {
  AFFILIATE_CODE_WORDS as W,
  AFFILIATE_TRIAL_DAYS,
  affiliateCodeDealWords,
  affiliateCodeLink,
  affiliatePercentToBp,
  affiliateRateWords,
  foundingPriceWords,
  money,
  parseMoney,
} from '@hfos/core';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { errorMessage } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Ok } from '@/lib/api/types';

type Mine = Ok<'/v1/queries/affiliate.mine'>;
export type CodeRow = NonNullable<Mine['affiliate']>['codes'][number];
export type CodePlan = Mine['plans'][number];

/** What the form makes: `affiliate.make_code`'s input, which staff's command takes too. */
export interface NewCode {
  code: string;
  offerId: string | null;
  percentOffBp: number | null;
  amountOffCents: number | null;
  discountMonths: number | null;
  trialDays: 7 | 14 | 30 | null;
}

const selectClass = 'h-10 w-full rounded-control border border-border bg-card px-2.5 text-sm';

/** The codes, newest first. `onTurn` is left out where the reader may not turn them. */
export function AffiliateCodeList({
  codes,
  plans,
  onTurn,
  busy,
  asStaff,
}: {
  codes: readonly CodeRow[];
  plans: readonly CodePlan[];
  onTurn?: (code: CodeRow, on: boolean) => void;
  busy?: boolean;
  /** Staff may turn back on a code they turned off; an affiliate may not. */
  asStaff?: boolean;
}) {
  if (codes.length === 0) return <p className="mt-2 text-[13px] text-text-3">{W.none}</p>;
  return (
    <ul className="mt-2 flex flex-col gap-3" data-testid="affiliate-codes">
      {codes.map((c) => {
        const plan = c.offerId ? plans.find((p) => p.offerId === c.offerId) : null;
        const mayTurnOn = asStaff || !c.offByStaff;
        return (
          <li
            key={c.codeId}
            className="rounded-menu border border-border p-3"
            data-testid={`affiliate-code-${c.code}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[13.5px] font-semibold">{c.code}</span>
              <Badge variant={c.status === 'on' ? 'ok' : 'gray'}>
                {c.status === 'on' ? W.on : c.offByStaff ? W.offByStaff : W.off}
              </Badge>
            </div>
            <p className="mt-1 text-[13px] text-text-2">
              {affiliateCodeDealWords(c)} ·{' '}
              {plan
                ? `${plan.name}, ${foundingPriceWords(plan.priceCents, plan.billing)}`
                : W.anyPlan}
            </p>
            <p className="mt-0.5 text-[12.5px] text-text-3">{W.uses(c.paidUses)}</p>
            {c.status === 'on' ? (
              <CopyField
                className="mt-2"
                value={affiliateCodeLink(c.code)}
                label={W.copyLink}
                copied={W.copied}
              />
            ) : null}
            {onTurn && (c.status === 'on' || mayTurnOn) ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                disabled={busy}
                onClick={() => onTurn(c, c.status !== 'on')}
                data-testid={`affiliate-code-turn-${c.code}`}
              >
                {c.status === 'on' ? W.turnOff : W.turnOn}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type Kind = 'percent' | 'dollars' | 'trial';

/** Making a code. `maxDiscountBp` is the limit for whoever it's for; `onMake` runs the command and throws a refusal. */
export function MakeCodeForm({
  plans,
  maxDiscountBp,
  onMake,
}: {
  plans: readonly CodePlan[];
  maxDiscountBp: number;
  onMake: (code: NewCode) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [offerId, setOfferId] = useState('');
  const [kind, setKind] = useState<Kind>('percent');
  const [amount, setAmount] = useState('');
  const [forGood, setForGood] = useState(true);
  const [months, setMonths] = useState('3');
  const [trial, setTrial] = useState<'' | '7' | '14' | '30'>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const limit = affiliateRateWords(maxDiscountBp);
  const forPlans = offerId ? plans.filter((p) => p.offerId === offerId) : plans;
  const cheapest = forPlans.length ? Math.min(...forPlans.map((p) => p.priceCents)) : 0;
  const mostDollars = Math.floor((cheapest * maxDiscountBp) / 10_000);
  // A trial needs a plan paid by the month or the year.
  const trialPlans = plans.filter((p) => p.billing !== 'once');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setError(null);
    let percentOffBp: number | null = null;
    let amountOffCents: number | null = null;
    if (kind === 'percent') {
      percentOffBp = affiliatePercentToBp(amount);
      if (percentOffBp === null || percentOffBp > maxDiscountBp)
        return setErrors({ amount: W.percentProblem(limit) });
    } else if (kind === 'dollars') {
      amountOffCents = parseMoney(amount);
      if (!amountOffCents) return setErrors({ amount: W.dollarsProblem });
    }
    const discountMonths = kind === 'trial' || forGood ? null : Number(months);
    if (
      discountMonths !== null &&
      !(Number.isInteger(discountMonths) && discountMonths >= 1 && discountMonths <= 36)
    )
      return setErrors({ months: W.monthsProblem });
    const trialDays = trial ? (Number(trial) as 7 | 14 | 30) : null;
    if (kind === 'trial' && !trialDays) return setErrors({ trialDays: W.pickSomething });
    setBusy(true);
    try {
      await onMake({
        code,
        offerId: offerId || null,
        percentOffBp,
        amountOffCents,
        discountMonths,
        trialDays,
      });
      setCode('');
      setAmount('');
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-4" data-testid="affiliate-make-code">
      <Field label={W.code} htmlFor="code-code" hint={W.codeShape} error={errors.code}>
        <Input
          id="code-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          invalid={Boolean(errors.code)}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          required
          data-testid="code-code"
        />
      </Field>
      <Field label={W.plan} htmlFor="code-plan" error={errors.offerId}>
        <select
          id="code-plan"
          value={offerId}
          onChange={(e) => setOfferId(e.target.value)}
          className={selectClass}
          data-testid="code-plan"
        >
          <option value="">{W.anyPlan}</option>
          {plans.map((p) => (
            <option key={p.offerId} value={p.offerId}>
              {p.name}, {foundingPriceWords(p.priceCents, p.billing)}
            </option>
          ))}
        </select>
      </Field>
      <div>
        <p className="mb-1.5 text-[13px] font-medium">{W.kind}</p>
        <Segmented<Kind>
          value={kind}
          onChange={setKind}
          ariaLabel={W.kind}
          options={[
            { value: 'percent', label: W.percent, testId: 'code-kind-percent' },
            { value: 'dollars', label: W.dollars, testId: 'code-kind-dollars' },
            { value: 'trial', label: W.trialOnly, testId: 'code-kind-trial' },
          ]}
        />
      </div>
      {kind !== 'trial' ? (
        <>
          <Field
            label={W.amount}
            htmlFor="code-amount"
            hint={kind === 'percent' ? W.percentHelp(limit) : W.dollarsHelp(money(mostDollars))}
            error={errors.amount ?? errors.percentOffBp ?? errors.amountOffCents}
          >
            <Input
              id="code-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={kind === 'percent' ? '20' : '10'}
              className="w-36"
              data-testid="code-amount"
            />
          </Field>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{W.howLong}</p>
            <Segmented<'good' | 'months'>
              value={forGood ? 'good' : 'months'}
              onChange={(v) => setForGood(v === 'good')}
              ariaLabel={W.howLong}
              options={[
                { value: 'good', label: W.forGood, testId: 'code-for-good' },
                { value: 'months', label: W.forMonths, testId: 'code-for-months' },
              ]}
            />
          </div>
          {forGood ? null : (
            <Field
              label={W.months}
              htmlFor="code-months"
              hint={W.monthsHelp}
              error={errors.months ?? errors.discountMonths}
            >
              <Input
                id="code-months"
                inputMode="numeric"
                value={months}
                onChange={(e) => setMonths(e.target.value)}
                className="w-24"
                data-testid="code-months"
              />
            </Field>
          )}
        </>
      ) : null}
      {trialPlans.length ? (
        <Field label={W.trial} htmlFor="code-trial" error={errors.trialDays}>
          <select
            id="code-trial"
            value={trial}
            onChange={(e) => setTrial(e.target.value as typeof trial)}
            className={selectClass}
            data-testid="code-trial"
          >
            {kind === 'trial' ? null : <option value="">{W.noTrial}</option>}
            {kind === 'trial' && !trial ? <option value="">—</option> : null}
            {AFFILIATE_TRIAL_DAYS.map((d) => (
              <option key={d} value={String(d)}>
                {W.trialDays(d)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={busy} data-testid="code-make">
        {busy ? W.making : W.make}
      </Button>
    </form>
  );
}
