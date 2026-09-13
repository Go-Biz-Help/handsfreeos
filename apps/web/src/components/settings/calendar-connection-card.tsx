'use client';
import { CalendarDays, MoreHorizontal, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CalendarConnection } from '@/lib/api/types';
import { publicEnv } from '@/lib/env';
import { formatDate } from '@/lib/format';
import { relativeTime } from '@/lib/utils';
import { GoogleLogo, MicrosoftLogo } from './provider-logos';

type Provider = CalendarConnection['provider'];
export const calendarProviderName = (p: Provider): string =>
  p === 'google' ? 'Google Calendar' : 'Outlook';

/** Starts connecting your own calendar: a one-time state, then Google's or Microsoft's sign-in. */
export async function connectCalendar(workspaceId: string, provider: Provider): Promise<void> {
  const out = unwrap(
    await apiBrowser().POST('/v1/commands/calendar_connection.connect', {
      body: { workspaceId, provider },
    }),
  );
  window.location.assign(
    `${publicEnv.workerUrl}/oauth/${provider}/start?state=${encodeURIComponent(out.state)}`,
  );
}

export function ProviderMark({ provider, className }: { provider: Provider; className?: string }) {
  return provider === 'google' ? (
    <GoogleLogo className={className} />
  ) : (
    <MicrosoftLogo className={className} />
  );
}

/**
 * A person's Google or Outlook connection, in all its states: not connected, connected (sync now), not
 * syncing, and needs reconnecting. Pending sign-ins are left out by the page; only the person connects.
 */
export function CalendarConnectionCard({
  workspaceId,
  connection,
  isSelf,
  canManage,
  firstName,
}: {
  workspaceId: string;
  connection: CalendarConnection | null;
  isSelf: boolean;
  canManage: boolean;
  firstName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }
  const connect = (provider: Provider) =>
    void run(provider, () => connectCalendar(workspaceId, provider));
  const syncNow = (c: CalendarConnection) =>
    void run('sync', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/calendar_connection.sync_now', {
          body: { workspaceId, connectionId: c.id },
        }),
      );
      toast.success('Checking busy times now.');
      setBusy(null);
    });
  const disconnect = (c: CalendarConnection) =>
    void run('disconnect', async () => {
      if (
        !confirm(
          `Disconnect ${c.accountEmail ?? calendarProviderName(c.provider)}? Busy times there stop blocking bookings. Events already added stay.`,
        )
      ) {
        setBusy(null);
        return;
      }
      unwrap(
        await apiBrowser().POST('/v1/commands/calendar_connection.disconnect', {
          body: { workspaceId, connectionId: c.id },
        }),
      );
      toast.success('Disconnected.');
      setBusy(null);
      router.refresh();
    });

  const box = (children: ReactNode, status: string) => (
    <div
      className="flex items-center gap-3 rounded-menu border border-border px-3 py-2.5"
      data-testid="calendar-connection"
      data-status={status}
    >
      {children}
    </div>
  );
  const mark = (provider: Provider | null) => (
    <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-control border border-border bg-card">
      {provider ? (
        <ProviderMark provider={provider} className="h-[18px] w-[18px]" />
      ) : (
        <CalendarDays className="h-4 w-4 text-text-3" strokeWidth={1.5} />
      )}
    </span>
  );

  if (!connection || connection.status === 'pending' || connection.status === 'disconnected') {
    return (
      <>
        {box(
          <>
            {mark(null)}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-medium">
                {isSelf ? 'Not connected yet' : `${firstName} hasn’t connected a calendar`}
              </span>
              <span className="text-xs text-text-3">
                {isSelf
                  ? 'Connect so nobody books you when you’re busy. We only see busy times, never what they are.'
                  : 'Only they can connect it, from their own My calendar.'}
              </span>
            </span>
            {isSelf ? (
              <span className="flex flex-none flex-col gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'google'}
                  onClick={() => connect('google')}
                  data-testid="connect-google-calendar"
                >
                  <GoogleLogo className="h-4 w-4" />
                  Google
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'microsoft'}
                  onClick={() => connect('microsoft')}
                  data-testid="connect-outlook-calendar"
                >
                  <MicrosoftLogo className="h-4 w-4" />
                  Outlook
                </Button>
              </span>
            ) : null}
          </>,
          'none',
        )}
        {isSelf ? (
          <p className="mt-2 text-xs text-text-3">
            HandsFreeOS appointments are added to that calendar as events, so they show on your
            phone too.
          </p>
        ) : null}
      </>
    );
  }

  const c = connection;
  const name = calendarProviderName(c.provider);
  const menu =
    isSelf || canManage ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Connection actions">
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem danger onSelect={() => disconnect(c)}>
            <Unplug className="h-4 w-4" strokeWidth={1.5} />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const account = (
    <span className="min-w-0 truncate text-[13px] font-medium">{c.accountEmail ?? name}</span>
  );

  if (c.status === 'active')
    return box(
      <>
        {mark(c.provider)}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            {account}
            <Badge variant="ok">Connected</Badge>
          </span>
          <span className="text-xs text-text-3">
            {c.busySyncedAt
              ? `Busy times checked ${relativeTime(c.busySyncedAt)}. Appointments show there as events.`
              : 'Checking busy times now. Appointments show there as events.'}
          </span>
        </span>
        {isSelf ? (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'sync'}
            onClick={() => syncNow(c)}
            data-testid="calendar-sync-now"
          >
            Sync now
          </Button>
        ) : null}
        {menu}
      </>,
      'active',
    );

  if (c.status === 'reauth_required')
    return box(
      <>
        {mark(c.provider)}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            {account}
            <Badge variant="danger">Needs reconnecting</Badge>
          </span>
          <span className="text-xs text-text-3">
            {name} stopped letting us in
            {c.busySyncedAt ? ` after ${formatDate(c.busySyncedAt)}` : ''}. Until{' '}
            {isSelf ? 'you reconnect, you' : `${firstName} reconnects, they`} can be booked over
            busy times.
          </span>
        </span>
        {isSelf ? (
          <Button
            size="sm"
            loading={busy === c.provider}
            onClick={() => connect(c.provider)}
            data-testid="calendar-reconnect"
          >
            Reconnect
          </Button>
        ) : null}
        {menu}
      </>,
      'reauth_required',
    );

  return box(
    <>
      {mark(c.provider)}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {account}
          <Badge variant="danger">Not syncing</Badge>
        </span>
        <span className="text-xs text-text-3">
          {c.lastError ?? 'We couldn’t read busy times the last time we tried.'} We keep trying.
        </span>
      </span>
      {isSelf ? (
        <span className="flex flex-none flex-col gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'sync'}
            onClick={() => syncNow(c)}
          >
            Sync now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === c.provider}
            onClick={() => connect(c.provider)}
          >
            Reconnect
          </Button>
        </span>
      ) : null}
      {menu}
    </>,
    'error',
  );
}
