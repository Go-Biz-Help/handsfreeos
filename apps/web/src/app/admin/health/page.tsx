import { DESK_HEALTH_WORDS, deskHealthCards, deskHealthHours, deskSectionLabel } from '@hfos/core';
import { AiProviderBlock } from '@/components/admin/ai-provider-block';
import { whenWords } from '@/components/admin/ticket-bits';
import { apiServer, unwrap, unwrapPage } from '@/lib/api/server';

/** What has gone wrong lately, everywhere. The point is to find it before a customer does. */
export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  const { hours } = await searchParams;
  const window = deskHealthHours(hours);
  const { api } = await apiServer();
  const [health, ai, me] = await Promise.all([
    api.POST('/v1/queries/platform.health.summary', { body: { hours: window } }).then(unwrapPage),
    // Which AI answers gets its own section: when it can't be read, the rest of the page still can.
    api.POST('/v1/queries/platform.ai_provider.get', { body: {} }).then((r) => r.data ?? null),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  const cards = deskHealthCards(health);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('health')}</h1>
        <p className="text-[13px] text-text-3">
          {DESK_HEALTH_WORDS.since(whenWords(health.since), health.oldestPendingMinutes)}
        </p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card border border-border bg-card px-4 py-3">
            <dt className="text-[13px] text-text-3">{c.label}</dt>
            <dd
              className={
                c.value > 0
                  ? 'mt-0.5 text-2xl font-semibold tabular-nums text-danger-text'
                  : 'mt-0.5 text-2xl font-semibold tabular-nums'
              }
            >
              {c.value}
            </dd>
          </div>
        ))}
      </dl>

      <AiProviderBlock
        ai={ai}
        canChange={me.staff?.permissions.includes('platform.ai.manage') ?? false}
      />

      <section className="mt-6 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{DESK_HEALTH_WORDS.lastFew}</h2>
        {health.recent.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3">{DESK_HEALTH_WORDS.nothingFailed}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2.5 text-[13px]">
            {health.recent.map((r, i) => (
              <li key={`${r.at}-${i}`} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{r.kind}</span>
                <span className="text-text-3">{r.business ?? DESK_HEALTH_WORDS.noBusiness}</span>
                <span className="text-text-3">· {whenWords(r.at)}</span>
                <span className="w-full break-words text-text-2">{r.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
