/**
 * A HandsFreeOS video call on the phone (docs/video-calls.md, "On the phone"), as the web's `/call/<id>` for the team:
 * Join on the appointment, and the push about someone waiting, open it here.
 *
 * - **Before joining**: what the call is and who's in it already (read every few seconds), the AI's notes if they're
 *   on, and the microphone and camera to start with. Nothing turns on until Join.
 * - **Join** asks the worker for a ticket, as the web's does, and the room opens (./room.tsx, loaded then).
 * - **Afterwards**: why they're out, and joining again; the team can start an ended call again.
 * - **The stand-in** (`fake:` tickets, on laptops and in tests without LiveKit) carries nothing, so the screen says
 *   so; Let in and Leave still work, from the API.
 */
import { VIDEO_CALL_WORDS as W } from '@hfos/core';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { holdsAddon } from '@/addons/gate';
import { PHONE_ADDONS } from '@/addons/registry';
import { Mic, MicOff, PhoneOff, Video, VideoOff, X } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { cn } from '@/lib/utils';

import { afterCall, type CallEnd } from './ends';
import { loadRoom } from './load-room';
import {
  STAND_IN_URL,
  actOn,
  joinVideoCall,
  useVideoCall,
  whoIsHere,
  type CallChoices,
  type TeamJoin,
  type TeamSide,
} from './team-call';

/** LiveKit and its native parts load with the first call, not with the app. */
const CallRoom = React.lazy(loadRoom);

type Step =
  | { readonly kind: 'pre' }
  | { readonly kind: 'in'; readonly join: TeamJoin }
  | { readonly kind: 'after'; readonly end: CallEnd };

