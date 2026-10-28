'use client';
/**
 * Calls any time (docs/video-calls.md, part 5): **Video call** on a customer's page and in a conversation, and
 * **Switch to video** on the phone call's bar. Each sends the customer their own link, as you, and opens the call
 * for you in a tab of its own, as Join video call on an appointment does. The tab opens as you press, so the
 * browser doesn't take it for a pop-up, and goes to the call once the link is on its way.
 */
import { ChevronDown, Video } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { VIDEO_CALL_WORDS } from '@hfos/core';
import { useCan, useWorkspaceShell } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { errorMessage } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { startVideoCall, type StartedVideoCall } from '@/lib/api/worker';

export type VideoCallTarget =
  | { readonly personId: string; readonly channel?: 'sms' | 'email' }
  | { readonly conversationId: string };

/** Whether this person can start a call here: calls are on, and they can change appointments and use the inbox. */
export function useCanStartVideoCall(): boolean {
  const { videoCalls } = useWorkspaceShell();
  const appointments = useCan('appointments.write');
  const inbox = useCan('inbox.use');
  return videoCalls && appointments && inbox;
}

/** Starts a call with a customer and opens it; resolves to the call, or null when it didn't start. */
export function useStartVideoCall(workspaceId: string): {
  readonly busy: boolean;
  start(
    target: VideoCallTarget,
    opts?: { readonly after?: string },
  ): Promise<StartedVideoCall | null>;
} {
  const [busy, setBusy] = useState(false);
  async function start(target: VideoCallTarget, opts: { readonly after?: string } = {}) {
    const tab = window.open('', '_blank');
    setBusy(true);
    try {
      let out: StartedVideoCall;
      try {
        out = await startVideoCall({ workspaceId, ...target });
      } catch (e) {
        // In quiet hours only a person's yes sends a text, as in the composer.
        if (!(e instanceof ApiError && e.rule === 'quiet_hours')) throw e;
        if (!window.confirm(`${e.message} Send the link anyway?`)) {
          tab?.close();
          return null;
        }
        out = await startVideoCall({ workspaceId, ...target, acknowledgeQuietHours: true });
      }
      const path = `/call/${out.callId}`;
      if (tab) tab.location.href = path;
      toast.success(VIDEO_CALL_WORDS.started(out.name, out.channel), {
        ...(opts.after ? { description: opts.after } : {}),
        // A browser that blocked the tab anyway: the call is a press away.
        ...(tab
          ? {}
          : { action: { label: VIDEO_CALL_WORDS.join, onClick: () => window.open(path) } }),
      });
      return out;
    } catch (e) {
      tab?.close();
      toast.error(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, start };
}

/**
 * The customer page's button. With a number and an email it asks which the link goes by; with one of them it goes
 * by that; with neither there's nowhere to send it, so there's no button.
 */
export function StartVideoCallButton({
  workspaceId,
  personId,
  phone,
  email,
}: {
  workspaceId: string;
  personId: string;
  /** Their number as it's shown, when they have one. */
  phone: string | null;
  email: string | null;
}) {
  const allowed = useCanStartVideoCall();
  const { busy, start } = useStartVideoCall(workspaceId);
  if (!allowed || (!phone && !email)) return null;
  if (phone && email)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" loading={busy} data-testid="action-video-call">
            <Video className="h-4 w-4" strokeWidth={1.5} />
            {VIDEO_CALL_WORDS.start}
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => void start({ personId, channel: 'sms' })}
            data-testid="video-call-by-text"
          >
            {VIDEO_CALL_WORDS.sendBy.sms(phone)}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void start({ personId, channel: 'email' })}
            data-testid="video-call-by-email"
          >
            {VIDEO_CALL_WORDS.sendBy.email(email)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={busy}
      title={phone ? VIDEO_CALL_WORDS.sendBy.sms(phone) : VIDEO_CALL_WORDS.sendBy.email(email!)}
      onClick={() => void start({ personId, channel: phone ? 'sms' : 'email' })}
      data-testid="action-video-call"
    >
      <Video className="h-4 w-4" strokeWidth={1.5} />
      {VIDEO_CALL_WORDS.start}
    </Button>
  );
}
