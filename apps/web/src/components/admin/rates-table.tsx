import { money } from '@hfos/core';
import { Card } from '@/components/ui/card';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type RateCard = Ok<'/v1/queries/platform.rates'>;
type Line = RateCard['lines'][number];

/** The promise: at least one and a half times what it cost us. Below this, somebody looks today. */
const MARGIN_FLOOR = 1.2;

/** Our own cost, which only staff ever see: micro-dollars are unreadable, so it is shown per unit. */
const costWords = (micros: number): string =>
  micros >= 10_000 ? money(Math.round(micros / 10_000)) : `${(micros / 10_000).toFixed(3)}¢`;

function Realised({ line }: { line: Line }) {
  if (!line.realised) return <span className="text-text-3">—</span>;
  const { markup, events, chargedCents, costCents } = line.realised;
  const thin = markup < MARGIN_FLOOR;
  return (
    <span className={cn('font-mono', thin ? 'text-danger-text' : 'text-text-2')}>
      {markup.toFixed(2)}×
      <span className="ml-2 text-xs text-text-3">
        {events} · {money(chargedCents)} on {money(costCents)}
      </span>
    </span>
  );
}

export function RatesTable({ card }: { card: RateCard }) {
  const thin = card.lines.filter((l) => l.realised && l.realised.markup < MARGIN_FLOOR);
  return (
    <div className="mt-5 flex flex-col gap-4">
      {thin.length ? (
        <p className="rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
          {thin.length === 1 ? 'One line is' : `${thin.length} lines are`} charging under{' '}
          {MARGIN_FLOOR}× what {thin.length === 1 ? 'it costs' : 'they cost'} us:{' '}
          {thin.map((l) => l.key).join(', ')}. Either the cost moved or the price is wrong.
        </p>
      ) : null}
      <Card className="divide-y divide-border">
        <div className="grid grid-cols-[minmax(0,2fr)_90px_90px_minmax(0,1.4fr)] gap-3 px-4 py-2 text-[12px] font-medium uppercase tracking-wide text-text-3">
          <span>What</span>
          <span className="text-right">Costs us</span>
          <span className="text-right">Charged</span>
          <span>Realised</span>
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
            <span className="text-right font-mono text-text-2">{costWords(line.costMicros)}</span>
            <span className="text-right font-mono">
              {money(line.unitPriceCents)}
              <span className="block text-xs text-text-3">
                {(line.markupBp / 10_000).toFixed(2)}×
              </span>
            </span>
            <Realised line={line} />
          </div>
        ))}
      </Card>
      <p className="text-[13px] text-text-3">
        Publishing a new version retires every live line at once, so a card is never half old and
        half new. It is not editable here yet: use <code>private.publish_usage_rates</code>.
      </p>
    </div>
  );
}
