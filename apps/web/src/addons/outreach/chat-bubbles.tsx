/**
 * Messages drawn as chat bubbles, the person's on the right in the accent and theirs on the left, the way Inbox draws
 * them: a chat's latest messages beside a message waiting for an OK (docs/outreach.md, "How the AI writes"), and how
 * the person's voice reads on the Settings tab.
 */
import { cn } from '@/lib/utils';

export interface Bubble {
  readonly fromMe: boolean;
  readonly text: string;
  /** Said under the bubble, small: when it was sent. */
  readonly when?: string | null;
}

export function ChatBubbles({
  bubbles,
  label,
  className,
  testId,
}: {
  bubbles: readonly Bubble[];
  label: string;
  className?: string;
  testId?: string;
}) {
  return (
    <ol
      className={cn('flex flex-col gap-1 rounded-md bg-card-2 px-3 py-2', className)}
      aria-label={label}
      data-testid={testId}
    >
      {bubbles.map((b, i) => (
        <li key={i} className={cn('flex flex-col', b.fromMe ? 'items-end' : 'items-start')}>
          <p
            className={cn(
              'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-[13px] leading-[1.45] [overflow-wrap:anywhere]',
              b.fromMe
                ? 'rounded-br-[5px] bg-accent text-white'
                : 'rounded-bl-[5px] border border-border bg-card',
            )}
          >
            {b.text}
          </p>
          {b.when ? <span className="px-1 text-[11.5px] text-text-3">{b.when}</span> : null}
        </li>
      ))}
    </ol>
  );
}
