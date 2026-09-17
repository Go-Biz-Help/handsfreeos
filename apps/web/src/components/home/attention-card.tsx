'use client';
import { ATTENTION_WORDS, goesStripWords } from '@hfos/core';
import { Zap } from 'lucide-react';
import { AI_TEXT } from '@/components/workflows/chips';
import type { AttentionItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { HandleButton, ItemMenu, LetHandleButton } from './attention-actions';
import { AssigneeMark, Chips, KIND_LABEL_TONE, KindTile } from './attention-bits';
import { useAttentionEnv } from './attention-context';
import { autoAt, chipsOf, customerOf, isDraft, KIND_LABEL, splitTitle } from './attention-words';

export const CARD =
  'relative flex flex-col gap-[3px] rounded-card border border-border bg-card p-3.5 shadow-1 md:px-3.5 md:py-3';
/** An urgent card: a red edge and a soft red ring. */
export const URGENT_CARD =
  'border-[color-mix(in_oklab,var(--danger)_42%,var(--border))] shadow-[0_0_0_3px_color-mix(in_oklab,var(--danger-soft)_70%,transparent),var(--shadow-1)]';
/** The card's lines under the title start where the title does, past the kind's square (desktop only). */
export const INDENT = 'md:pl-[42px]';
/** A button in the card's footer: 44 px and full width on phones, 32 px on desktop. */
export const FOOT_BUTTON = 'h-11 text-[14.5px] md:h-8 md:text-[13px]';

/** "HandsFreeOS will follow up at 9:05 AM · Cancel": the card stays until it goes, so you can still act first. */
function GoesStrip({ item, at }: { item: AttentionItem; at: number }) {
  const env = useAttentionEnv();
  const name = customerOf(item);
  const words = goesStripWords(item, at, env.timeZone);
  return (
    <div
      data-testid="attention-goes"
      className="mt-2.5 flex items-center gap-2.5 rounded-[10px] bg-accent-soft px-3.5 py-[11px] text-[13.5px] text-accent-text md:ml-[42px]"
    >
      <Zap className="h-4 w-4 flex-none" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{words.strong}</b>
        {words.rest}
      </span>
      <button
        type="button"
        data-testid="attention-cancel-auto"
        disabled={env.busy.has(item.id)}
        onClick={() => env.act.cancelAuto({ itemId: item.id, name, action: item.auto.action })}
        className="flex-none font-semibold underline disabled:opacity-50"
      >
        {ATTENTION_WORDS.cancel}
      </button>
    </div>
  );
}

/**
 * One thing that needs attention: the kind, the customer and lead, up to three chips that say why it ranks where it
 * does, and whose it is. The main button fits the item; Let HandsFreeOS Handle sits beside it; ⋯ holds Assign,
 * Snooze and Dismiss. On a phone it goes full width with 44 px buttons.
 */
export function AttentionCard({ item }: { item: AttentionItem }) {
  const env = useAttentionEnv();
  const { head, rest } = splitTitle(item.title);
  const chips = chipsOf(item, env.now, env.timeZone);
  const at = autoAt(item);
  const draft = item.kind === 'ai_approval' && isDraft(item);
  return (
    <article
      data-testid="attention-card"
      data-kind={item.kind}
      data-item={item.id}
      data-urgent={item.urgent ? 'true' : undefined}
      className={cn(
        CARD,
        item.urgent && URGENT_CARD,
        // The Assistant linked here (?item=): marked for a moment, so it's easy to find.
        env.highlightId === item.id && 'ring-2 ring-accent',
      )}
    >
      <div className="flex min-w-0 items-start gap-3 md:items-center">
        <KindTile kind={item.kind} />
        <div className="flex min-w-0 flex-1 flex-col gap-px md:flex-row md:items-center md:gap-3">
          <h3
            data-testid="attention-title"
            className="min-w-0 text-[15.5px] font-semibold leading-[1.3] md:flex-1 md:truncate md:text-[14.5px]"
          >
            {head}
            {rest ? <span className="font-normal text-text-2"> · {rest}</span> : null}
          </h3>
          <span
            className={cn(
              'flex-none whitespace-nowrap text-[11.5px] font-semibold',
              KIND_LABEL_TONE[item.kind] ?? 'text-text-3',
            )}
          >
            {KIND_LABEL[item.kind]}
          </span>
        </div>
        <AssigneeMark assignee={item.assignee} />
      </div>
      {item.detail ? (
        <p
          className={cn('mt-1 text-[13px] leading-[1.45] text-text-2 md:mt-0 md:truncate', INDENT)}
        >
          {draft && env.teammateName ? (
            <b className={cn('font-semibold', AI_TEXT)}>{env.teammateName}: </b>
          ) : null}
          {draft ? `“${item.detail}”` : item.detail}
        </p>
      ) : null}
      {/* One line on a wide card; the buttons drop to their own line when the chips leave no room. */}
      <div className={cn('mt-2 flex min-w-0 flex-wrap items-center gap-2 md:mt-[7px]', INDENT)}>
        {chips.length ? <Chips chips={chips} className="w-full md:w-auto" /> : null}
        <span aria-hidden className="hidden min-w-2 flex-1 md:block" />
        <HandleButton item={item} className={cn(FOOT_BUTTON, 'mt-0.5 w-full md:mt-0 md:w-auto')} />
        <LetHandleButton item={item} className={cn(FOOT_BUTTON, 'flex-1 md:flex-none')} />
        <ItemMenu item={item} />
      </div>
      {at !== null ? <GoesStrip item={item} at={at} /> : null}
    </article>
  );
}
