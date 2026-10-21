'use client';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';
import { AssistantMark } from './mark';

/** "Ask HandsFreeOS ⌘J" under the sidebar's Search everything box. */
export function AskButton({ className }: { className?: string }) {
  const a = useAssistant();
  if (!a.enabled) return null;
  return (
    <button
      type="button"
      onClick={a.toggle}
      aria-pressed={a.open}
      aria-keyshortcuts={a.shortcut?.aria}
      data-testid="ask-assistant"
      data-tour="ask"
      className={cn(
        'flex h-9 w-full items-center gap-[9px] whitespace-nowrap rounded-control border pl-[9px] pr-2 text-left text-[13.5px] font-medium transition-colors',
        a.open
          ? 'border-transparent bg-accent-soft text-accent-text'
          : 'border-border bg-card text-text-2 hover:bg-card-2 hover:text-text',
        className,
      )}
    >
      <AssistantMark size={18} />
      <span className="min-w-0 truncate">Ask HandsFreeOS</span>
      {a.shortcut ? <ShortcutKey className="ml-auto">{a.shortcut.label}</ShortcutKey> : null}
    </button>
  );
}

/** A shortcut drawn in the side menu: ⌘J here, and ⌘K in the Search everything box above. */
export function ShortcutKey({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 flex-none items-center rounded-[6px] border border-border-strong bg-card-2 px-1 font-mono text-[11px] font-medium text-text-3',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** The H in the phone header: opens the Assistant over the whole screen. */
export function MobileAskButton() {
  const a = useAssistant();
  if (!a.enabled) return null;
  return (
    <button
      ref={a.triggerRef}
      type="button"
      onClick={() => a.setOpen(true)}
      aria-label="Ask HandsFreeOS"
      title="Ask HandsFreeOS"
      data-testid="mobile-ask"
      className="flex h-11 w-11 items-center justify-center rounded-control hover:bg-card-2"
    >
      <AssistantMark size={24} />
    </button>
  );
}
