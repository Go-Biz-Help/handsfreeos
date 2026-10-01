import { deskSectionLabel, RATES_WORDS } from '@hfos/core';
import { RatesTable } from '@/components/admin/rates-table';
import { apiServer, unwrapPage } from '@/lib/api/server';

/**
 * The usage rate card, and whether it is holding (M16, step 8).
 *
 * The margin column is the reason this page exists. The seeded prices are Twilio's and Anthropic's list prices
 * and are guesses until a real week measures them; a guess that is wrong loses money quietly for a month.
 * Anything under 1.2× is flagged here, which is the standing alert the plan asks for.
 */
export default async function RatesPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days } = await searchParams;
  const window = Math.min(365, Math.max(1, Number(days ?? 30) || 30));
  const { api } = await apiServer();
  const card = unwrapPage(await api.POST('/v1/queries/platform.rates', { body: { days: window } }));
  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('rates')}</h1>
        <p className="text-[13px] text-text-3">{RATES_WORDS.measured(card.version, window)}</p>
      </div>
      <RatesTable card={card} />
    </div>
  );
}
