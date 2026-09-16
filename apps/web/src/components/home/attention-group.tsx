'use client';
import { moneyLabel, type AttentionKind } from '@hfos/core';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import type { AttentionItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { HandleButton, ItemMenu } from './attention-actions';
import { Chips, KIND_LABEL_TONE, KindTile, ReasonChip } from './attention-bits';
import { CARD, FOOT_BUTTON, INDENT } from './attention-card';
import { useAttentionEnv } from './attention-context';
import {
  andList,
  customerOf,
  daysSpan,
  firstNameOf,
  groupTitle,
  KIND_LABEL,
  splitTitle,
  valueOf,
  type ShownChip,
} from './attention-words';

/** One item inside an opened group: who, what, whose, and its own main button and ⋯. */
function GroupRow({ item }: { item: AttentionItem }) {
  const env = useAttentionEnv();
  const name = customerOf(item) ?? item.title;
  const who = item.assignee
    ? item.assignee.id === env.myUserId
      ? 'you'
      : firstNameOf(item.assignee.fullName)
    : null;
  const more = [
    splitTitle(item.title).rest,
    item.kind === 'unconfirmed_appointment' ? item.detail : null,
    who,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      data-testid="attention-group-row"
      data-item={item.id}
      className="flex min-w-0 flex-wrap items-center gap-2.5 border-t border-border px-3.5 py-[9px] text-[13px] md:flex-nowrap md:pl-14"
    >
      <Avatar name={name} seed={item.personId ?? item.id} size="sm" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{name}</span>
        {more ? <span className="text-text-3"> · {more}</span> : null}
      </span>
      {item.valueCents > 0 && !item.valueIsEstimate ? (
        <ReasonChip
          chip={{ key: 'value', text: moneyLabel(item.valueCents), tone: 'money', icon: null }}
        />
      ) : null}
      <HandleButton
        item={item}
        variant="secondary"
        className={cn(FOOT_BUTTON, 'flex-1 md:flex-none')}
      />
      <ItemMenu item={item} />
    </div>
  );
}

/**
 * Three or more lower items of one kind, folded into one card: "Unconfirmed appointments · 4 customers", who they
 * are, what's at stake, and Show all to act on each.
 */
export function AttentionGroup({
  kind,
  items,
}: {
  kind: AttentionKind;
  items: readonly AttentionItem[];
}) {
  const env = useAttentionEnv();
  const [open, setOpen] = useState(false);
  const { title, count } = groupTitle(kind, items.length);
  const value = valueOf(items);
  const days = kind === 'unconfirmed_appointment' ? daysSpan(items, env.timeZone, env.now) : null;
  const chips: ShownChip[] = [
    ...(value > 0
      ? [{ key: 'value', text: moneyLabel(value), tone: 'money', icon: null } as const]
      : []),
    ...(days ? [{ key: 'days', text: days, tone: 'time', icon: 'clock' } as const] : []),
  ];
  return (
    <article data-testid="attention-group" data-kind={kind} className={cn(CARD, 'pb-3')}>
      <div className="flex min-w-0 items-start gap-3 md:items-center">
        <KindTile kind={kind} />
        <div className="flex min-w-0 flex-1 flex-col gap-px md:flex-row md:items-center md:gap-3">
          <h3 className="min-w-0 text-[15.5px] font-semibold leading-[1.3] md:flex-1 md:truncate md:text-[14.5px]">
            {title}
            <span className="font-normal text-text-2"> · {count}</span>
          </h3>
          <span
            className={cn(
              'flex-none whitespace-nowrap text-[11.5px] font-semibold',
              KIND_LABEL_TONE[kind] ?? 'text-text-3',
            )}
          >
            {KIND_LABEL[kind]}
          </span>
        </div>
        <span className="flex flex-none" aria-hidden>
          {items.slice(0, 4).map((i, n) => (
            <Avatar
              key={i.id}
              name={customerOf(i) ?? i.title}
              seed={i.personId ?? i.id}
              size="sm"
              className={cn('ring-2 ring-card', n > 0 && '-ml-1.5', n === 3 && 'max-md:hidden')}
            />
          ))}
        </span>
      </div>
      <p className={cn('mt-1 text-[13px] leading-[1.45] text-text-2 md:mt-0 md:truncate', INDENT)}>
        {andList(items.map((i) => customerOf(i) ?? i.title))}.
      </p>
      <div className={cn('mt-2 flex min-w-0 flex-wrap items-center gap-2 md:mt-[7px]', INDENT)}>
        {chips.length ? <Chips chips={chips} className="w-full md:w-auto" /> : null}
        <span aria-hidden className="hidden min-w-2 flex-1 md:block" />
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          data-testid="attention-group-toggle"
          className={cn(FOOT_BUTTON, 'mt-0.5 w-full md:mt-0 md:w-auto')}
        >
          {open ? 'Hide' : `Show all ${items.length}`}
          <ChevronDown
            className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
            strokeWidth={1.75}
          />
        </Button>
      </div>
      {open ? (
        <div className="-mx-3.5 -mb-3 mt-2.5">
          {items.map((i) => (
            <GroupRow key={i.id} item={i} />
          ))}
        </div>
      ) : null}
    </article>
  );
}
