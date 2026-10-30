'use client';

import { type CSSProperties, useState } from 'react';
import { Check } from '@/components/ui';
import { ours, roughUsd, stack, usd } from '@/content/savings';

/**
 * The home page's bill, made the visitor's own: every tool HandsFreeOS replaces starts ticked, and unticking the ones
 * they don't pay for shows their own total and what comes back a year. Nobody pays for all eleven, and a total built
 * from their own ticks is believed in a way the example business's never is.
 *
 * The prices are content/savings.ts's, unchanged: each company's public price for the plan named, linked under the
 * bill. When what they tick costs less than HandsFreeOS, it says so plainly rather than inventing a saving.
 */

const nth = (index: number) => ({ '--i': index }) as CSSProperties;

export function BillBuilder() {
  const live = stack.filter((t) => t.live);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(live.map((t) => t.id)));
  const picked = live.filter((t) => ticked.has(t.id));
  const total = picked.reduce((sum, t) => sum + t.monthly, 0);
  const yearly = { low: (total - ours.high) * 12, high: (total - ours.low) * 12 };
  const toggle = (id: string) =>
    setTicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <p className="text-text-3 text-sm font-medium">
        What the tools cost, a month. Untick the ones you don&rsquo;t pay for.
      </p>
      <ul className="divide-border mt-4 divide-y">
        {live.map((tool, index) => {
          const on = ticked.has(tool.id);
          return (
            <li key={tool.id} style={nth(index)}>
              <label className="group flex cursor-pointer items-center gap-3 py-2.5">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(tool.id)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border transition-colors duration-150 peer-focus-visible:shadow-[0_0_0_3px_var(--ring)] ${
                    on ? 'bg-accent border-accent text-white' : 'border-border-strong bg-card'
                  }`}
                >
                  {on ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
                <span
                  className={`min-w-0 flex-1 transition-colors duration-150 ${on ? 'text-text-2' : 'text-text-3'}`}
                >
                  {tool.job}
                  <span className="text-text-3 block text-xs">{tool.product}</span>
                </span>
                <span
                  className={`relative shrink-0 font-semibold tabular-nums transition-colors duration-150 ${
                    on ? 'text-text-2' : 'text-text-3 opacity-60'
                  }`}
                >
                  {usd(tool.monthly)}
                  {on ? (
                    <span
                      aria-hidden="true"
                      className="chore-strike bg-accent absolute top-1/2 -right-1 -left-1 h-[2px] -translate-y-1/2 rounded-full"
                    />
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="border-border-strong mt-2 flex items-baseline justify-between gap-4 border-t pt-4">
        <span className="text-text-2 font-semibold">
          {picked.length} {picked.length === 1 ? 'bill' : 'bills'} a month
        </span>
        <span className="text-text-3 font-semibold tabular-nums line-through">{usd(total)}</span>
      </div>
      <div
        className="bg-accent-soft mt-4 flex items-center justify-between gap-4 rounded-[14px] px-4 py-3.5"
        style={nth(live.length)}
      >
        <span className="flex items-center gap-2 font-semibold">
          <Check className="task-tick text-success" />
          HandsFreeOS
        </span>
        <span className="text-lg font-bold tabular-nums">
          {usd(ours.low)}–{usd(ours.high)}
        </span>
      </div>
      <p className="mt-5 text-center" aria-live="polite">
        {yearly.low > 0 ? (
          <>
            <span className="text-text-2 block text-sm font-medium">Back in your pocket</span>
            <span className="text-success-text block text-3xl font-bold tracking-[-0.02em] tabular-nums sm:text-4xl">
              {roughUsd(yearly.low)}–{roughUsd(yearly.high)}
            </span>
            <span className="text-text-3 block text-sm">a year</span>
          </>
        ) : (
          <span className="text-text-2 block text-sm">
            That&rsquo;s less than HandsFreeOS on its own. What you&rsquo;d get is the rest: the AI
            answering, booking and chasing for you.
          </span>
        )}
      </p>
    </>
  );
}
