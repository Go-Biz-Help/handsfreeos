import {
  money,
  RATES_WORDS,
  rateCostWords,
  rateIsThin,
  rateMarkupWords,
  rateRealisedWords,
  rateThinWarning,
} from '@hfos/core';
import { Card } from '@/components/ui/card';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type RateCard = Ok<'/v1/queries/platform.rates'>;
type Line = RateCard['lines'][number];

function Realised({ line }: { line: Line }) {
  if (!line.realised) return <span className="text-text-3">{RATES_WORDS.nothingYet}</span>;
  return (
    <span className={cn('font-mono', rateIsThin(line) ? 'text-danger-text' : 'text-text-2')}>
      {rateMarkupWords(line.realised.markup)}
      <span className="ml-2 text-xs text-text-3">{rateRealisedWords(line.realised)}</span>
    </span>
  );
}

export function RatesTable({ card }: { card: RateCard }) {
  const thin = rateThinWarning(card.lines);
  return (
    <div className="mt-5 flex flex-col gap-4">
      {thin ? (
        <p className="rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
          {thin}
        </p>
      ) : null}
      <Card className="divide-y divide-border">
        <div className="grid grid-cols-[minmax(0,2fr)_90px_90px_minmax(0,1.4fr)] gap-3 px-4 py-2 text-[12px] font-medium uppercase tracking-wide text-text-3">
          <span>{RATES_WORDS.what}</span>
          <span className="text-right">{RATES_WORDS.costsUs}</span>
          <span className="text-right">{RATES_WORDS.charged}</span>
          <span>{RATES_WORDS.realised}</span>
        </div>
        {card.lines.map((line) => (
          <div
            key={line.key}
            className="grid grid-cols-[minmax(0,2fr)_90px_90px_minmax(0,1.4fr)] items-center gap-3 px-4 py-2.5 text-[13px]"
            data-testid={`rate-${line.key}`}
          >
            <div className="min-w-0">
              <span className="block truncate font-medium">{line.key}</span>
              <span className="block truncate text-xs text-text-3">{line.notes}</span>
            </div>
            <span className="text-right font-mono text-text-2">
              {rateCostWords(line.costMicros)}
            </span>
            <span className="text-right font-mono">
              {money(line.unitPriceCents)}
              <span className="block text-xs text-text-3">
                {rateMarkupWords(line.markupBp / 10_000)}
              </span>
            </span>
            <Realised line={line} />
          </div>
        ))}
      </Card>
      <p className="text-[13px] text-text-3">
        {RATES_WORDS.notEditable} <code>{RATES_WORDS.publishFunction}</code>.
      </p>
    </div>
  );
}
