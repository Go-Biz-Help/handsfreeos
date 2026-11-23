'use client';
/**
 * Settings → Website chat (the owner, 23 Nov 2026, W3 a): one simple card, the way Payments is. The chat on or paused,
 * whether it's been seen on the site, Copy the code, Try it and Put it on your site; the guided setup's six answers,
 * each with Change, which opens that question; and every setting from before under All settings, so nothing the page
 * could do is gone. With no chat yet, Set up website chat starts the guided setup (or picks up where it was left).
 * All settings opens by itself for a link to one setting (`#…`) and for settings search's `?all=1`. The lines are
 * core's (chatSetupLines), shared with the phone.
 */
import { CHAT_SETUP_WORDS as W, GUIDED_SETUP_WORDS as G, type ChatSetupLine } from '@hfos/core';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  MessageCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ChatWidget } from '@/lib/api/types';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';
import { InstallCheck, snippetOf, snippetSrc } from './chat-install';

export function WebsiteChatOverview({
  workspaceId,
  widget,
  lines,
  started,
  openAll,
  brandedOrigin,
  children,
}: {
  workspaceId: string;
  /** The business's first chat; null while it has none. */
  widget: ChatWidget | null;
  /** The chat's answers, one line a question; empty while there's no chat. */
  lines: readonly ChatSetupLine[];
  /** The guided setup has answers saved: Set up website chat picks up where they left off. */
  started: boolean;
  /** `?all=1`: All settings starts open. */
  openAll: boolean;
  brandedOrigin: string | null;
  /** Every setting from before (WebsiteChatPage). */
  children: ReactNode;
}) {
  const setup = `/onboarding/${workspaceId}/chat`;
  const [open, setOpen] = useState(openAll);
  const allRef = useRef<HTMLDivElement>(null);
  // A link to one setting (`#…`) opens All settings, so the jump finds it. Settings search on this page pushes
  // `?all=1` (a push to the same page fires no `hashchange`), which arrives as `openAll`.
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash.length > 1 && !window.location.hash.includes('=')) setOpen(true);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  useEffect(() => {
    if (openAll) setOpen(true);
  }, [openAll]);

  const toggle = () => {
    setOpen((now) => {
      if (!now) requestAnimationFrame(() => allRef.current?.scrollIntoView({ block: 'start' }));
      return !now;
    });
  };

  return (
    <div className="flex max-w-[980px] flex-col gap-4" data-testid="chat-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-text-2">{W.summary.lead}</p>
        <Button
          variant="secondary"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="chat-all-settings"
          data-testid="chat-all-settings-toggle"
        >
          {open ? W.summary.hideAll : W.summary.allSettings}
          {open ? (
            <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
          )}
        </Button>
      </div>

      {widget ? (
        <StatusCard workspaceId={workspaceId} widget={widget} brandedOrigin={brandedOrigin} />
      ) : (
        <Card className="flex flex-wrap items-center gap-3.5 p-5" data-testid="chat-set-up-card">
          <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
            <MessageCircle className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold">{W.summary.setUp}</span>
            <span className="text-[13px] text-text-2">{W.summary.setUpHint}</span>
          </span>
          <ButtonLink href={setup} variant="primary" data-testid="chat-set-up">
            {started ? W.summary.resume : W.summary.start}
            <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
          </ButtonLink>
        </Card>
      )}

      {lines.length ? (
        <Card className="p-5" data-testid="chat-answers">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2.5">
            <h2 className="text-[15px] font-semibold">{W.summary.answers}</h2>
            <Link
              href={setup}
              className="text-[13.5px] font-semibold text-accent-text hover:underline"
              data-testid="chat-again"
            >
              {W.summary.again}
            </Link>
          </div>
          <div>
            {lines.map((l, n) => (
              <div
                key={l.key}
                className={cn(
                  'flex flex-wrap items-start gap-x-4 gap-y-1 py-3',
                  n > 0 && 'border-t border-border',
                )}
                data-testid={`chat-answer-${l.key}`}
              >
                <span className="w-[180px] flex-none text-[13.5px] text-text-2">{l.label}</span>
                <span className="min-w-[180px] flex-1 text-[14px]">{l.value}</span>
                <Link
                  href={`${setup}?at=${l.key}`}
                  className="flex-none px-1 text-[13.5px] font-semibold text-accent-text hover:underline"
                  data-testid={`chat-answer-change-${l.key}`}
                >
                  {G.change}
                </Link>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {!open ? (
        <div className="rounded-card bg-card-2 px-5 py-4">
          <h2 className="mb-1 text-[14px] font-semibold">{W.summary.under}</h2>
          <p className="text-[13.5px] leading-relaxed text-text-2">{W.summary.allSettingsHint}</p>
        </div>
      ) : null}

      <div
        ref={allRef}
        id="chat-all-settings"
        className="scroll-mt-20"
        hidden={!open}
        data-testid="chat-all-settings"
      >
        {open ? children : null}
      </div>
    </div>
  );
}

/** On or paused, seen on the site or not yet, and the three things done most: copy the code, try it, put it on. */
function StatusCard({
  workspaceId,
  widget,
  brandedOrigin,
}: {
  workspaceId: string;
  widget: ChatWidget;
  brandedOrigin: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const origin = usePublicOrigin(brandedOrigin);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST(
          on ? '/v1/commands/chat_widget.resume' : '/v1/commands/chat_widget.pause',
          { body: { workspaceId, widgetId: widget.id } },
        ),
      );
      toast.success(
        on
          ? 'Website chat is back on.'
          : 'Website chat is paused. Visitors don’t see the button until you turn it back on.',
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-5" data-testid="chat-overview-status">
      <div className="flex flex-wrap items-start gap-3.5">
        <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
          <MessageCircle className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
            {widget.name}
            <Badge variant={widget.paused ? 'pending' : 'ok'} data-testid="chat-overview-state">
              {widget.paused ? W.summary.paused : W.summary.on}
            </Badge>
          </span>
          <span className="text-[13px] text-text-2">
            {widget.paused ? W.summary.pausedHint : W.summary.onHint}
          </span>
        </span>
        <Switch
          checked={!widget.paused}
          onChange={(on) => void toggle(on)}
          label="Website chat on"
          disabled={busy}
          testId="chat-overview-on"
        />
      </div>
      {widget.paused ? (
        <Callout tone="warning" icon={Clock} data-testid="chat-paused">
          Paused. Visitors don’t see the chat button until you turn it back on.
        </Callout>
      ) : (
        <InstallCheck workspaceId={workspaceId} widget={widget} className="" />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={!origin}
          onClick={() =>
            void copyText(snippetOf(snippetSrc(origin, widget.publicKey)), W.install.copiedToast)
          }
          data-testid="chat-overview-copy"
        >
          <Copy className="h-4 w-4" aria-hidden />
          {W.summary.copyCode}
        </Button>
        <a
          href={`/chat-preview/${widget.publicKey}?w=${workspaceId}`}
          target="_blank"
          rel="noopener"
          className={buttonClassName({ variant: 'secondary' })}
          data-testid="chat-overview-try"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
          {W.summary.tryIt}
        </a>
        <ButtonLink
          href={`/onboarding/${workspaceId}/chat?step=install`}
          variant={widget.install.seen ? 'ghost' : 'primary'}
          data-testid="chat-overview-install"
        >
          {W.summary.putOnSite}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </ButtonLink>
      </div>
    </Card>
  );
}
