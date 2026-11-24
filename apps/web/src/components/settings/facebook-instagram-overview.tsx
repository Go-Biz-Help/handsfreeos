'use client';
/**
 * Settings → Facebook & Instagram (the owner, 24 Nov 2026, F3 a): one simple card, the way Payments and Website chat
 * are. What's connected, with Send a test message and Connect more, or, while nothing is, Start, which opens the
 * guided setup (F1 a); the setup's answers, each with Change, which opens that question, read from what's set now;
 * and every setting from before under All settings, so nothing the page could do is gone. All settings opens by itself
 * for a link to one setting (`#…`, settings search's `?all=1`), on the way back from Facebook's sign-in started there
 * (`?meta=`), and while something needs fixing. The lines are core's (facebookSettingsLines), shared with the phone.
 */
import {
  FACEBOOK_SETUP_WORDS as W,
  metaAccountLabel,
  metaAccountTrouble,
  type FacebookSetupLine,
} from '@hfos/core';
import { ArrowRight, ChevronDown, ChevronRight, CircleAlert, Plus, Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { InstagramIcon, MessengerIcon } from '@/components/inbox/social-bits';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage } from '@/lib/api/client';
import type { MetaAccount } from '@/lib/api/types';
import { connectFacebook } from '@/lib/meta-connect';
import { cn } from '@/lib/utils';

export function FacebookInstagramOverview({
  workspaceId,
  accounts,
  lines,
  started,
  openAll,
  needsFixing,
  children,
}: {
  workspaceId: string;
  /** The Pages and Instagram accounts connected now. */
  accounts: readonly MetaAccount[];
  /** The answers as the settings give them; empty while nothing is connected. */
  lines: readonly FacebookSetupLine[];
  /** The guided setup has answers saved: Start picks up where they left off. */
  started: boolean;
  /** `?all=1` or `?meta=`: All settings starts open. */
  openAll: boolean;
  needsFixing: boolean;
  /** Every setting from before (FacebookInstagramPage). */
  children: ReactNode;
}) {
  const setup = `/onboarding/${workspaceId}/facebook`;
  const [open, setOpen] = useState(openAll || needsFixing);
  const [busy, setBusy] = useState(false);
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

  async function connectMore() {
    setBusy(true);
    try {
      await connectFacebook(workspaceId);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-[980px] flex-col gap-4" data-testid="facebook-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-text-2">{W.summary.lead}</p>
        <Button
          variant="secondary"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="facebook-all-settings"
          data-testid="facebook-all-settings-toggle"
        >
          {open ? W.summary.hideAll : W.summary.allSettings}
          {open ? (
            <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
          )}
        </Button>
      </div>

      {needsFixing && !open ? (
        <Callout
          tone="warning"
          icon={CircleAlert}
          action={
            <Button size="sm" variant="secondary" onClick={toggle}>
              {W.summary.allSettings}
            </Button>
          }
        >
          {W.summary.fix}
        </Callout>
      ) : null}

      {accounts.length === 0 ? (
        <Card className="flex flex-wrap items-center gap-4 p-5" data-testid="facebook-set-up-card">
          <span className="flex gap-1.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-border bg-card">
              <MessengerIcon className="h-5 w-5" />
            </span>
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-border bg-card">
              <InstagramIcon className="h-5 w-5" />
            </span>
          </span>
          <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <span className="text-[15px] font-semibold">{W.summary.setUp}</span>
            <span className="text-[13.5px] text-text-2">{W.summary.setUpHint}</span>
          </span>
          <ButtonLink href={setup} variant="primary" data-testid="facebook-set-up">
            {started ? W.summary.resume : W.summary.start}
            <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
          </ButtonLink>
        </Card>
      ) : (
        <Card className="p-5" data-testid="facebook-connected">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2.5">
            <h2 className="text-[15px] font-semibold">{W.summary.connected}</h2>
            <span className="flex flex-wrap gap-2">
              <ButtonLink
                href={`${setup}?step=test`}
                variant="secondary"
                size="sm"
                data-testid="facebook-send-test"
              >
                <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                {W.summary.sendTest}
              </ButtonLink>
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() => void connectMore()}
                data-testid="facebook-connect-more"
              >
                {busy ? null : <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />}
                {W.summary.connectMore}
              </Button>
            </span>
          </div>
          <ul>
            {accounts.map((a, n) => {
              const ig = a.platform === 'instagram';
              const trouble = metaAccountTrouble(a);
              return (
                <li
                  key={a.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 py-3',
                    n > 0 && 'border-t border-border',
                  )}
                  data-testid={`facebook-overview-account-${a.id}`}
                >
                  <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-border bg-card">
                    {ig ? (
                      <InstagramIcon className="h-5 w-5" />
                    ) : (
                      <MessengerIcon className="h-5 w-5" />
                    )}
                  </span>
                  <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
                      {metaAccountLabel(a)}
                      {trouble ? (
                        <Badge variant="pending">{W.summary.needsAttention}</Badge>
                      ) : (
                        <Badge variant="ok">{W.summary.answering}</Badge>
                      )}
                    </span>
                    <span className="text-[12.5px] text-text-3">
                      {ig ? W.test.kindInstagram : W.test.kindPage} ·{' '}
                      {W.summary.conversations(a.conversations)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {lines.length ? (
        <Card className="p-5" data-testid="facebook-answers">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2.5">
            <h2 className="text-[15px] font-semibold">{W.summary.answers}</h2>
            <Link
              href={setup}
              className="text-[13.5px] font-semibold text-accent-text hover:underline"
              data-testid="facebook-again"
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
                data-testid={`facebook-answer-${l.key}`}
              >
                <span className="w-[200px] flex-none text-[13.5px] text-text-2">{l.label}</span>
                <span className="min-w-[180px] flex-1 text-[14px]">{l.value}</span>
                <Link
                  href={`${setup}?at=${l.key}`}
                  className="flex-none px-1 text-[13.5px] font-semibold text-accent-text hover:underline"
                  data-testid={`facebook-answer-change-${l.key}`}
                >
                  {W.summary.change}
                </Link>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {!open ? (
        <div className="rounded-card bg-card-2 px-5 py-4">
          <h2 className="mb-1 text-[14px] font-semibold">{W.summary.under}</h2>
          <p className="text-[13.5px] leading-relaxed text-text-2">{W.summary.underHint}</p>
        </div>
      ) : null}

      <div
        ref={allRef}
        id="facebook-all-settings"
        className="scroll-mt-20"
        hidden={!open}
        data-testid="facebook-all-settings"
      >
        {open ? children : null}
      </div>
    </div>
  );
}
