'use client';
/**
 * A calendar's page in Settings → Calendars (the owner, 22 Nov 2026, C3 a): one simple card with the guided setup's
 * seven answers, each with Change, which opens that part of All settings. Its link, Open for booking or Pause, and
 * what still needs fixing sit above it. Every setting is still in All settings (the builder), with History and
 * Archive, so nothing a calendar could do before is gone. The lines are core's (calendarCardLines), shared with the
 * phone.
 */
import { CALENDAR_CARD_WORDS as W, moduleOfField, type CalendarCardLine } from '@hfos/core';
import { ChevronRight, CircleAlert, Copy, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CalendarDetail, CalendarStatus } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { CalendarEmbed } from './embed-dialog';
import { CalendarDot, CalendarStatusBadge } from './chips';

export function CalendarCard({
  workspaceId,
  calendar,
  lines,
  brandedOrigin,
}: {
  workspaceId: string;
  calendar: CalendarDetail;
  lines: readonly CalendarCardLine[];
  brandedOrigin: string | null;
}) {
  const router = useRouter();
  useLiveRefresh(['calendar', 'service', 'resource', 'territory', 'booking_site']);
  const origin = usePublicOrigin(brandedOrigin);
  const [busy, setBusy] = useState(false);
  const base = `/app/w/${workspaceId}/settings`;
  const all = `${base}/calendars/${calendar.id}/all`;
  const link = `${origin}${calendar.bookingPath ?? calendar.permanentPath}`;
  const issues = calendar.issues;

  async function setStatus(status: Extract<CalendarStatus, 'active' | 'paused'>) {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/calendar.set_status', {
          body: { workspaceId, calendarId: calendar.id, status },
        }),
      );
      toast.success(status === 'active' ? W.opened(calendar.name) : W.pausedNow(calendar.name));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="calendar-card" data-calendar-id={calendar.id} className="pb-6">
      <div className="mb-2 flex items-center gap-1 text-xs text-text-3">
        <Link href={base} className="text-accent-text hover:underline">
          Settings
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <Link href={`${base}/calendars`} className="text-accent-text hover:underline">
          Calendars
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span className="truncate">{calendar.name}</span>
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <CalendarDot color={calendar.color} className="h-3 w-3" />
          <h1
            className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl"
            data-testid="calendar-card-name"
          >
            {calendar.name}
          </h1>
          <CalendarStatusBadge status={calendar.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {calendar.status === 'draft' || calendar.status === 'paused' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void setStatus('active')}
              data-testid="calendar-card-open"
            >
              {calendar.status === 'draft' ? W.open : W.resume}
            </Button>
          ) : calendar.status === 'active' ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void setStatus('paused')}
              data-testid="calendar-card-pause"
            >
              {W.pause}
            </Button>
          ) : null}
          <ButtonLink href={all} size="sm" data-testid="calendar-card-all-top">
            <SlidersHorizontal className="h-4 w-4" strokeWidth={1.5} />
            {W.all.title}
          </ButtonLink>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
        {calendar.status !== 'active' ? (
          <p className="text-[13.5px] text-text-2" data-testid="calendar-card-status-note">
            {calendar.status === 'draft'
              ? W.draft
              : calendar.status === 'paused'
                ? W.paused
                : W.archived}
          </p>
        ) : null}

        {issues.length ? (
          <Callout
            tone={issues.some((i) => i.severity === 'error') ? 'danger' : 'warning'}
            icon={CircleAlert}
            data-testid="calendar-card-issues"
          >
            <div className="font-semibold">{W.toCheck}</div>
            <ul className="mt-1 flex flex-col gap-1">
              {issues.map((i) => {
                const part = i.fields.map(moduleOfField).find((m) => !!m) ?? null;
                return (
                  <li key={i.code + i.message} className="flex flex-wrap items-baseline gap-x-2">
                    <span>{i.message}.</span>
                    <Link
                      href={part ? `${all}?part=${part}` : all}
                      className="font-medium underline"
                    >
                      {W.fix}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Callout>
        ) : null}

        <Card className="p-4 sm:p-5">
          <div className="mb-2.5 text-[13.5px] font-semibold">{W.link}</div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="flex h-10 min-w-0 flex-1 basis-[260px] items-center truncate rounded-control border border-border-strong bg-card-2 px-3 font-mono text-[13px]"
              data-testid="calendar-card-link"
            >
              {link.replace(/^https?:\/\//, '')}
            </span>
            <Button variant="secondary" onClick={() => void copyText(link, W.copied)}>
              <Copy className="h-4 w-4" strokeWidth={1.75} />
              {W.copy}
            </Button>
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-control border border-border-strong bg-card px-3.5 text-sm font-medium shadow-1 hover:bg-card-2"
            >
              {W.see}
            </a>
            <CalendarEmbed
              workspaceId={workspaceId}
              calendarId={calendar.id}
              calendarName={calendar.name}
              bookingUrl={calendar.bookingPath ? link : null}
              embedOrigins={calendar.embedOrigins}
              bookingSiteHref={`${base}/calendars/booking-site`}
            />
          </div>
        </Card>

        <Card className="overflow-hidden" data-testid="calendar-card-lines">
          <ul>
            {lines.map((l, i) => (
              <li
                key={l.key}
                className={
                  'flex items-start gap-3 px-4 py-3.5 sm:px-5' +
                  (i ? ' border-t border-border' : '')
                }
                data-testid={`calendar-card-line-${l.key}`}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[12.5px] text-text-3">{l.label}</span>
                  <span className="text-[14.5px] font-medium">{l.value ?? 'Not set'}</span>
                  {l.detail ? <span className="text-[13px] text-text-2">{l.detail}</span> : null}
                </span>
                <ButtonLink
                  href={l.section ? `${all}?part=${l.section}` : all}
                  variant="ghost"
                  size="sm"
                  data-testid={`calendar-card-change-${l.key}`}
                >
                  {W.change}
                </ButtonLink>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex min-w-0 flex-1 basis-[280px] flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold">{W.all.title}</span>
            <span className="text-[13px] text-text-2">{W.all.hint}</span>
          </span>
          <ButtonLink href={all} data-testid="calendar-card-all">
            {W.all.button}
          </ButtonLink>
        </Card>
      </div>
    </div>
  );
}
