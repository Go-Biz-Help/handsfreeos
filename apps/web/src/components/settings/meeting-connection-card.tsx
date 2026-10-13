'use client';
import { MoreHorizontal, Unplug, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import type { MeetingConnection } from '@/lib/api/types';
import { publicEnv } from '@/lib/env';

/** What coming back from Zoom's sign-in says (`?meeting=`). */
const RESULT: Record<string, { tone: 'success' | 'info' | 'error'; text: string }> = {
  connected: { tone: 'success', text: 'Zoom is connected.' },
  cancelled: { tone: 'info', text: 'Sign-in cancelled. Zoom wasn’t connected.' },
  missing_permissions: {
    tone: 'error',
    text: 'Zoom didn’t give all the permissions HandsFreeOS needs, so it didn’t connect. Try again and allow everything asked.',
  },
  failed: { tone: 'error', text: 'Zoom didn’t connect. Try again in a minute.' },
};

/** Starts connecting your own Zoom account: a one-time state, then Zoom's sign-in. */
async function connectZoom(workspaceId: string): Promise<void> {
  const out = unwrap(
    await apiBrowser().POST('/v1/commands/meeting_connection.connect', {
      body: { workspaceId, provider: 'zoom' },
    }),
  );
  window.location.assign(
    `${publicEnv.workerUrl}/oauth/zoom/start?state=${encodeURIComponent(out.state)}`,
  );
}

/**
 * A person's Zoom connection: not connected, connected, or needs reconnecting. Pending sign-ins are left out by
 * the page; only the person connects.
 */
export function MeetingConnectionCard({
  workspaceId,
  connection,
  isSelf,
  canManage,
  firstName,
  result,
}: {
  workspaceId: string;
  connection: MeetingConnection | null;
  isSelf: boolean;
  canManage: boolean;
  firstName: string;
  result: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const told = useRef(false);
  useEffect(() => {
    if (!result || told.current) return;
    told.current = true;
    const r = RESULT[result] ?? RESULT.failed!;
    if (r.tone === 'success') toast.success(r.text);
    else if (r.tone === 'error') toast.error(r.text);
    else toast(r.text);
    router.replace(`/app/w/${workspaceId}/settings/my-calendar`, { scroll: false });
  }, [result, router, workspaceId]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }
  const connect = () => void run('connect', () => connectZoom(workspaceId));
  const disconnect = (c: MeetingConnection) =>
    void run('disconnect', async () => {
      if (
        !confirm(
          `Disconnect Zoom (${c.accountEmail ?? 'this account'})? Meetings already made stay in Zoom.`,
        )
      ) {
        setBusy(null);
        return;
      }
      unwrap(
        await apiBrowser().POST('/v1/commands/meeting_connection.disconnect', {
          body: { workspaceId, connectionId: c.id },
        }),
      );
      toast.success('Zoom disconnected.');
      setBusy(null);
      router.refresh();
    });

  const box = (children: ReactNode, status: string) => (
    <div
      className="flex items-center gap-3 rounded-menu border border-border px-3 py-2.5"
      data-testid="meeting-connection"
      data-status={status}
    >
      <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-control border border-border bg-card">
        <Video className="h-4 w-4 text-text-2" strokeWidth={1.5} />
      </span>
      {children}
    </div>
  );

  if (!connection || connection.status === 'pending' || connection.status === 'disconnected')
    return box(
      <>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium">
            {isSelf ? 'Zoom isn’t connected' : `${firstName} hasn’t connected Zoom`}
          </span>
          <span className="text-xs text-text-3">
            {isSelf
              ? 'Connect your Zoom account so your online appointments can get Zoom links.'
              : 'Only they can connect it, from their own My calendar.'}
          </span>
        </span>
        {isSelf ? (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'connect'}
            onClick={connect}
            data-testid="connect-zoom"
          >
            Connect Zoom
          </Button>
        ) : null}
      </>,
      'none',
    );

  const c = connection;
  const menu =
    isSelf || canManage ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Zoom actions">
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
    <span className="min-w-0 truncate text-[13px] font-medium">{c.accountEmail ?? 'Zoom'}</span>
  );

  if (c.status === 'active')
    return box(
      <>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            {account}
            <Badge variant="ok">Connected</Badge>
          </span>
          <span className="text-xs text-text-3">Zoom is ready for online appointments.</span>
        </span>
        {menu}
      </>,
      'active',
    );

  return box(
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {account}
          <Badge variant="danger">
            {c.status === 'reauth_required' ? 'Needs reconnecting' : 'Not working'}
          </Badge>
        </span>
        <span className="text-xs text-text-3">
          {c.status === 'reauth_required'
            ? `Zoom stopped letting HandsFreeOS in. ${isSelf ? 'Reconnect' : `${firstName} needs to reconnect`} to keep making Zoom links.`
            : (c.lastError ?? 'Zoom didn’t answer the last time we tried. We keep trying.')}
        </span>
      </span>
      {isSelf ? (
        <Button
          size="sm"
          loading={busy === 'connect'}
          onClick={connect}
          data-testid="zoom-reconnect"
        >
          Reconnect
        </Button>
      ) : null}
      {menu}
    </>,
    c.status,
  );
}
