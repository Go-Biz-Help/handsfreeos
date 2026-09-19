import { whenWords } from '@/components/admin/ticket-bits';
import { apiServer, unwrapPage } from '@/lib/api/server';

/** What has gone wrong lately, everywhere. The point is to find it before a customer does. */
export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  const { hours } = await searchParams;
  const window = Math.min(168, Math.max(1, Number(hours ?? 24) || 24));
  const { api } = await apiServer();
  const health = unwrapPage(
    await api.POST('/v1/queries/platform.health.summary', { body: { hours: window } }),
  );
  const cards = [
    { label: 'Background jobs that failed', value: health.failedJobs.count },
    { label: 'Webhooks that failed', value: health.failedDeliveries.count },
    { label: 'Emails that bounced', value: health.emailBounces.count },
    { label: 'Texts that failed', value: health.failedTexts.count },
    { label: 'Payments that failed', value: health.paymentFailures.count },
    { label: 'Calls with no words', value: health.lostTranscripts.count },
    { label: 'Work still queued', value: health.outboxBacklog },
  ];
  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">Health</h1>
        <p className="text-[13px] text-text-3">
          Since {whenWords(health.since)}
          {health.oldestPendingMinutes !== null && health.oldestPendingMinutes > 5
            ? ` · oldest queued job ${health.oldestPendingMinutes} minutes old`
            : ''}
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

      <section className="mt-6 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">The last few</h2>
        {health.recent.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3">
            Nothing has failed in this window. Enjoy it.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2.5 text-[13px]">
            {health.recent.map((r, i) => (
              <li key={`${r.at}-${i}`} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{r.kind}</span>
                <span className="text-text-3">{r.business ?? 'no business'}</span>
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
