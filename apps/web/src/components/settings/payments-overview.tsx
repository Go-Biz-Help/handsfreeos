'use client';
/**
 * Settings → Payments (the owner, 23 Nov 2026, P3 a): one simple card, the way a calendar's page is. The account money
 * goes into, or Set up payments while there's none; the guided setup's answers, each with Change, which opens that
 * question; and every setting from before under All settings, so nothing the page could do is gone. All settings opens
 * by itself for a link to one setting (`#…`, settings search's `?all=1`), on the way back from a sign-in started there
 * (`?payments=`), and while something needs fixing. The lines are core's (paymentsSetupLines), shared with the phone.
 */
import {
  PAYMENT_PROVIDER_NAMES,
  PAYMENTS_SETUP_WORDS as W,
  type PaymentsSetupAccount,
  type PaymentsSetupLine,
} from '@hfos/core';
import { ArrowRight, ChevronDown, ChevronRight, CircleAlert, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function PaymentsOverview({
  workspaceId,
  businessName,
  account,
  lines,
  started,
  openAll,
  needsFixing,
  children,
}: {
  workspaceId: string;
  businessName: string;
  account: PaymentsSetupAccount | null;
  /** The answers as the settings give them; empty while the business hasn't set its payments up. */
  lines: readonly PaymentsSetupLine[];
  /** The guided setup has answers saved: Set up payments picks up where they left off. */
  started: boolean;
  /** `?all=1` or `?payments=`: All settings starts open. */
  openAll: boolean;
  needsFixing: boolean;
  /** Every setting from before (PaymentsSettings). */
  children: ReactNode;
}) {
  const setup = `/onboarding/${workspaceId}/payments`;
  const [open, setOpen] = useState(openAll || needsFixing);
  const allRef = useRef<HTMLDivElement>(null);
  // A link to one setting (`#tax-rate`) opens All settings, so the jump finds it. Settings search on this page
  // pushes `?all=1` (a push to the same page fires no `hashchange`), which arrives as `openAll`.
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash.length > 1 && !window.location.hash.includes('=')) setOpen(true);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  useEffect(() => {
    if (openAll) setOpen(true);
  }, [openAll]);

  const toggle = () => {
    setOpen((now) => {
      if (!now) requestAnimationFrame(() => allRef.current?.scrollIntoView({ block: 'start' }));
      return !now;
    });
  };
  const name = account ? PAYMENT_PROVIDER_NAMES[account.provider] : null;

  return (
    <div className="flex max-w-[980px] flex-col gap-4" data-testid="payments-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-text-2">{W.summary.howPaid(businessName)}</p>
        <Button
          variant="secondary"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="payments-all-settings"
          data-testid="payments-all-settings-toggle"
        >
          {open ? W.summary.hideAll : W.summary.allSettings}
          {open ? (
            <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
          )}
        </Button>
      </div>

      {needsFixing && !open ? (
        <Callout
          tone="warning"
          icon={CircleAlert}
          action={
            <Button size="sm" variant="secondary" onClick={toggle}>
              {W.summary.allSettings}
            </Button>
          }
        >
          {W.summary.fix}
        </Callout>
      ) : null}

      <Card className="flex flex-wrap items-center gap-3.5 p-5" data-testid="payments-account">
        <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
          <Wallet className="h-5 w-5" strokeWidth={1.75} />
        </span>
        {account && name ? (
          <>
            <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
                {account.label ? `${name}, ${account.label}` : name}
                <Badge
                  variant={
                    account.state === 'ready'
                      ? 'ok'
                      : account.state === 'checking'
                        ? 'pending'
                        : 'danger'
                  }
                  data-testid="payments-account-state"
                >
                  {W.summary.account[account.state]}
                </Badge>
              </span>
              <span className="text-[13px] text-text-2">
                {account.state === 'ready'
                  ? W.summary.account.readyHint
                  : account.state === 'checking'
                    ? W.summary.account.checkingHint(name)
                    : W.summary.account.brokenHint(name)}
              </span>
            </span>
            <ButtonLink
              href={`/app/w/${workspaceId}/settings/payments?all=1#payments-accounts`}
              onClick={() => setOpen(true)}
            >
              {W.summary.account.manage}
            </ButtonLink>
          </>
        ) : (
          <>
            <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
              <span className="text-[14.5px] font-semibold">{W.summary.setUp}</span>
              <span className="text-[13px] text-text-2">{W.summary.setUpHint}</span>
            </span>
            <ButtonLink href={setup} variant="primary" data-testid="payments-set-up">
              {started ? W.summary.resume : W.summary.start}
              <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
            </ButtonLink>
          </>
        )}
      </Card>

      {lines.length ? (
        <Card className="p-5" data-testid="payments-answers">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2.5">
            <h2 className="text-[15px] font-semibold">{W.summary.title}</h2>
            <Link
              href={setup}
              className="text-[13.5px] font-semibold text-accent-text hover:underline"
              data-testid="payments-again"
            >
              {W.summary.again}
            </Link>
          </div>
          <div>
            {lines.map((l, n) => (
              <div
                key={l.key}
                className={cn(
                  'flex flex-wrap items-start gap-x-4 gap-y-1 py-3',
                  n > 0 && 'border-t border-border',
                )}
                data-testid={`payments-answer-${l.key}`}
              >
                <span className="w-[180px] flex-none text-[13.5px] text-text-2">{l.label}</span>
                <span className="min-w-[180px] flex-1 text-[14px]">{l.value ?? '—'}</span>
                <Link
                  href={`${setup}?at=${l.key}`}
                  className="flex-none px-1 text-[13.5px] font-semibold text-accent-text hover:underline"
                  data-testid={`payments-answer-change-${l.key}`}
                >
                  {W.review.change}
                </Link>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {!open ? (
        <div className="rounded-card bg-card-2 px-5 py-4">
          <h2 className="mb-1 text-[14px] font-semibold">{W.summary.under}</h2>
          <p className="text-[13.5px] leading-relaxed text-text-2">{W.summary.underHint}</p>
        </div>
      ) : null}

      <div
        ref={allRef}
        id="payments-all-settings"
        className="scroll-mt-20"
        hidden={!open}
        data-testid="payments-all-settings"
      >
        {open ? children : null}
      </div>
    </div>
  );
}
