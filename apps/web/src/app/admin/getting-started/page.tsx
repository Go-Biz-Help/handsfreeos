import {
  DESK_ONBOARDING_DEFAULT_WINDOW,
  DESK_ONBOARDING_WINDOWS,
  DESK_ONBOARDING_WORDS,
  deskMatomoPagesUrl,
  deskOnboardingCards,
  deskOnboardingWindow,
  deskSectionLabel,
  stepTitle,
} from '@hfos/core';
import Link from 'next/link';
import { Fragment } from 'react';
import { whenWords } from '@/components/admin/ticket-bits';
import { apiServer, unwrap } from '@/lib/api/server';
import { cn } from '@/lib/utils';

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
  // The windows the page offers; anything else in the address is read as the default.
  const window = deskOnboardingWindow(days);
  const { api } = await apiServer();
  const c = unwrap(
    await api.POST('/v1/queries/platform.onboarding.counts', { body: { days: window } }),
  );
  const cards = deskOnboardingCards(c);

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="onboarding-counts">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('getting-started')}</h1>
        <p className="text-[13px] text-text-3">{DESK_ONBOARDING_WORDS.since(whenWords(c.since))}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {DESK_ONBOARDING_WINDOWS.map((d) => (
          <Link
            key={d}
            href={
              d === DESK_ONBOARDING_DEFAULT_WINDOW
                ? '/admin/getting-started'
                : `/admin/getting-started?days=${d}`
            }
            aria-current={d === window ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center rounded-control px-3 text-[13px] font-medium',
              d === window ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-card-2',
            )}
          >
            {DESK_ONBOARDING_WORDS.lastDays(d)}
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
          <h2 className="text-sm font-semibold">{DESK_ONBOARDING_WORDS.skippedTitle}</h2>
          <p className="mt-1 text-[13px] text-text-3">{DESK_ONBOARDING_WORDS.skippedExplain}</p>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 border-t border-border px-4 py-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          <span>{DESK_ONBOARDING_WORDS.step}</span>
          <span className="w-14 text-right sm:w-16">{DESK_ONBOARDING_WORDS.skipped}</span>
          <span className="w-20 text-right sm:w-28">{DESK_ONBOARDING_WORDS.broughtBack}</span>
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
                <span className="text-xs text-text-3">{DESK_ONBOARDING_WORDS.stepFor[s.for]}</span>
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
        <h2 className="text-sm font-semibold">{DESK_ONBOARDING_WORDS.howFarTitle}</h2>
        <p className="mt-1 text-[13px] text-text-2">
          {DESK_ONBOARDING_WORDS.howFar.map((part, i) => (
            <Fragment key={i}>
              {typeof part === 'string' ? part : <code className="text-xs">{part.code}</code>}
            </Fragment>
          ))}
          <a
            href={deskMatomoPagesUrl(window)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text hover:underline"
          >
            {DESK_ONBOARDING_WORDS.openMatomo}
          </a>
        </p>
      </section>
    </div>
  );
}
