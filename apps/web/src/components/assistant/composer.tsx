'use client';
import { ArrowUp, Square } from 'lucide-react';
import { useEffect, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';

/** The box when the Assistant can't take questions: not set up, or today's limit is spent. */
function OffComposer({ phone, paused }: { phone: boolean; paused: boolean }) {
  const local = process.env.NODE_ENV === 'development';
  const [text, hint] = paused
    ? ['The Assistant is paused for today', 'Back at midnight']
    : local
      ? [
          'The Assistant isn’t set up on this computer',
          'Only shows when running HandsFreeOS on your own computer',
        ]
      : ['The Assistant isn’t available yet', 'Shows until the Assistant is set up'];
  return (
    <div
      className={cn(
        'flex-none border-t border-border bg-card px-2.5 pt-2',
        phone ? 'pb-[calc(env(safe-area-inset-bottom)+10px)]' : 'pb-2.5',
      )}
      data-testid="assistant-composer"
      data-state="off"
    >
      <div className="rounded-card border border-border bg-card-2">
        <div className="min-h-[38px] px-3 pt-[9px] text-[14.5px] leading-[1.45] text-placeholder">
          {text}
        </div>
        <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-1">
          <span className="min-w-0 flex-1 px-1.5 text-xs text-text-3">{hint}</span>
          <Button size="icon" disabled aria-label="Send" className="disabled:opacity-45">
            <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Where the person asks. Return sends where there's a keyboard and a mouse (Shift+Return adds a line); on
 * touch screens Return adds a line and the round button sends. While an answer streams in, Stop replaces Send.
 */
export function AssistantComposer({ phone }: { phone: boolean }) {
  const a = useAssistant();
  const fine = useMatches('(pointer: fine)');
  const ref = a.composerRef;
  const off = a.setup === 'missing' || a.paused;
  const canSend = !!a.draft.trim() && !a.running;

  // The box grows with the question, up to about six lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [a.draft, ref]);

  // With a mouse and keyboard it's ready to type in as soon as the panel opens.
  useEffect(() => {
    if (fine) ref.current?.focus({ preventScroll: true });
  }, [fine, ref]);

  function send() {
    if (!canSend) return;
    a.ask(a.draft);
    a.setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && fine) {
      e.preventDefault();
      send();
    }
  }

  if (off) return <OffComposer phone={phone} paused={a.paused} />;

  const box = {
    ref,
    value: a.draft,
    maxLength: 4000,
    onChange: (e: { target: { value: string } }) => a.setDraft(e.target.value),
    onKeyDown,
    'aria-label': 'Message the Assistant',
    enterKeyHint: fine ? ('send' as const) : ('enter' as const),
  };

  if (phone)
    return (
      <div
        className="flex flex-none items-end gap-1.5 border-t border-border bg-card px-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2"
        data-testid="assistant-composer"
      >
        <textarea
          {...box}
          rows={1}
          placeholder="Ask HandsFreeOS…"
          className="min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-border-strong bg-card px-4 py-[10px] text-base leading-[1.4] text-text placeholder:text-placeholder focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring"
        />
        {a.running ? (
          <button
            type="button"
            title="Stop"
            aria-label="Stop"
            onClick={a.stop}
            data-testid="assistant-stop"
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-border-strong text-text-2"
          >
            <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.5} />
          </button>
        ) : (
          <button
            type="button"
            title="Send"
            aria-label="Send"
            disabled={!canSend}
            onClick={send}
            data-testid="assistant-send"
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-white disabled:opacity-45"
          >
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
        )}
      </div>
    );

  return (
    <div
      className="flex flex-none flex-col gap-1.5 border-t border-border bg-card px-3 pb-3 pt-2.5"
      data-testid="assistant-composer"
    >
      <div className="rounded-card border border-border-strong bg-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring">
        <textarea
          {...box}
          rows={2}
          placeholder="Ask anything, or tell me what to do…"
          className="block min-h-[46px] w-full resize-none bg-transparent px-3 pb-0.5 pt-2.5 text-[14.5px] leading-[1.45] text-text placeholder:text-placeholder focus:outline-none"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-1">
          <span className="min-w-0 flex-1 px-1.5 text-xs text-text-3">
            Asks before it contacts customers or changes records
          </span>
          {a.running ? (
            <Button
              variant="secondary"
              size="icon"
              title="Stop"
              aria-label="Stop"
              onClick={a.stop}
              data-testid="assistant-stop"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.5} />
            </Button>
          ) : (
            <Button
              size="icon"
              title="Send (Return)"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              data-testid="assistant-send"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
