/**
 * Calls any time on the phone (docs/video-calls.md, part 5), as the web's `components/video-call/start-call.tsx`:
 * **Video call** on a customer's screen and in a conversation, and **Switch to video** on the call sheet. Each sends
 * the customer their own link, as you, then opens the call here. It needs signal, as the call itself does.
 *
 * Whether a business has video calls is `workspace.get`'s to say (support turns them on), so it's asked once while
 * the app is open; until it answers, there's no button.
 */
import {
  holds,
  VIDEO_CALL_WORDS as W,
  videoCallAppPath,
  type VideoCallInviteChannel,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { NEEDS_SIGNAL } from '@/changes';
import { Mail, MessageCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage, unwrap } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { networkSnapshot, useNetwork } from '@/lib/network';
import { workerPost } from '@/lib/worker';

/** The worker's answer: the call, who it's with, and how their link went. */
export interface StartedVideoCall {
  readonly callId: string;
  readonly personId: string;
  readonly conversationId: string | null;
  readonly channel: VideoCallInviteChannel;
  /** The customer, for "Dana’s link is on its way". */
  readonly name: string;
}

export type VideoCallTarget =
  | { readonly personId: string; readonly channel?: 'sms' | 'email' }
  | { readonly conversationId: string };

/** A call with a customer: the worker builds their link (on the business's own domain once one works) and sends it. */
export function startVideoCall(
  input: { workspaceId: string; acknowledgeQuietHours?: boolean } & VideoCallTarget,
): Promise<StartedVideoCall> {
  return workerPost<StartedVideoCall>('/v1/video-calls/start', input);
}

const callsOn = new Map<string, boolean>();

/** Whether this business has video calls, asked once while the app is open. False until it's known. */
export function useVideoCallsOn(workspaceId: string): boolean {
  const { online } = useNetwork();
  const [on, setOn] = React.useState(() => callsOn.get(workspaceId) ?? false);
  React.useEffect(() => {
    const known = callsOn.get(workspaceId);
    if (known !== undefined) {
      setOn(known);
      return;
    }
    if (!online) return;
    let live = true;
    api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrap)
      .then((out) => {
        callsOn.set(workspaceId, out.workspace.videoCalls);
        if (live) setOn(out.workspace.videoCalls);
      })
      // Asked again the next time a screen with the button opens.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId, online]);
  return on;
}

/** Whether this person can start a call here: calls are on, and they can change appointments and use the inbox. */
export function useCanStartVideoCall(workspaceId: string): boolean {
  const grants = useGrants();
  const on = useVideoCallsOn(workspaceId);
  return on && holds(grants, 'appointments.write') && holds(grants, 'inbox.use');
}

/** What the sheet asks: how the link goes, or whether to send it in quiet hours. */
type Ask =
  | {
      readonly kind: 'choose';
      readonly personId: string;
      readonly phone: string;
      readonly email: string;
      readonly after?: string;
    }
  | {
      readonly kind: 'quiet';
      readonly target: VideoCallTarget;
      readonly message: string;
      readonly after?: string;
    };

/**
 * Starts a call with a customer and opens it. `sheet` is the question it may ask (text or email; quiet hours), for the
 * screen to put once anywhere in its tree.
 */
export function useStartVideoCall(workspaceId: string): {
  readonly busy: boolean;
  start(target: VideoCallTarget, opts?: { readonly after?: string }): Promise<void>;
  /** With a number and an email: asks which the link goes by, then starts. */
  choose(personId: string, phone: string, email: string): void;
  readonly sheet: React.ReactNode;
} {
  const [busy, setBusy] = React.useState(false);
  const [ask, setAsk] = React.useState<Ask | null>(null);
  // The sheet's pick runs once it's gone: iOS opens nothing (the call screen included) while a modal is going.
  const pending = React.useRef<(() => void) | null>(null);

  const start = async (
    target: VideoCallTarget,
    opts: { readonly after?: string; readonly quietOk?: boolean } = {},
  ) => {
    if (!networkSnapshot().online) {
      toast.error(NEEDS_SIGNAL);
      return;
    }
    setBusy(true);
    toast.show(W.starting);
    try {
      const out = await startVideoCall({
        workspaceId,
        ...target,
        ...(opts.quietOk ? { acknowledgeQuietHours: true } : {}),
      });
      toast.show(
        opts.after
          ? `${W.started(out.name, out.channel)} ${opts.after}`
          : W.started(out.name, out.channel),
      );
      router.push(videoCallAppPath(workspaceId, out.callId) as Href);
    } catch (e) {
      // In quiet hours only a person's yes sends a text, as in the composer.
      if (e instanceof ApiError && e.rule === 'quiet_hours' && !opts.quietOk) {
        toast.dismiss();
        setAsk({ kind: 'quiet', target, message: e.message, after: opts.after });
      } else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (fn: () => void) => {
    pending.current = fn;
    setAsk(null);
  };

  const sheet = (
    <Sheet
      open={ask !== null}
      onClose={() => setAsk(null)}
      onClosed={() => {
        const fn = pending.current;
        pending.current = null;
        fn?.();
      }}
      title={ask?.kind === 'quiet' ? undefined : W.start}
      description={ask?.kind === 'quiet' ? ask.message : W.sendHow}
      testID="video-call-ask"
    >
      {ask?.kind === 'choose' ? (
        <View className="mt-3 gap-2">
          <Button
            variant="secondary"
            icon={MessageCircle}
            onPress={() => pick(() => void start({ personId: ask.personId, channel: 'sms' }))}
            testID="video-call-by-text"
          >
            {W.sendBy.sms(ask.phone)}
          </Button>
          <Button
            variant="secondary"
            icon={Mail}
            onPress={() => pick(() => void start({ personId: ask.personId, channel: 'email' }))}
            testID="video-call-by-email"
          >
            {W.sendBy.email(ask.email)}
          </Button>
        </View>
      ) : ask?.kind === 'quiet' ? (
        <View className="mt-3 gap-2">
          <Button
            onPress={() => pick(() => void start(ask.target, { after: ask.after, quietOk: true }))}
            testID="video-call-send-anyway"
          >
            {W.sendAnyway}
          </Button>
          <Button variant="secondary" onPress={() => setAsk(null)} testID="video-call-not-now">
            Not now
          </Button>
        </View>
      ) : null}
    </Sheet>
  );

  return {
    busy,
    start: (target, opts) => start(target, opts),
    choose: (personId, phone, email) => setAsk({ kind: 'choose', personId, phone, email }),
    sheet,
  };
}
