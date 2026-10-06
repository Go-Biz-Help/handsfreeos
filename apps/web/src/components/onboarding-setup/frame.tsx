/**
 * The onboarding setup's frame (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): a page of its own
 * outside the app's sidebar, with "Finish later" once the business is made, and one card holding a screen's
 * question beside the summary of the setup so far. The screens fill it in.
 */
import { ONBOARDING_SETUP_WORDS, WIZARD_WORDS } from '@hfos/core';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Brand } from '@/components/ui/brand';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function SetupPage({
  business,
  email,
  children,
}: {
  /** The business being set up, once it's made: its name, and Home for "Finish later". */
  business: { readonly name: string; readonly home: string } | null;
  /** Who's signed in, under the card. */
  email: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <header className="flex h-16 flex-none items-center justify-between gap-3 px-4 md:px-6">
        {business ? (
          <Link href={business.home} aria-label="Home">
            <Brand size={28} />
          </Link>
        ) : (
          <Brand size={28} />
        )}
        {business ? (
          <>
            <span className="hidden truncate text-[13px] text-text-2 sm:block">
              {WIZARD_WORDS.settingUp(business.name)}
            </span>
            <ButtonLink
              href={`${business.home}?tour=1`}
              variant="ghost"
              data-testid="onboarding-setup-finish-later"
            >
              {WIZARD_WORDS.finishLater}
            </ButtonLink>
          </>
        ) : null}
      </header>
      <main className="mx-auto flex w-full max-w-[1080px] flex-1 flex-col items-center gap-4 px-4 pb-12 pt-2 sm:px-6">
        {children}
        <p className="text-[13px] text-text-3">Signed in as {email}</p>
      </main>
    </div>
  );
}

export function SetupCard({
  screen,
  counter,
  title,
  hint,
  banner,
  footer,
  summary,
  children,
}: {
  screen: string;
  /** "3 of 13 · About your business". */
  counter: string;
  title: string;
  hint: string;
  /** Above the question: "Carry on where you left off". */
  banner?: ReactNode;
  footer: ReactNode;
  /** The summary beside the question, in plain sentences; none on the last screen, which is the summary. */
  summary: readonly string[] | null;
  children: ReactNode;
}) {
  return (
    <Card
      className={cn(
        'grid w-full grid-cols-1 overflow-hidden rounded-dialog',
        summary && 'md:grid-cols-[minmax(0,1fr)_320px]',
      )}
      data-testid="onboarding-setup"
      data-screen={screen}
    >
      <div className="flex min-w-0 scroll-mt-20 flex-col gap-[22px] p-5 sm:p-8">
        {banner}
        <div className="flex flex-col gap-1.5">
          <div
            className="text-xs font-medium uppercase tracking-[0.04em] text-text-3"
            data-testid="onboarding-setup-counter"
          >
            {counter}
          </div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
          {hint ? <p className="text-text-2">{hint}</p> : null}
        </div>
        {children}
        {footer}
      </div>
      {summary ? (
        <aside
          className="flex flex-col gap-3 border-t border-border bg-card-2 p-5 md:border-l md:border-t-0 md:px-[26px] md:py-8"
          aria-label={ONBOARDING_SETUP_WORDS.summary}
          data-testid="onboarding-setup-summary"
        >
          <div className="flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
            {ONBOARDING_SETUP_WORDS.summary}
          </div>
          <ul className="flex flex-col gap-2.5">
            {summary.map((line) => (
              <li key={line} className="text-[13.5px] leading-[1.45]">
                {line}
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </Card>
  );
}
