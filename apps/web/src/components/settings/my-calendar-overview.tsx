'use client';
/**
 * Settings → My calendar, your own (the owner, 24 Nov 2026, M3 a): one simple card, the way Facebook & Instagram and
 * Payments are. Until it's set up (M1 a), Start opens the guided setup, with what applies until then. After it, your
 * Google or Outlook calendar with Sync now, and the setup's answers, each with Change, which opens that question,
 * read from what's set now; and today's page under All settings, so nothing it could do is gone. All settings opens
 * by itself for a link to one setting (`#…`, settings search's `?all=1`), on the way back from a sign-in started
 * there (`?calendar=`, `?meeting=`), and while the calendar needs signing in again. The lines are core's
 * (myCalendarSettingsLines), shared with the phone. A teammate's calendar, opened from Members, is today's page alone.
 */
import {
  MY_CALENDAR_SETUP_WORDS as W,
  MY_CALENDAR_WEEKDAYS,
  formatHours,
  myCalendarIsSetUp,
  myCalendarSettingsLines,
  myCalendarSetupQuestions,
  providerName,
  type MyCalendarSetupContext,
} from '@hfos/core';
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import { ProviderMark } from './calendar-connection-card';

export function MyCalendarOverview({
  workspaceId,
  ctx,
  started,
  openAll,
  children,
}: {
  workspaceId: string;
  /** Your calendar as the setup reads it (my_calendar_setup.get). */
  ctx: MyCalendarSetupContext;
  /** The guided setup has answers saved: Start picks up where you left off. */
  started: boolean;
  /** `?all=1`, or coming back from a sign-in: All settings starts open. */
  openAll: boolean;
  /** Today's page (MyCalendar, and the coaching Zoom card). */
  children: ReactNode;
}) {
  const setup = `/onboarding/${workspaceId}/my-calendar`;
  const c = ctx.connection;
  const needsFixing = !!c && (c.status === 'reauth_required' || c.status === 'error');
  const [open, setOpen] = useState(openAll || needsFixing);
  const [syncing, setSyncing] = useState(false);
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

  async function syncNow(connectionId: string) {
    setSyncing(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/calendar_connection.sync_now', {
          body: { workspaceId, connectionId },
        }),
      );
      toast.success(W.summary.synced);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  const setUp = myCalendarIsSetUp(ctx);
  const lines = setUp ? myCalendarSettingsLines(ctx) : [];
  return (
    <div className="flex max-w-[980px] flex-col gap-4" data-testid="my-calendar-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-text-2">{W.summary.lead}</p>
        <Button
          variant="secondary"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="my-calendar-all-settings"
          data-testid="my-calendar-all-settings-toggle"
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

      {!setUp ? (
        <>
          <Card
            className="flex flex-wrap items-center gap-4 p-5"
            data-testid="my-calendar-set-up-card"
          >
            <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-border bg-card">
              <CalendarDays className="h-5 w-5 text-text-2" strokeWidth={1.75} />
            </span>
            <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{W.summary.setUp}</span>
              <span className="text-[13.5px] text-text-2">
                {W.summary.setUpHint(myCalendarSetupQuestions(ctx).length)}
              </span>
            </span>
            <ButtonLink href={setup} variant="primary" data-testid="my-calendar-set-up">
              {started ? W.summary.resume : W.summary.start}
              <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
            </ButtonLink>
          </Card>
          <div className="rounded-card bg-card-2 px-5 py-4" data-testid="my-calendar-until">
            <h2 className="mb-1 text-[14px] font-semibold">{W.summary.until}</h2>
            <p className="text-[13.5px] leading-relaxed text-text-2">
              {W.summary.untilHint(formatHours(MY_CALENDAR_WEEKDAYS))}
            </p>
          </div>
        </>
      ) : (
        <>
          {c ? (
            <Card
              className="flex flex-wrap items-center gap-4 p-5"
              data-testid="my-calendar-connected"
            >
              <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-border bg-card">
                <ProviderMark provider={c.provider} className="h-5 w-5" />
              </span>
              <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                  {c.accountEmail ?? providerName(c.provider)}
                  {needsFixing ? (
                    <Badge variant="pending">{W.summary.needsSignIn}</Badge>
                  ) : (
                    <Badge variant="ok">{W.summary.connected}</Badge>
                  )}
                </span>
                <span className="text-[13.5px] text-text-2">
                  {c.busySyncedAt
                    ? W.summary.checked(relativeTime(c.busySyncedAt))
                    : W.summary.notChecked}
                </span>
              </span>
              {c.status === 'active' ? (
                <Button
                  variant="secondary"
                  loading={syncing}
                  onClick={() => void syncNow(c.id)}
                  data-testid="my-calendar-sync-now"
                >
                  {syncing ? null : <RefreshCw className="h-4 w-4" strokeWidth={1.75} />}
                  {W.summary.syncNow}
                </Button>
              ) : null}
            </Card>
          ) : (
            <Card
              className="flex flex-wrap items-center gap-4 p-5"
              data-testid="my-calendar-no-calendar"
            >
              <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-border bg-card">
                <CalendarDays className="h-5 w-5 text-text-2" strokeWidth={1.75} />
              </span>
              <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{W.summary.noCalendar}</span>
                <span className="text-[13.5px] text-text-2">{W.summary.noCalendarHint}</span>
              </span>
              <ButtonLink
                href={`${setup}?at=calendar`}
                variant="secondary"
                data-testid="my-calendar-connect"
              >
                {W.summary.connect}
              </ButtonLink>
            </Card>
          )}
          <Card className="p-5" data-testid="my-calendar-answers">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2.5">
              <h2 className="text-[15px] font-semibold">{W.summary.answers}</h2>
              <Link
                href={setup}
                className="text-[13.5px] font-semibold text-accent-text hover:underline"
                data-testid="my-calendar-again"
              >
                {W.summary.again}
              </Link>
            </div>
            <div>
              {lines.map((l, n) => (
                <div
                  key={l.id}
                  className={cn(
                    'flex flex-wrap items-start gap-x-4 gap-y-1 py-3',
                    n > 0 && 'border-t border-border',
                  )}
                  data-testid={`my-calendar-answer-${l.id}`}
                >
                  <span className="w-[200px] flex-none text-[13.5px] text-text-2">{l.label}</span>
                  <span className="min-w-[180px] flex-1 text-[14px]">{l.value}</span>
                  {l.key === 'zoom' && !myCalendarSetupQuestions(ctx).includes('zoom') ? (
                    <span className="w-[52px] flex-none" />
                  ) : (
                    <Link
                      href={`${setup}?at=${l.key}`}
                      className="flex-none px-1 text-[13.5px] font-semibold text-accent-text hover:underline"
                      data-testid={`my-calendar-answer-change-${l.id}`}
                    >
                      {W.summary.change}
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {!open ? (
        <div className="rounded-card bg-card-2 px-5 py-4">
          <h2 className="mb-1 text-[14px] font-semibold">{W.summary.under}</h2>
          <p className="text-[13.5px] leading-relaxed text-text-2">{W.summary.underHint}</p>
        </div>
      ) : null}

      <div
        ref={allRef}
        id="my-calendar-all-settings"
        className="scroll-mt-20"
        hidden={!open}
        data-testid="my-calendar-all-settings"
      >
        {open ? children : null}
      </div>
    </div>
  );
}
