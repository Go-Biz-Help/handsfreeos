'use client';
/**
 * The Assistant's money card (M9): a total the worker worked out, and the documents behind it.
 *
 * Every figure here arrives already formatted from a real query — the model never writes an amount. A card
 * from a chat saved before M9 has no `money` type at all, and everything past the headline is optional, so an
 * older card that only ever carried a total still draws.
 */
import type { AssistantCard } from '@hfos/core';
import { cn } from '@/lib/utils';
import { cardHead, cardRow, cardShell, Dot, RowLink } from './card-parts';

type MoneyCardData = Extract<AssistantCard, { type: 'money' }>;

const STAT_COLUMNS = ['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'];

const VALUE_TONE: Readonly<Record<string, string>> = {
  danger: 'text-danger-text',
  warning: 'text-warning-text',
  muted: 'text-text-2',
  accent: 'text-text',
};

const openLabel = (href: string) =>
  /\/money\/estimates(\?|$)/.test(href)
    ? 'Open estimates'
    : /\/money\/payments(\?|$)/.test(href)
      ? 'Open payments'
      : /\/money\/plans(\?|$)/.test(href)
        ? 'Open plans'
        : /\/money(\?|$)/.test(href)
          ? 'Open invoices'
          : 'Open';

export function MoneyCard({ card }: { card: MoneyCardData }) {
  const stats = card.stats ?? [];
  const items = card.items ?? [];
  return (
    <div className={cardShell} data-testid="assistant-card-money">
      <div className={cn(cardHead, 'items-end')}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs text-text-3">{card.title}</span>
          <span
            className={cn(
              'text-[22px] font-semibold leading-[1.15] tracking-[-0.01em] tabular-nums',
              VALUE_TONE[card.tone ?? 'accent'] ?? 'text-text',
            )}
            data-testid="assistant-money-value"
          >
            {card.value}
          </span>
        </span>
        {card.detail ? (
          <span className="max-w-[55%] flex-none text-right text-xs text-text-3">
            {card.detail}
          </span>
        ) : null}
      </div>
      {stats.length ? (
        <div className={cn('grid border-t border-border', STAT_COLUMNS[stats.length - 1])}>
          {stats.map((s, i) => (
            <div key={i} className="min-w-0 border-r border-border px-3.5 py-2.5 last:border-r-0">
              <div className="truncate text-[13px] font-medium tabular-nums">{s.value}</div>
              <div className="truncate text-xs text-text-3">{s.label}</div>
            </div>
          ))}
        </div>
      ) : null}
      {items.map((item, i) => {
        const inner = (
          <>
            <Dot tone={item.tone} />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <span className="max-w-[45%] flex-none truncate text-xs text-text-3">
              {item.detail}
              {item.status ? ` · ${item.status}` : ''}
            </span>
          </>
        );
        return item.href ? (
          <RowLink key={i} href={item.href}>
            {inner}
          </RowLink>
        ) : (
          <div key={i} className={cardRow}>
            {inner}
          </div>
        );
      })}
      {card.href ? (
        <RowLink href={card.href}>
          <span className="min-w-0 flex-1 truncate font-medium text-accent-text">
            {openLabel(card.href)}
          </span>
        </RowLink>
      ) : null}
    </div>
  );
}