export function PhoneCall({ workspaceId, callId }: { workspaceId: string; callId: string }) {
  const [step, setStep] = React.useState<Step>({ kind: 'pre' });
  const [choices, setChoices] = React.useState<CallChoices>({ mic: true, camera: true });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The room reads the call for itself; before and after, this does.
  const { got, failed } = useVideoCall(workspaceId, callId, step.kind !== 'in');

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(workspaceId));
  };

  const join = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStep({ kind: 'in', join: await joinVideoCall(callId) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = got?.appointment?.title ?? W.name;
  const detail = got?.appointment?.customers.map((c) => c.name).join(', ') || null;

  if (step.kind === 'in') {
    const team: TeamSide = { workspaceId, callId, personId: step.join.personId };
    const onEnd = (end: CallEnd) => setStep({ kind: 'after', end });
    if (step.join.ticket.url === STAND_IN_URL)
      return <StandIn title={title} team={team} onLeave={() => onEnd('left')} />;
    return (
      <React.Suspense fallback={<Dark>{W.joining}</Dark>}>
        <CallRoom
          ticket={step.join.ticket}
          choices={choices}
          title={title}
          detail={detail}
          team={team}
          top={<AddonCallCards workspaceId={workspaceId} />}
          onEnd={onEnd}
        />
      </React.Suspense>
    );
  }

  if (!got)
    return (
      <Frame onClose={close}>
        <Text className="text-center text-[14px] text-white/70" testID="call-opening">
          {failed ? errorMessage(failed) : W.opening}
        </Text>
      </Frame>
    );

  if (!got.call)
    return (
      <Frame onClose={close}>
        <Text className="text-center text-[15px] text-white" testID="call-problem">
          This call isn’t here any more. Open the appointment to start a new one.
        </Text>
      </Frame>
    );

  if (step.kind === 'after') {
    const words = afterCall(step.end);
    return (
      <Frame onClose={close}>
        <View className="items-center gap-2" testID="call-after">
          <Text className="text-center text-[18px] font-semibold text-white">{words.title}</Text>
          {words.body ? (
            <Text className="text-center text-[14px] leading-5 text-white/70">{words.body}</Text>
          ) : null}
        </View>
        <View className="w-full gap-2">
          <Button loading={busy} onPress={() => void join()} testID="call-again">
            {words.again}
          </Button>
          <Button variant="ghost" onPress={close} testID="call-close">
            <Text className="text-white/80">Close</Text>
          </Button>
        </View>
        {error ? <Problem>{error}</Problem> : null}
      </Frame>
    );
  }

  const ended = got.call.state === 'ended';
  return (
    <Frame onClose={close}>
      <View className="items-center gap-2" testID="call-pre">
        <Text className="text-center text-[20px] font-semibold text-white" testID="call-heading">
          {title}
        </Text>
        {detail ? <Text className="text-center text-[14px] text-white/70">{detail}</Text> : null}
        <Text className="mt-2 text-center text-[14px] text-white" testID="call-who">
          {ended ? W.endedTeam : whoIsHere(got.people)}
        </Text>
        {got.call.aiNotes ? (
          <Text
            className="text-center text-[13px] leading-[18px] text-white/60"
            testID="call-ai-notice"
          >
            {W.emailNotice}
          </Text>
        ) : null}
      </View>
      <View className="flex-row justify-center gap-6">
        <Choice
          on={choices.mic}
          onIcon={Mic}
          offIcon={MicOff}
          label={choices.mic ? 'Microphone on' : 'Microphone off'}
          onPress={() => setChoices((c) => ({ ...c, mic: !c.mic }))}
          testID="call-pre-mic"
        />
        <Choice
          on={choices.camera}
          onIcon={Video}
          offIcon={VideoOff}
          label={choices.camera ? 'Camera on' : 'Camera off'}
          onPress={() => setChoices((c) => ({ ...c, camera: !c.camera }))}
          testID="call-pre-camera"
        />
      </View>
      <Button className="w-full" loading={busy} onPress={() => void join()} testID="call-join">
        {ended ? 'Start it again' : W.join}
      </Button>
      {error ? <Problem>{error}</Problem> : null}
    </Frame>
  );
}

/** The dark screen around the call, before and after it, with Close in the corner. */
function Frame({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-1 bg-[#0b0e13] px-6"
      style={{ paddingTop: insets.top + 6, paddingBottom: Math.max(insets.bottom, 16) }}
      testID="call-frame"
    >
      <StatusBar style="light" />
      <Pressable
        role="button"
        accessibilityLabel="Close"
        onPress={onClose}
        hitSlop={8}
        className="size-10 items-center justify-center self-start rounded-full bg-[#2c3139]"
        testID="call-frame-close"
      >
        <Icon as={X} className="size-5 text-white" />
      </Pressable>
      <View className="flex-1 items-center justify-center gap-7">{children}</View>
    </View>
  );
}

function Dark({ children }: { children: string }) {
  return (
    <View className="flex-1 items-center justify-center bg-[#0b0e13]">
      <Text className="text-[14px] text-white/70">{children}</Text>
    </View>
  );
}

function Problem({ children }: { children: string }) {
  return (
    <Text className="text-center text-[13.5px] text-[#ff8a80]" role="alert" testID="call-error">
      {children}
    </Text>
  );
}

function Choice({
  on,
  onIcon,
  offIcon,
  label,
  onPress,
  testID,
}: {
  on: boolean;
  onIcon: typeof Mic;
  offIcon: typeof Mic;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={onPress}
      className="items-center gap-1.5"
      testID={testID}
    >
      <View
        className={cn(
          'size-14 items-center justify-center rounded-full',
          on ? 'bg-[#2c3139]' : 'bg-[#c43335]',
        )}
      >
        <Icon as={on ? onIcon : offIcon} className="size-6 text-white" />
      </View>
      <Text className="text-[12px] text-white/80">{label}</Text>
    </Pressable>
  );
}

/** What add-ons show over the top of the call, for the add-ons the person may use (the registry's `CallCard`). */
function AddonCallCards({ workspaceId }: { workspaceId: string }) {
  const grants = useGrants();
  const cards = PHONE_ADDONS.filter((a) => a.CallCard && holdsAddon(grants, a.permission));
  if (!cards.length) return null;
  return (
    <View className="gap-2">
      {cards.map(({ addonId, CallCard }) =>
        CallCard ? <CallCard key={addonId} workspaceId={workspaceId} /> : null,
      )}
    </View>
  );
}

/**
 * The stand-in's call: no video or sound to carry, so the screen says so. Let in works from the API, and Leave, so
 * the rest of a call's flow can be tried without LiveKit.
 */
function StandIn({ title, team, onLeave }: { title: string; team: TeamSide; onLeave: () => void }) {
  const insets = useSafeAreaInsets();
  const { got, reload } = useVideoCall(team.workspaceId, team.callId);
  const knocking = got?.people.filter((p) => p.state === 'waiting' && p.kind === 'guest') ?? [];
  return (
    <View
      className="flex-1 bg-[#0b0e13] px-6"
      style={{ paddingTop: insets.top + 12, paddingBottom: Math.max(insets.bottom, 16) }}
      testID="call-room"
    >
      <StatusBar style="light" />
      <Text className="text-[16px] font-semibold text-white" testID="call-title">
        {title}
      </Text>
      <View className="flex-1 items-center justify-center gap-4" testID="call-stand-in">
        <Avatar name={title} size="xl" />
        <Text className="text-center text-[14px] leading-5 text-white/70">{W.standIn}</Text>
        {knocking.map((p) => (
          <View key={p.id} className="w-full flex-row items-center justify-between gap-2">
            <Text className="min-w-0 flex-1 text-[14px] text-white">{W.askingToJoin(p.name)}</Text>
            <Button
              size="sm"
              onPress={() =>
                void actOn('admit', {
                  workspaceId: team.workspaceId,
                  callId: team.callId,
                  personId: p.id,
                })
                  .then(reload)
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              {W.letIn}
            </Button>
          </View>
        ))}
      </View>
      <Pressable
        role="button"
        onPress={onLeave}
        className="h-11 flex-row items-center justify-center gap-2 self-center rounded-full bg-[#c43335] px-5"
        testID="call-leave"
      >
        <Icon as={PhoneOff} className="size-[18px] text-white" />
        <Text className="text-[15px] font-semibold text-white">Leave</Text>
      </Pressable>
    </View>
  );
}
