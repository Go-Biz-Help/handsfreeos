'use client';
import {
  CircleAlert,
  CloudOff,
  Gauge,
  Hourglass,
  Info,
  KeyRound,
  Lock,
  RotateCw,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Notice, NoticeCode } from './assistant-provider';
import { cardFoot, cardHead, cardShell, Tile, touchButton } from './card-parts';

interface NoticeCopy {
  readonly icon: LucideIcon;
  readonly tone: 'warning' | 'danger' | 'neutral';
  readonly title: (workspaceName: string) => string;
  /** The line under the title; the worker's own words when null. */
  readonly sub: string | null;
  readonly action: 'retry' | 'reload' | null;
}

const COPY: Record<Exclude<NoticeCode, 'stopped'>, NoticeCopy> = {
  budget_reached: {
    icon: Gauge,
    tone: 'warning',
    title: (ws) => `That’s today’s Assistant limit for ${ws}`,
    sub: 'It resets at midnight. Everything else in HandsFreeOS still works.',
    action: null,
  },
  busy: {
    icon: CloudOff,
    tone: 'neutral',
    title: () => 'The Assistant is busy right now',
    sub: 'Nothing was changed. Try again in a minute.',
    action: 'retry',
  },
  unreachable: {
    icon: CloudOff,
    tone: 'neutral',
    title: () => 'The Assistant isn’t reachable right now',
    sub: 'Nothing was changed. Check your connection, then try again.',
    action: 'retry',
  },
  already_running: {
    icon: Hourglass,
    tone: 'neutral',
    title: () => 'Still answering your last question',
    sub: 'It may be in another tab. Wait for it to finish, then try again.',
    action: 'retry',
  },
  dropped: {
    icon: CloudOff,
    tone: 'neutral',
    title: () => 'The connection dropped',
    sub: 'The answer is saved in this chat when it finishes.',
    action: 'reload',
  },
  forbidden: {
    icon: Lock,
    tone: 'neutral',
    title: () => 'You can’t use the Assistant here',
    sub: null,
    action: null,
  },
  failed: {
    icon: CircleAlert,
    tone: 'danger',
    title: () => 'Something went wrong',
    sub: 'Try again in a minute.',
    action: 'retry',
  },
};

/** Why an answer stopped short, and what still works (design/m4/States.dc.html). */
export function NoticeCard({
  notice,
  workspaceName,
  onRetry,
  onReload,
}: {
  notice: Notice;
  workspaceName: string;
  onRetry?: () => void;
  onReload?: () => void;
}) {
  if (notice.code === 'stopped') return null;
  const copy = COPY[notice.code];
  const action =
    copy.action === 'retry' && onRetry
      ? { label: 'Try again', run: onRetry }
      : copy.action === 'reload' && onReload
        ? { label: 'Reload the chat', run: onReload }
        : null;
  return (
    <div className={cardShell} data-testid="assistant-notice" data-code={notice.code}>
      <div className={cn(cardHead, 'items-start')}>
        <Tile icon={copy.icon} tone={copy.tone} />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="text-[13px] font-medium">{copy.title(workspaceName)}</span>
          <span className="text-xs text-text-2">{copy.sub ?? notice.message}</span>
        </span>
      </div>
      {action ? (
        <div className={cardFoot}>
          <Button variant="secondary" size="sm" className={touchButton} onClick={action.run}>
            <RotateCw className="h-3.5 w-3.5" strokeWidth={1.5} />
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const Code = ({ children }: { children: string }) => (
  <code className="font-mono text-[12.5px]">{children}</code>
);

/** No model on the worker: how to add one on your own computer, or a plain "not yet" on the live site. */
export function NotSetUp() {
  const local = process.env.NODE_ENV === 'development';
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3.5"
      data-testid="assistant-not-set-up"
    >
      <div className="flex flex-col gap-3 px-0.5 py-1">
        <Tile icon={local ? KeyRound : Info} tone="accent" size={40} />
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold leading-[1.35]">
            {local ? 'The Assistant isn’t set up here yet' : 'The Assistant isn’t available yet'}
          </h3>
          <p className="text-[13px] text-text-2">
            {local ? (
              <>
                Add an Anthropic API key to <Code>apps/worker/.env</Code> as{' '}
                <Code>ANTHROPIC_API_KEY</Code>, then restart <Code>pnpm dev</Code>. Everything else
                works without it.
              </>
            ) : (
              'It hasn’t been set up for HandsFreeOS yet. Everything else works as usual.'
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
