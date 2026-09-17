'use client';
import { ATTENTION_WORDS, clockLabel, handledLineOf } from '@hfos/core';
import { CalendarCheck, ChevronDown, CircleCheck, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { BrandMark } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import type { AttentionItem } from '@/lib/api/types';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { FoldButton } from './attention-bits';
import { useAttentionEnv } from './attention-context';
import { byHandsFree, handledSummary, targetOf } from './attention-words';

/** What was done, in a sentence with the customer in bold (core's words), and the line under it. */
function lineOf(item: AttentionItem, myUserId: string): { text: ReactNode; sub: string | null } {
  const { text, sub } = handledLineOf(item, myUserId);
  return {
    text: (
      <>
        {text.map((part, i) =>
          typeof part === 'string' ? (
            part
          ) : (
            <strong key={i} className="font-semibold">
              {part.strong}
            </strong>
          ),
        )}
      </>
    ),
    sub,
  };
}

const at = (item: AttentionItem, timeZone: string) =>
  item.handled ? clockLabel(Date.parse(item.handled.at), timeZone) : '';

function HandledRow({ item }: { item: AttentionItem }) {
  const env = useAttentionEnv();
  const { text, sub } = lineOf(item, env.myUserId);
  const target = targetOf(item, env.workspaceId);
  const Icon = item.auto.action === 'confirm_request' ? CalendarCheck : MessageCircle;
  return (
    <li
      data-testid="handled-row"
      className="flex min-w-0 items-center gap-2.5 border border-t-0 border-border-strong bg-card px-3.5 py-[9px] text-[13px] last:rounded-b-card"
    >
      <span className="w-[62px] flex-none text-[12.5px] tabular-nums text-text-3">
        {at(item, env.timeZone)}
      </span>
      <span
        aria-hidden
        className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-accent-soft text-accent-text"
      >
        <Icon className="h-[13px] w-[13px]" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{text}</span>
        {sub ? <span className="truncate text-xs text-text-3">{sub}</span> : null}
      </span>
      <Link
        href={target.href}
        className="flex-none text-[13px] font-medium text-accent-text hover:underline"
      >
        {ATTENTION_WORDS.open}
      </Link>
    </li>
  );
}

/**
 * "Handled by HandsFreeOS", collapsed under the list: what it did on its own today (and for whoever chose Let
 * HandsFreeOS Handle), newest first. Nothing shows when it did nothing.
 */
export function HandledByHandsFree({ items }: { items: readonly AttentionItem[] }) {
  const phone = useMatches('(max-width: 767px)');
  const [open, setOpen] = useState(false);
  const done = items.filter(byHandsFree);
  if (!done.length) return null;
  const summary = handledSummary(done);
  const badge = (
    <Badge variant="ok" className="flex-none">
      {ATTENTION_WORDS.handledCount(done.length)}
    </Badge>
  );
  return (
    <section data-testid="handled-by-hfos" className="mt-3">
      {phone ? (
        <FoldButton
          open={open}
          onToggle={() => setOpen(!open)}
          icon={<BrandMark size={20} />}
          title={ATTENTION_WORDS.handledByHandsFree}
          sub={summary}
          badge={badge}
          testId="handled-toggle"
        />
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          data-testid="handled-toggle"
          className={cn(
            'flex w-full items-center gap-2.5 rounded-card border border-dashed border-border-strong px-3.5 py-[11px] text-left text-text-2 transition-colors hover:bg-card',
            open && 'rounded-b-none border-solid bg-card',
          )}
        >
          <BrandMark size={20} />
          <span className="font-medium text-text">{ATTENTION_WORDS.handledByHandsFree}</span>
          {badge}
          <span className="min-w-0 flex-1 truncate text-[13px] text-text-3">{summary}</span>
          <ChevronDown
            className={cn('h-4 w-4 flex-none transition-transform', open && 'rotate-180')}
            strokeWidth={1.75}
          />
        </button>
      )}
      {open ? (
        <ul className={phone ? '[&>li:first-child]:border-t' : undefined}>
          {done.map((item) => (
            <HandledRow key={item.id} item={item} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DoneRow({ item }: { item: AttentionItem }) {
  const env = useAttentionEnv();
  const { text, sub } = lineOf(item, env.myUserId);
  const by = item.handled?.by ?? null;
  return (
    <li className="flex items-start gap-3 border-t border-border px-4 py-2.5">
      <span className="w-[58px] flex-none pt-[3px] text-xs tabular-nums text-text-3">
        {at(item, env.timeZone)}
      </span>
      {byHandsFree(item) || !by ? (
        <BrandMark size={24} />
      ) : (
        <Avatar name={by.fullName} seed={by.id} size="sm" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px]">{text}</span>
        {sub ? <span className="text-xs text-text-3">{sub}</span> : null}
      </span>
    </li>
  );
}

/**
 * The empty list: "You're all caught up", then what got done today, by the team and by HandsFreeOS.
 */
export function CaughtUp({ items, count }: { items: readonly AttentionItem[]; count: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 6);
  const hf = items.filter(byHandsFree).length;
  return (
    <>
      <Card
        data-testid="attention-empty"
        className="flex flex-col items-center gap-1.5 px-6 py-[26px] text-center"
      >
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-success-soft text-success-text">
          <CircleCheck className="h-[22px] w-[22px]" strokeWidth={1.75} />
        </span>
        <h2 className="mt-1 text-base font-semibold">{ATTENTION_WORDS.caughtUpTitle}</h2>
        <p className="max-w-[420px] text-[13px] text-text-2">{ATTENTION_WORDS.caughtUpBody}</p>
      </Card>
      {items.length ? (
        <Card className="mt-4 overflow-hidden" data-testid="handled-today">
          <div className="flex items-center gap-2 px-4 pb-[9px] pt-[13px]">
            <h3 className="flex-1 text-[15px] font-semibold">{ATTENTION_WORDS.handledToday}</h3>
            <Badge variant="ok">{Math.max(count, items.length)}</Badge>
          </div>
          <ul>
            {shown.map((item) => (
              <DoneRow key={item.id} item={item} />
            ))}
          </ul>
          <div className="border-t border-border bg-card-2 px-4 py-[9px] text-xs text-text-3">
            {items.length > shown.length ? (
              <>
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="font-medium text-accent-text hover:underline"
                >
                  {ATTENTION_WORDS.showMore(items.length - shown.length)}
                </button>{' '}
                ·{' '}
              </>
            ) : null}
            {ATTENTION_WORDS.handledSplit(items.length - hf, hf)}
          </div>
        </Card>
      ) : null}
    </>
  );
}
