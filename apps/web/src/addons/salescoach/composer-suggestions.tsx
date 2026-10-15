'use client';
/**
 * Sales Coach above a conversation's message box (`composer.suggestions`, round two): two or three replies the coach
 * suggests for the customer's newest message. A click puts one in the box to edit; nothing is sent from here. They
 * go once anyone replies, and come back fresh when the customer writes again (the live update for the conversation).
 * Drawn by <AddonSlot> only while the add-on runs and for people with `salescoach.use`.
 */
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import { Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import type { SlotProps } from '../registry';

type Got = Awaited<ReturnType<typeof read>>['suggestions'];

const read = (workspaceId: string, conversationId: string) =>
  apiBrowser()
    .POST('/v1/queries/salescoach.suggestions', { body: { workspaceId, conversationId } })
    .then(unwrap);

export default function ComposerSuggestions({
  workspaceId,
  conversationId,
  onUse,
}: SlotProps<'composer.suggestions'>) {
  const version = useLiveVersion(['conversation', 'message'], 300);
  const [got, setGot] = useState<Got>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void read(workspaceId, conversationId)
      .then((r) => current && setGot(r.suggestions))
      .catch(() => current && setGot(null));
    return () => {
      current = false;
    };
  }, [workspaceId, conversationId, version]);

  if (!got || hidden === got.messageId) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="coach-suggestions">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-2">
        <Sparkles className="h-3.5 w-3.5 text-accent-text" strokeWidth={1.75} aria-hidden />
        {W.suggest.title}
        <button
          type="button"
          onClick={() => setHidden(got.messageId)}
          aria-label={W.suggest.hide}
          title={W.suggest.hide}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-text-3 hover:bg-card-2 hover:text-text"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] md:flex-wrap">
        {got.replies.map((r) => (
          <button
            key={r.text}
            type="button"
            onClick={() => onUse(r.text)}
            title={r.text}
            data-testid="coach-suggestion"
            className="flex w-[240px] flex-none flex-col items-start gap-0.5 rounded-control border border-border bg-card px-2.5 py-1.5 text-left hover:border-accent hover:bg-accent-soft md:w-auto md:max-w-[320px] md:flex-1"
          >
            <span className="text-[12px] font-medium text-accent-text">{r.label}</span>
            <span className="line-clamp-2 text-[13px] text-text">{r.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
