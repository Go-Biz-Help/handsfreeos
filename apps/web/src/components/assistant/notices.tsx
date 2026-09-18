'use client';
import {
  assistantNotice,
  assistantNoticeAction,
  ASSISTANT_WORDS,
  type AssistantNoticeIcon,
} from '@hfos/core';
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
import type { Notice } from './assistant-provider';
import { cardFoot, cardHead, cardShell, Tile, touchButton } from './card-parts';

/** The words are core's (M10 step 17); the panel only chooses the icon that goes with each. */
const ICONS: Record<AssistantNoticeIcon, LucideIcon> = {
  limit: Gauge,
  offline: CloudOff,
  waiting: Hourglass,
  locked: Lock,
  alert: CircleAlert,
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
  const copy = assistantNotice(notice.code, { workspaceName, message: notice.message });
  if (!copy) return null;
  const label = assistantNoticeAction(copy);
  const run = copy.action === 'retry' ? onRetry : copy.action === 'reload' ? onReload : undefined;
  const action = label && run ? { label, run } : null;
  return (
    <div className={cardShell} data-testid="assistant-notice" data-code={notice.code}>
      <div className={cn(cardHead, 'items-start')}>
        <Tile icon={ICONS[copy.icon]} tone={copy.tone} />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="text-[13px] font-medium">{copy.title}</span>
          <span className="text-xs text-text-2">{copy.sub}</span>
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
            {local ? 'The Assistant isn’t set up here yet' : ASSISTANT_WORDS.notAvailable.title}
          </h3>
          <p className="text-[13px] text-text-2">
            {local ? (
              <>
                Add an Anthropic API key to <Code>apps/worker/.env</Code> as{' '}
                <Code>ANTHROPIC_API_KEY</Code>, then restart <Code>pnpm dev</Code>. Everything else
                works without it.
              </>
            ) : (
              ASSISTANT_WORDS.notAvailable.body
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
