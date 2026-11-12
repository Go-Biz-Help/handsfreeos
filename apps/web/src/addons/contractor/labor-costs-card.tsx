'use client';
/**
 * What an hour of each person costs the business (docs/contractor.md, "Time and job costing"; the owner's decision
 * 10): their pay, taxes and whatever else the business counts. It turns the time tracked on a job into its labor
 * cost. Seen by people who may see job costs and changed by the people who OK estimates (`contractor.approve`), one
 * person at a time; empty takes a person's cost off, and they count at the labor cost in Estimating.
 */
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { money, parseMoney } from '@hfos/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { LaborRate, LaborRateList } from './types';
import { useAct } from './use-act';

const L = CONTRACTOR_WORDS.laborCosts;

export function LaborCostsCard({
  workspaceId,
  rates,
}: {
  workspaceId: string;
  rates: LaborRateList;
}) {
  return (
    <Card className="mt-6 p-0" data-testid="contractor-labor-costs">
      <div className="border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">{L.title}</h2>
        <p className="mt-0.5 text-[13px] text-text-2">{L.hint}</p>
      </div>
      <ul>
        {rates.people.map((p) => (
          <RateRow
            key={p.userId}
            workspaceId={workspaceId}
            person={p}
            canChange={rates.canChange}
          />
        ))}
      </ul>
      <div className="space-y-1 border-t border-border px-5 py-3 text-[12.5px] text-text-3">
        <p data-testid="labor-fallback">
          {rates.fallbackCents > 0 ? L.fallback(money(rates.fallbackCents)) : L.noFallback}
        </p>
        <p>{rates.canChange ? L.fromNow : L.readOnly}</p>
      </div>
    </Card>
  );
}

function RateRow({
  workspaceId,
  person,
  canChange,
}: {
  workspaceId: string;
  person: LaborRate;
  canChange: boolean;
}) {
  const { busy, act } = useAct();
  const start = person.costCents === null ? '' : money(person.costCents);
  const [text, setText] = useState(start);
  const blank = text.trim() === '';
  const cents = blank ? null : parseMoney(text);
  const invalid = !blank && cents === null;
  const changed = !invalid && cents !== person.costCents;
  const save = () =>
    void act(
      'save',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/contractor.labor_rate.set', {
            body: { workspaceId, userId: person.userId, costCents: cents },
          }),
        ),
      cents === null ? L.cleared(person.name) : L.saved(person.name),
    );
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
      data-testid={`labor-row-${person.name}`}
    >
      <span className="min-w-[160px] flex-1 truncate text-[13.5px] font-medium">{person.name}</span>
      <Input
        inputSize="sm"
        inputMode="decimal"
        autoComplete="off"
        className="w-[112px] text-right tabular-nums"
        aria-label={`${L.cost}: ${person.name}`}
        placeholder={L.notSet}
        value={text}
        invalid={invalid}
        disabled={!canChange}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && changed) save();
        }}
        data-testid="labor-cost-input"
      />
      {canChange ? (
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'save'}
          disabled={!changed}
          onClick={save}
          data-testid="labor-cost-save"
        >
          {L.save}
        </Button>
      ) : null}
    </li>
  );
}
