'use client';
/**
 * The coaching Zoom app on Settings → My calendar (AI Sales Coach in meetings): whether this person's Zoom is linked
 * to it in this business, Connect Zoom (the worker's sign-in, which comes back through /zoom/connect), and
 * Disconnect. Apart from the Video meetings card above, which makes meeting links with another Zoom app.
 */
import { Headset } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { publicEnv } from '@/lib/env';

export interface ZoomCoachAccount {
  readonly id: string;
  readonly accountEmail: string | null;
  readonly connectedAt: string;
}

export function ZoomCoachCard({
  workspaceId,
  account,
}: {
  workspaceId: string;
  account: ZoomCoachAccount | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    if (!account) return;
    setBusy(true);
    try {
      await apiBrowser()
        .POST('/v1/commands/live_meeting_account.disconnect', {
          body: { workspaceId, accountId: account.id },
        })
        .then(unwrap);
      toast.success('Zoom disconnected from coaching.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mt-4 space-y-2 p-4 md:p-5" data-testid="zoom-coach-card">
      <div className="flex items-center gap-2">
        <Headset className="h-4 w-4 text-accent-text" strokeWidth={1.75} aria-hidden />
        <h2 className="text-[15px] font-semibold">Coaching in Zoom meetings</h2>
      </div>
      {account ? (
        <>
          <p className="text-[13.5px]">
            Connected{account.accountEmail ? ` as ${account.accountEmail}` : ''}. In a Zoom meeting,
            open HandsFreeOS from Zoom’s Apps button to be coached.
          </p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </>
      ) : (
        <>
          <p className="text-[13.5px] text-text-2">
            Add HandsFreeOS’s coaching app to your Zoom, so the coach can listen in your meetings.
            It’s a separate Zoom app from the one that makes meeting links.
          </p>
          <a
            href={`${publicEnv.workerUrl}/oauth/zoom-live/start`}
            className={buttonClassName({ size: 'sm' })}
          >
            Connect Zoom
          </a>
        </>
      )}
    </Card>
  );
}
