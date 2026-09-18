'use client';
import { MONEY_TAB_LABELS, MONEY_TABS, type MoneyTab } from '@hfos/core';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type { MoneyTab };

export function moneyBase(workspaceId: string): string {
  return `/app/w/${workspaceId}/money`;
}

/** Invoices is the section's front door, so it has no path of its own. */
export function moneyTabHref(workspaceId: string, tab: MoneyTab): string {
  const base = moneyBase(workspaceId);
  return tab === 'invoices' ? base : `${base}/${tab}`;
}

const TABS = MONEY_TABS.map((key) => ({ key, label: MONEY_TAB_LABELS[key] }));

/** The four chips from the canvas, with each list's own filters sitting at the end of the same row. */
export function MoneySubnav({
  workspaceId,
  tab,
  children,
}: {
  workspaceId: string;
  tab: MoneyTab;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="mb-3.5 mt-4 flex flex-wrap items-center gap-2" data-testid="money-subnav">
      <nav aria-label="Money" className="flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => {
          const href = moneyTabHref(workspaceId, t.key);
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={href}
              aria-current={active ? 'page' : undefined}
              data-testid={`money-tab-${t.key}`}
              prefetch={pathname === href ? false : undefined}
              className={cn(
                'inline-flex h-8 flex-none items-center rounded-full border px-3 text-[13px] font-medium transition-colors max-md:h-11 max-md:px-4',
                active
                  ? 'border-transparent bg-accent-soft text-accent-text'
                  : 'border-border-strong bg-card text-text-2 hover:text-text',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children ? (
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/** Money › Estimates › EST-1042 — how you got here and how you get back. */
export function MoneyCrumbs({
  workspaceId,
  tab,
  current,
}: {
  workspaceId: string;
  tab: MoneyTab;
  current: string;
}) {
  // Left exactly as it was: Plans' and Payments' crumb reads lowercase today (see the step 16 report).
  const label = tab === 'invoices' ? 'Invoices' : tab === 'estimates' ? 'Estimates' : tab;
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-2.5 flex items-center gap-1.5 text-[13px] text-text-3"
      data-testid="money-crumbs"
    >
      <Link href={moneyBase(workspaceId)} className="hover:text-text-2">
        Money
      </Link>
      <span aria-hidden>›</span>
      <Link href={moneyTabHref(workspaceId, tab)} className="hover:text-text-2">
        {label}
      </Link>
      <span aria-hidden>›</span>
      <span className="font-medium text-text-2">{current}</span>
    </nav>
  );
}

/** The two buttons in the Money page header. Only owners and admins may raise a document. */
export function MoneyActions({ workspaceId }: { workspaceId: string }) {
  const base = moneyBase(workspaceId);
  return (
    <>
      <ButtonLink
        href={`${base}/estimates/new`}
        variant="secondary"
        className="max-md:h-11 max-md:flex-1"
        data-testid="money-new-estimate"
      >
        <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
        New estimate
      </ButtonLink>
      <ButtonLink
        href={`${base}/invoices/new`}
        className="max-md:h-11 max-md:flex-1"
        data-testid="money-new-invoice"
      >
        <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
        New invoice
      </ButtonLink>
    </>
  );
}
