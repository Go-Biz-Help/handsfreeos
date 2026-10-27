'use client';
import {
  assistantCoverage,
  coverageCards,
  coverageGapsForClaude,
  DESK_COVERAGE_WORDS,
  deskSectionLabel,
} from '@hfos/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/client';

/**
 * What Ask HandsFreeOS can't do yet (assistant/coverage.ts), page by page in menu order, and **Copy gaps** to hand
 * them to Claude. Everything else a screen does, it does: the checks fail on a new button or setting until it's
 * covered or listed.
 */
export function AssistantCoverage() {
  const c = assistantCoverage();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(coverageGapsForClaude(c));
      toast.success(DESK_COVERAGE_WORDS.copied);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="assistant-coverage">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('assistant')}</h1>
          <p className="mt-1 text-[13px] text-text-3">{DESK_COVERAGE_WORDS.intro}</p>
        </div>
        <Button onClick={() => void copy()} data-testid="coverage-copy">
          {DESK_COVERAGE_WORDS.copy}
        </Button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {coverageCards(c).map((card) => (
          <div
            key={card.key}
            className="rounded-card border border-border bg-card px-4 py-3"
            data-testid={`coverage-card-${card.key}`}
          >
            <dt className="text-[13px] text-text-3">{card.label}</dt>
            <dd
              className={
                card.gap
                  ? 'mt-0.5 text-2xl font-semibold tabular-nums text-danger-text'
                  : 'mt-0.5 text-2xl font-semibold tabular-nums'
              }
            >
              {card.value}
            </dd>
          </div>
        ))}
      </dl>

      <section className="mt-6 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{DESK_COVERAGE_WORDS.notYetTitle}</h2>
        {c.notYet.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3">{DESK_COVERAGE_WORDS.notYetNone}</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-3 text-[13px]" data-testid="coverage-not-yet">
            {c.notYet.map((p) => (
              <li key={p.page}>
                <div className="font-medium">{p.page}</div>
                <p className="mt-0.5 text-text-2">{p.why}</p>
                <p className="mt-1 break-words font-mono text-[12px] text-text-3">
                  {p.actions.join(', ')}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-4 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{DESK_COVERAGE_WORDS.settingsTitle}</h2>
        <p className="mt-1 text-[13px] text-text-3">
          {c.settingsToCheck.length === 0
            ? DESK_COVERAGE_WORDS.settingsNone
            : DESK_COVERAGE_WORDS.settingsDetail}
        </p>
        {c.settingsToCheck.length ? (
          <ol className="mt-3 flex flex-col gap-3 text-[13px]" data-testid="coverage-settings">
            {c.settingsToCheck.map((p) => (
              <li key={p.key}>
                <div className="font-medium">
                  {p.label}{' '}
                  <span className="font-normal text-text-3">
                    · {DESK_COVERAGE_WORDS.rows(p.rows.length)}
                  </span>
                </div>
                <p className="mt-0.5 text-text-2">{p.rows.join(' · ')}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <details className="mt-4 rounded-card border border-border bg-card p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          {DESK_COVERAGE_WORDS.neverTitle}
        </summary>
        <p className="mt-1 text-[13px] text-text-3">{DESK_COVERAGE_WORDS.neverDetail}</p>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-[13px] md:grid-cols-[auto_1fr]">
          {c.never.map((n) => (
            <div key={n.command} className="contents">
              <dt className="break-all font-mono text-[12px] text-text-3">{n.command}</dt>
              <dd className="text-text-2">{n.why}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
