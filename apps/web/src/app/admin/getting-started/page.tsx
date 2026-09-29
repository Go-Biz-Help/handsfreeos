import { stepTitle } from '@hfos/core';
import Link from 'next/link';
import { whenWords } from '@/components/admin/ticket-bits';
import { apiServer, unwrap } from '@/lib/api/server';
import { cn } from '@/lib/utils';

/** The windows the page offers; anything else in the address is read as the default. */
const WINDOWS = [7, 30, 90] as const;

/** Matomo's Pages report for the web app (site 5, `components/matomo.tsx`), over the same days. */
const matomoPages = (days: number) =>
  `https://gobizhelp.matomo.cloud/index.php?module=CoreHome&action=index&idSite=5&period=range&date=last${days}` +
  `#?idSite=5&period=range&date=last${days}&category=General_Actions&subcategory=General_Pages`;

/**
 * How Getting started is going, everywhere (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §9): how many businesses
 * answer the quick questions, which steps they skip, and how many finish. Counted from the onboarding events;
 * how far people get through the wizard's pages is Matomo's half.
 */
export default async function GettingStartedCountsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days } = await searchParams;
  const window = WINDOWS.find((d) => d === Number(days)) ?? 30;
  const { api } = await apiServer();
  const c = unwrap(
    await api.POST('/v1/queries/platform.onboarding.counts', { body: { days: window } }),
  );
  const cards = [
    { label: 'Answered the quick questions', value: c.started, id: 'started' },
    {
      label: 'Finished setting up',
      value: c.finished.businesses,
      note: `${c.finished.nothingSkipped} with nothing skipped`,
      id: 'finished',
    },
    { label: 'Teammates who finished', value: c.finished.teammates, id: 'teammates' },
    { label: 'Adding customers as they go', value: c.asYouGo, id: 'as-you-go' },
    { label: 'People who hid the guide', value: c.hidden, id: 'hidden' },
    { label: 'Businesses that turned it off', value: c.turnedOff, id: 'turned-off' },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="onboarding-counts">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">Getting started</h1>
        <p className="text-[13px] text-text-3">Since {whenWords(c.since)}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {WINDOWS.map((d) => (
          <Link
            key={d}
            href={d === 30 ? '/admin/getting-started' : `/admin/getting-started?days=${d}`}
            aria-current={d === window ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center rounded-control px-3 text-[13px] font-medium',
              d === window ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-card-2',
            )}
          >
            Last {d} days
          </Link>
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.id}
            className="rounded-card border border-border bg-card px-4 py-3"
            data-testid={`onboarding-count-${card.id}`}
          >
            <dt className="text-[13px] text-text-3">{card.label}</dt>
            <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{card.value}</dd>
            {card.note ? <dd className="text-xs text-text-3">{card.note}</dd> : null}
          </div>
        ))}
      </dl>

      <section className="mt-6 overflow-hidden rounded-card border border-border bg-card">
        <div className="px-4 pb-2 pt-4">
          <h2 className="text-sm font-semibold">Skipped steps</h2>
          <p className="mt-1 text-[13px] text-text-3">
            Most skipped first. A business counts once per step, however often it skips it; a step
            on someone’s own list counts people.
          </p>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 border-t border-border px-4 py-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          <span>Step</span>
          <span className="w-14 text-right sm:w-16">Skipped</span>
          <span className="w-20 text-right sm:w-28">Brought back</span>
        </div>
        <ul className="divide-y divide-border border-t border-border">
          {c.steps.map((s) => (
            <li
              key={s.key}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-4 px-4 py-2.5"
              data-testid={`onboarding-step-${s.key}`}
            >
              <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                <span className="text-sm font-medium">{stepTitle(s.key)}</span>
                <span className="text-xs text-text-3">
                  {s.for === 'business' ? 'Business' : 'Own list'}
                </span>
              </span>
              <span className="w-14 text-right text-sm tabular-nums sm:w-16">{s.skipped}</span>
              <span className="w-20 text-right text-sm tabular-nums text-text-2 sm:w-28">
                {s.broughtBack}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">How far people get</h2>
        <p className="mt-1 text-[13px] text-text-2">
          Each wizard step is its own page, so Matomo’s page views show the way through: from{' '}
          <code className="text-xs">onboarding</code> to the questions, then each{' '}
          <code className="text-xs">onboarding/:id/setup/…</code> step.{' '}
          <a
            href={matomoPages(window)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text hover:underline"
          >
            Open the pages report in Matomo
          </a>
        </p>
      </section>
    </div>
  );
}
