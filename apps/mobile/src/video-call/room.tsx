/**
 * A HandsFreeOS video call in progress on the phone (docs/video-calls.md, "On the phone"): LiveKit's room, joined on
 * the ticket the worker signed. Only the team joins from the app, so the team's buttons are always here. It's loaded
 * the first time someone joins a call (./phone-call.tsx), so LiveKit and its native parts start then, not with the app.
 *
 * - **The stage**: one other person fills the screen with you in the corner; more share it in a grid. A shared screen
 *   (from a computer) goes big, with everyone's camera in a strip under it. Someone with their camera off shows as
 *   their initials. The AI's listener is in the room but never on the stage.
 * - **The controls**: microphone, camera (and Flip while it's on), where the sound comes out, captions, who's here,
 *   chat, and Leave, which also offers End for everyone. The screen stays awake while the call is open.
 * - **The AI's notes**: the pill under the title says whether the AI hears the call, and turns its notes off or on
 *   for this call. CC shows the listener's captions, which come only from it.
 * - **On top of the video**, what add-ons show the team: the Sales Coach's newest card (`top`).
 * - **How it ends** is LiveKit's word on why the room let them go (./ends.ts). A dropped connection rejoins on its own
 *   first, and says so meanwhile.
 * - **Not on a phone yet**: sharing its screen, reactions and raising a hand. A hand raised on a computer still shows
 *   as a note.
 * - **A webinar** (a session's call, HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md): the stage shows only who's
 *   presenting, the team and anyone they brought on stage, never the hundreds watching.
 */
import {
  LISTENER_IDENTITY,
  VIDEO_CALL_ATTRIBUTES,
  VIDEO_CALL_CAPTIONS_TOPIC,
  VIDEO_CALL_WORDS as W,
  captionOf,
  isPersonIdentity,
  roomAiOn,
  roomRightsOf,
  type VideoCallCaption,
} from '@hfos/core';
import {
  AudioSession,
  RoomContext,
  VideoTrack,
  isTrackReference,
  registerGlobals,
  useChat,
  useConnectionState,
  useDataChannel,
  useIsMuted,
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useRoomInfo,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/react-native';
import { useKeepAwake } from 'expo-keep-awake';
import type { LucideIcon } from 'lucide-react-native';
import { StatusBar } from 'expo-status-bar';
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalVideoTrack,
  type Participant,
} from 'livekit-client';
import * as React from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Captions,
  CaptionsOff,
  Check,
  FileText,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  SwitchCamera,
  Users,
  Video,
  VideoOff,
  Volume2,
} from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { endOf, type CallEnd } from './ends';
import { AUDIO_OUTPUTS, mediaProblem } from './media';
import {
  actOn,
  askingToJoin,
  endForEveryone,
  setAiNotes,
  useVideoCall,
  type CallChoices,
  type PersonAct,
  type TeamSide,
  type VideoCallGot,
  type VideoCallPerson,
  type VideoTicket,
} from './team-call';

// LiveKit's globals (WebRTC, and what the browser has that React Native doesn't), once, before the first room.
registerGlobals();

export interface CallRoomProps {
  readonly ticket: VideoTicket;
  readonly choices: CallChoices;
  readonly title: string;
  readonly detail: string | null;
  readonly team: TeamSide;
  /** What add-ons show over the top of the video: the Sales Coach's newest card. */
  readonly top?: React.ReactNode;
  readonly onEnd: (end: CallEnd) => void;
}

/** The camera or microphone didn't start: why, and Settings when only it can let the app use them. */
function say(problem: { message: string; settings: boolean }) {
  if (problem.settings)
    toast.show(problem.message, {
      tone: 'danger',
      action: { label: 'Settings', onPress: () => void Linking.openSettings() },
    });
  else toast.error(problem.message);
}

function cameraOf(room: Room): LocalVideoTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as
    LocalVideoTrack | undefined;
}

export default function CallRoom({
  ticket,
  choices,
  title,
  detail,
  team,
  top,
  onEnd,
}: CallRoomProps) {
  const [room] = React.useState(
    () =>
      new Room({
        adaptiveStream: { pixelDensity: 'screen' },
        dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h540.resolution, facingMode: 'user' },
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
  );
  const ending = React.useRef(onEnd);
  ending.current = onEnd;
  const first = React.useRef(choices);
  // Joining and leaving take turns, so a screen drawn twice (as React does while developing) never overlaps them.
  const turns = React.useRef<Promise<void>>(Promise.resolve());
  useKeepAwake();

  React.useEffect(() => {
    let live = true;
    const inTurn = (run: () => Promise<void>) => {
      turns.current = turns.current.then(run).catch(() => undefined);
    };
    const gone = (reason?: DisconnectReason) =>
      ending.current(endOf(reason === undefined ? undefined : DisconnectReason[reason]));
    const failed = (e: Error) =>
      say(mediaProblem(e, /audio|microphone/i.test(e.message) ? 'microphone' : 'camera'));
    room.on(RoomEvent.Disconnected, gone);
    room.on(RoomEvent.MediaDevicesError, failed);
    inTurn(async () => {
      if (!live) return;
      await AudioSession.startAudioSession().catch(() => undefined);
      try {
        await room.connect(ticket.url, ticket.token);
      } catch {
        // Never got in: the screen offers to join again, with a new ticket.
        if (live) ending.current('lost');
        return;
      }
      if (!live) return;
      const want = first.current;
      await room.localParticipant
        .setMicrophoneEnabled(want.mic)
        .catch((e: unknown) => say(mediaProblem(e, 'microphone')));
      await room.localParticipant
        .setCameraEnabled(want.camera)
        .catch((e: unknown) => say(mediaProblem(e, 'camera')));
    });
    return () => {
      live = false;
      room.off(RoomEvent.Disconnected, gone);
      room.off(RoomEvent.MediaDevicesError, failed);
      inTurn(async () => {
        await room.disconnect();
        await AudioSession.stopAudioSession().catch(() => undefined);
      });
    };
  }, [room, ticket.url, ticket.token]);

  return (
    <RoomContext.Provider value={room}>
      <CallScreen
        title={title}
        detail={detail}
        team={team}
        top={top}
        onLeave={() => void room.disconnect()}
      />
    </RoomContext.Provider>
  );
}

type SheetKind = 'people' | 'chat' | 'leave' | 'ai' | 'sound';

/** Inside the room: the stage, the sheets and the controls. */
function CallScreen({
  title,
  detail,
  team,
  top,
  onLeave,
}: {
  title: string;
  detail: string | null;
  team: TeamSide;
  top: React.ReactNode;
  onLeave: () => void;
}) {
  const insets = useSafeAreaInsets();
  const room = useRoomContext();
  const state = useConnectionState();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const { got, reload } = useVideoCall(team.workspaceId, team.callId);
  const heard = roomAiOn(useRoomInfo().metadata);
  // The AI hearing the call: the call's own setting, once read; until then what the listener says in the room.
  const aiNotes = got?.call ? got.call.aiNotes : heard;
  const [sheet, setSheet] = React.useState<SheetKind | null>(null);
  // What the sheet shows while it slides away, so it doesn't empty as it goes.
  const [shown, setShown] = React.useState<SheetKind>('people');
  React.useEffect(() => {
    if (sheet) setShown(sheet);
  }, [sheet]);
  const kind = sheet ?? shown;
  const [cc, setCc] = React.useState(false);
  const captions = useCaptions(cc);
  const [front, setFront] = React.useState(true);
  const [output, setOutput] = React.useState('speaker');
  const [turningAi, setTurningAi] = React.useState(false);

  // Chat that arrives while the chat is closed: a count on its button, and the message in passing.
  const chat = useChat();
  const [seen, setSeen] = React.useState(0);
  const count = chat.chatMessages.length;
  React.useEffect(() => {
    if (sheet === 'chat') {
      setSeen(count);
      return;
    }
    const last = chat.chatMessages[count - 1];
    if (last && count > seen && !last.from?.isLocal)
      toast.show(`${last.from?.name || 'Guest'}: ${last.message}`);
    // Only a new message says anything, not the sheet closing: `seen` and the list are read, not watched.
  }, [count, sheet]);
  const unread = sheet === 'chat' ? 0 : Math.max(0, count - seen);

  // A hand going up on a computer says so here.
  React.useEffect(() => {
    const changed = (attrs: Record<string, string>, p: Participant) => {
      if (p.isLocal || attrs[VIDEO_CALL_ATTRIBUTES.hand] !== 'up') return;
      toast.show(`✋ ${p.name || 'Someone'} raised their hand`);
    };
    room.on(RoomEvent.ParticipantAttributesChanged, changed);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, changed);
    };
  }, [room]);

  // Someone on the call's link asking to come in: who, with Let in right there.
  const told = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!got) return;
    for (const p of got.people) {
      if (p.state !== 'waiting' || p.kind !== 'guest' || told.current.has(p.id)) continue;
      told.current.add(p.id);
      toast.show(W.askingToJoin(p.name), {
        action: { label: W.letIn, onPress: () => setSheet('people') },
      });
    }
  }, [got]);
  const knocking =
    got?.people.filter((p) => p.state === 'waiting' && p.kind === 'guest').length ?? 0;

  const toggleMic = () =>
    void localParticipant
      .setMicrophoneEnabled(!isMicrophoneEnabled)
      .catch((e: unknown) => say(mediaProblem(e, 'microphone')));
  const toggleCamera = () =>
    void localParticipant
      .setCameraEnabled(!isCameraEnabled, { facingMode: front ? 'user' : 'environment' })
      .catch((e: unknown) => say(mediaProblem(e, 'camera')));
  const flip = async () => {
    const camera = cameraOf(room);
    if (!camera) return;
    try {
      await camera.restartTrack({ facingMode: front ? 'environment' : 'user' });
      setFront(!front);
    } catch (e) {
      say(mediaProblem(e, 'camera'));
    }
  };
  // An iPhone has its own picker for where sound goes (speaker, the phone, AirPods); Android gets ours.
  const sound = () => {
    if (Platform.OS === 'ios') void AudioSession.showAudioRoutePicker().catch(() => undefined);
    else setSheet('sound');
  };

  const turnAi = async (on: boolean) => {
    if (turningAi) return;
    setTurningAi(true);
    try {
      await setAiNotes({ workspaceId: team.workspaceId, callId: team.callId, on });
      setSheet(null);
      reload();
      toast.show(on ? W.aiTurnedOn : W.aiTurnedOff);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTurningAi(false);
    }
  };

  const reconnecting =
    state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting;

  return (
    <View className="flex-1 bg-[#0b0e13]" testID="call-room">
      <StatusBar style="light" />
      <View className="flex-row items-start gap-2 px-4 pb-2" style={{ paddingTop: insets.top + 6 }}>
        <View className="min-w-0 flex-1 gap-1.5">
          <Text
            className="text-[16px] font-semibold text-white"
            numberOfLines={1}
            testID="call-title"
          >
            {title}
          </Text>
          <View className="flex-row items-center gap-2">
            {got?.call ? (
              <Pressable
                role="button"
                accessibilityLabel={aiNotes ? W.aiTurnOff : W.aiTurnOn}
                onPress={() => (aiNotes ? setSheet('ai') : void turnAi(true))}
                disabled={turningAi}
                hitSlop={6}
                className={cn(
                  'flex-row items-center gap-1.5 rounded-full px-2.5 py-1',
                  aiNotes ? 'bg-accent-soft' : 'bg-[#2c3139]',
                )}
                testID="call-ai-notes"
              >
                <Icon
                  as={FileText}
                  className={cn('size-[13px]', aiNotes ? 'text-accent-text' : 'text-white/60')}
                />
                <Text
                  className={cn(
                    'text-[12px] font-medium',
                    aiNotes ? 'text-accent-text' : 'text-white/60',
                  )}
                >
                  {aiNotes ? W.aiOn : 'AI notes off'}
                </Text>
              </Pressable>
            ) : null}
            {detail ? (
              <Text className="min-w-0 flex-1 text-[12.5px] text-white/60" numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </View>
        </View>
        {isCameraEnabled ? (
          <Pressable
            role="button"
            accessibilityLabel={front ? 'Use the back camera' : 'Use the front camera'}
            onPress={() => void flip()}
            className="size-10 items-center justify-center rounded-full bg-[#2c3139]"
            testID="call-flip"
          >
            <Icon as={SwitchCamera} className="size-[19px] text-white" />
          </Pressable>
        ) : null}
        <Pressable
          role="button"
          onPress={() => setSheet('leave')}
          className="h-10 flex-row items-center gap-1.5 rounded-full bg-[#c43335] px-3.5"
          testID="call-leave"
        >
          <Icon as={PhoneOff} className="size-4 text-white" />
          <Text className="text-[14px] font-semibold text-white">Leave</Text>
        </Pressable>
      </View>

      <View className="relative min-h-0 flex-1 px-2">
        {state === ConnectionState.Connecting ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-[14px] text-white/70">{W.joining}</Text>
          </View>
        ) : (
          <Stage front={front} />
        )}
        {reconnecting ? (
          <View className="absolute inset-x-0 top-2 items-center" pointerEvents="none">
            <Text
              className="rounded-full bg-warning-soft px-3 py-1 text-[12.5px] text-warning-text"
              role="status"
              testID="call-reconnecting"
            >
              {W.reconnecting}
            </Text>
          </View>
        ) : null}
        {top ? (
          <View
            className="absolute inset-x-3 top-2 max-h-[45%]"
            pointerEvents="box-none"
            testID="call-coach"
          >
            {top}
          </View>
        ) : null}
        {cc ? <CaptionLines lines={captions} aiOn={aiNotes} /> : null}
      </View>

      <View
        className="flex-row justify-around px-2 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        accessibilityLabel="Call controls"
      >
        <Control
          icon={isMicrophoneEnabled ? Mic : MicOff}
          label={isMicrophoneEnabled ? 'Mute' : 'Unmute'}
          a11y={isMicrophoneEnabled ? 'Turn off microphone' : 'Turn on microphone'}
          off={!isMicrophoneEnabled}
          onPress={toggleMic}
          testID="call-mic"
        />
        <Control
          icon={isCameraEnabled ? Video : VideoOff}
          label={isCameraEnabled ? 'Stop video' : 'Start video'}
          a11y={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'}
          off={!isCameraEnabled}
          onPress={toggleCamera}
          testID="call-camera"
        />
        <Control
          icon={Volume2}
          label={Platform.OS === 'ios' ? 'Sound' : (AUDIO_OUTPUTS[output] ?? 'Sound')}
          a11y="Choose where the sound comes out"
          onPress={sound}
          testID="call-sound"
        />
        <Control
          icon={cc ? Captions : CaptionsOff}
          label={W.captions}
          a11y={cc ? W.captionsOff : W.captionsOn}
          active={cc}
          onPress={() => setCc(!cc)}
          testID="call-captions-button"
        />
        <Control
          icon={Users}
          label="People"
          a11y="People"
          badge={knocking}
          onPress={() => setSheet('people')}
          testID="call-people-button"
        />
        <Control
          icon={MessageSquare}
          label="Chat"
          a11y="Chat"
          badge={unread}
          onPress={() => setSheet('chat')}
          testID="call-chat-button"
        />
      </View>

      <CallSheet
        kind={kind}
        open={sheet !== null}
        onClose={() => setSheet(null)}
        team={team}
        got={got}
        reload={reload}
        chat={chat}
        output={output}
        onOutput={setOutput}
        turningAi={turningAi}
        onAiOff={() => void turnAi(false)}
        onLeave={() => {
          setSheet(null);
          onLeave();
        }}
      />
    </View>
  );
}

function Control({
  icon,
  label,
  a11y,
  off,
  active,
  badge,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  a11y: string;
  /** Microphone or camera off: red, as every call app shows it. */
  off?: boolean;
  /** Something they turned on (captions). */
  active?: boolean;
  badge?: number;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected: active ?? (off === undefined ? undefined : !off) }}
      onPress={onPress}
      className="w-[56px] items-center gap-1"
      testID={testID}
    >
      <View
        className={cn(
          'size-12 items-center justify-center rounded-full',
          off ? 'bg-[#c43335]' : active ? 'bg-accent' : 'bg-[#2c3139]',
        )}
      >
        <Icon as={icon} className="size-[21px] text-white" />
        {badge ? (
          <View className="absolute -right-0.5 -top-0.5 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#f0a93b] px-1">
            <Text className="text-[11px] font-semibold text-[#191d25]">{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text className="text-[11px] text-white/80" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Columns for `n` cameras on a phone held upright: one above another, then two, then three side by side. */
const columnsFor = (n: number) => (n <= 2 ? 1 : n <= 6 ? 2 : 3);

const keyOf = (t: TrackReferenceOrPlaceholder) => `${t.participant.identity}:${t.source}`;

/** Everyone on camera: see the file's note on the stage. */
/** On stage in a webinar: the team, and anyone they brought up. */
const presents = (p: Participant) => {
  const r = roomRightsOf(p.attributes);
  return r.kind === 'team' || r.onStage;
};

function Stage({ front }: { front: boolean }) {
  const webinar =
    roomRightsOf(useLocalParticipant().localParticipant.attributes).format === 'webinar';
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  ).filter((t) => isPersonIdentity(t.participant.identity));
  const cameras = tracks.filter(
    (t) => t.source === Track.Source.Camera && (!webinar || presents(t.participant)),
  );
  const mine = cameras.find((t) => t.participant.isLocal) ?? null;
  const others = cameras.filter((t) => !t.participant.isLocal);
  const screens = tracks.filter(
    (t) => t.source === Track.Source.ScreenShare && isTrackReference(t),
  );

  if (screens.length)
    return (
      <View className="flex-1 gap-2 py-2" testID="call-stage">
        <View className="min-h-0 flex-1">
          <Tile trackRef={screens[0]!} />
        </View>
        <ScrollView
          horizontal
          className="max-h-[104px] flex-none"
          contentContainerClassName="gap-2"
        >
          {[...screens.slice(1), ...others, ...(mine ? [mine] : [])].map((t) => (
            <View key={keyOf(t)} className="h-[104px] w-[150px]">
              <Tile trackRef={t} small mirror={t.participant.isLocal && front} zOrder={1} />
            </View>
          ))}
        </ScrollView>
      </View>
    );

  const cols = columnsFor(others.length);
  const rows: TrackReferenceOrPlaceholder[][] = [];
  for (let i = 0; i < others.length; i += cols) rows.push(others.slice(i, i + cols));
  return (
    <View className="flex-1 py-2" testID="call-stage">
      {others.length === 0 ? (
        // Nobody else yet: themselves, full size.
        mine ? (
          <Tile trackRef={mine} mirror={front} />
        ) : null
      ) : (
        <View className="flex-1 gap-2">
          {rows.map((row, r) => (
            <View key={r} className="min-h-0 flex-1 flex-row gap-2">
              {row.map((t) => (
                <Tile key={keyOf(t)} trackRef={t} />
              ))}
              {/* A short last row keeps its tiles the size of the rest. */}
              {Array.from({ length: cols - row.length }, (_, i) => (
                <View key={`gap-${i}`} className="flex-1" />
              ))}
            </View>
          ))}
        </View>
      )}
      {others.length && mine ? (
        <View
          className="absolute bottom-4 right-2 h-[136px] w-[96px] overflow-hidden rounded-[12px] border border-white/20"
          testID="call-self"
        >
          <Tile trackRef={mine} small mirror={front} zOrder={1} />
        </View>
      ) : null}
      {others.length === 0 ? (
        <View className="absolute inset-x-0 top-4 items-center" pointerEvents="none">
          <Text
            className="rounded-full bg-black/55 px-3 py-1.5 text-[13px] text-white"
            testID="call-alone"
          >
            {W.aloneTeam}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Tile({
  trackRef,
  small = false,
  mirror = false,
  zOrder = 0,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  /** In the corner or the strip: no name on it, a smaller face. */
  small?: boolean;
  mirror?: boolean;
  /** Android draws video in layers of its own: the one in the corner goes over the rest. */
  zOrder?: number;
}) {
  const p = trackRef.participant;
  const name = p.name || 'Guest';
  const screen = trackRef.source === Track.Source.ScreenShare;
  const speaking = useIsSpeaking(p);
  const micOff = useIsMuted({ participant: p, source: Track.Source.Microphone });
  const videoOff = useIsMuted(trackRef);
  const video = isTrackReference(trackRef) && !videoOff;
  const label = screen ? `${name}’s screen` : p.isLocal ? `${name} (you)` : name;
  return (
    <View
      className={cn(
        'min-h-0 flex-1 overflow-hidden rounded-[14px] border-2 bg-[#20252e]',
        speaking && !screen && !small ? 'border-[#3ccf7a]' : 'border-transparent',
      )}
      accessibilityLabel={label}
      testID={screen ? 'call-screen' : 'call-tile'}
    >
      {video ? (
        <VideoTrack
          trackRef={trackRef}
          style={StyleSheet.absoluteFill}
          objectFit={screen ? 'contain' : 'cover'}
          mirror={mirror && !screen}
          zOrder={zOrder}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Avatar name={name} seed={p.identity} size={small ? 'lg' : 'xl'} />
        </View>
      )}
      {small ? null : (
        <View className="absolute bottom-2 left-2 max-w-[90%] flex-row items-center gap-1 rounded-full bg-black/55 px-2 py-0.5">
          {micOff && !screen ? (
            <Icon as={MicOff} className="size-3 text-white" accessibilityLabel="Microphone off" />
          ) : null}
          <Text className="text-[12px] text-white" numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </View>
  );
}

/** A caption on screen: when it last changed, so finished ones can go after a moment. */
type ShownCaption = VideoCallCaption & { readonly at: number };

/** How long a finished caption stays, and one still being heard that stopped changing (as the web's). */
const CAPTION_STAYS_MS = 6_000;
const CAPTION_STALE_MS = 10_000;

/**
 * The listener's captions, while CC is on: the newest few, each replaced as its words firm up. The listener is
 * unseen, so its messages come from nobody in the room; one from someone in the room isn't a caption.
 */
function useCaptions(on: boolean): readonly ShownCaption[] {
  const [lines, setLines] = React.useState<ShownCaption[]>([]);
  const want = React.useRef(on);
  want.current = on;
  useDataChannel(VIDEO_CALL_CAPTIONS_TOPIC, (msg) => {
    if (!want.current || (msg.from && msg.from.identity !== LISTENER_IDENTITY)) return;
    const c = captionOf(msg.payload);
    if (!c) return;
    setLines((now) => [...now.filter((x) => x.id !== c.id), { ...c, at: Date.now() }].slice(-3));
  });
  React.useEffect(() => {
    if (!on) {
      setLines([]);
      return;
    }
    const t = setInterval(() => {
      const now = Date.now();
      setLines((list) => {
        const keep = list.filter(
          (x) => now - x.at < (x.final ? CAPTION_STAYS_MS : CAPTION_STALE_MS),
        );
        return keep.length === list.length ? list : keep;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [on]);
  return lines;
}

function CaptionLines({ lines, aiOn }: { lines: readonly ShownCaption[]; aiOn: boolean }) {
  return (
    <View
      className="absolute inset-x-0 bottom-3 items-start gap-1 pl-4 pr-[116px]"
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      testID="call-captions"
    >
      {lines.length ? (
        lines.map((l) => (
          <Text
            key={l.id}
            className="rounded-md bg-black/75 px-3 py-1.5 text-[15px] leading-[21px] text-white"
          >
            <Text className="font-medium text-white/70">{l.name}: </Text>
            {l.text}
          </Text>
        ))
      ) : aiOn ? null : (
        <Text className="rounded-md bg-black/75 px-3 py-1.5 text-[13px] text-white/85">
          {W.captionsNeedAi}
        </Text>
      )}
    </View>
  );
}

type Chat = ReturnType<typeof useChat>;

/**
 * The call's one sheet: who's here, the chat, Leave, turning the AI's notes off, or where the sound goes. One sheet
 * whose insides change, since an iPhone shows only one at a time and a note's Let in can open People over another.
 */
function CallSheet({
  kind,
  open,
  onClose,
  team,
  got,
  reload,
  chat,
  output,
  onOutput,
  turningAi,
  onAiOff,
  onLeave,
}: {
  kind: SheetKind;
  open: boolean;
  onClose: () => void;
  team: TeamSide;
  got: VideoCallGot | null;
  reload: () => void;
  chat: Chat;
  output: string;
  onOutput: (output: string) => void;
  turningAi: boolean;
  onAiOff: () => void;
  onLeave: () => void;
}) {
  const [confirmEnd, setConfirmEnd] = React.useState(false);
  React.useEffect(() => {
    if (!open) setConfirmEnd(false);
  }, [open]);
  const title =
    kind === 'people'
      ? 'People'
      : kind === 'chat'
        ? 'Chat'
        : kind === 'ai'
          ? `${W.aiTurnOff}?`
          : kind === 'sound'
            ? 'Sound'
            : confirmEnd
              ? W.endForEveryoneConfirm
              : undefined;
  const description =
    kind === 'ai'
      ? W.aiOffConfirm
      : kind === 'leave' && confirmEnd
        ? W.endForEveryoneHow
        : undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      scroll={kind === 'people'}
      testID={`call-${kind}`}
    >
      {kind === 'people' ? (
        <PeopleList team={team} got={got} reload={reload} />
      ) : kind === 'chat' ? (
        <ChatList chat={chat} />
      ) : kind === 'ai' ? (
        <View className="gap-2 pt-2">
          <Button
            variant="danger"
            loading={turningAi}
            onPress={onAiOff}
            testID="call-ai-notes-off-confirm"
          >
            Turn off AI notes
          </Button>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
        </View>
      ) : kind === 'sound' ? (
        <SoundOutputs open={open} output={output} onOutput={onOutput} onDone={onClose} />
      ) : confirmEnd ? (
        <EndForEveryone team={team} onCancel={() => setConfirmEnd(false)} />
      ) : (
        <View className="gap-2 pt-2">
          <Button variant="secondary" onPress={onLeave} testID="call-leave-only">
            {W.leaveOnly}
          </Button>
          <Button
            variant="dangerOutline"
            onPress={() => setConfirmEnd(true)}
            testID="call-end-for-everyone"
          >
            {W.endForEveryone}
          </Button>
        </View>
      )}
    </Sheet>
  );
}

function EndForEveryone({ team, onCancel }: { team: TeamSide; onCancel: () => void }) {
  const [ending, setEnding] = React.useState(false);
  // Once the call ends, the room says so and the screen moves on: nothing to do here after.
  const end = async () => {
    if (ending) return;
    setEnding(true);
    try {
      await endForEveryone({ workspaceId: team.workspaceId, callId: team.callId });
    } catch (e) {
      toast.error(errorMessage(e));
      setEnding(false);
    }
  };
  return (
    <View className="gap-2 pt-2">
      <Button
        variant="danger"
        loading={ending}
        onPress={() => void end()}
        testID="call-end-confirm"
      >
        {W.endForEveryone}
      </Button>
      <Button variant="ghost" onPress={onCancel}>
        Cancel
      </Button>
    </View>
  );
}

/** Android's outputs, as the phone has them now: a headset or Bluetooth only while one is connected. */
function SoundOutputs({
  open,
  output,
  onOutput,
  onDone,
}: {
  open: boolean;
  output: string;
  onOutput: (output: string) => void;
  onDone: () => void;
}) {
  const [outputs, setOutputs] = React.useState<string[]>(['speaker', 'earpiece']);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    void AudioSession.getAudioOutputs()
      .then((found) => {
        const known = found.filter((o) => AUDIO_OUTPUTS[o]);
        if (live && known.length) setOutputs(known);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);
  const pick = async (o: string) => {
    try {
      await AudioSession.selectAudioOutput(o);
      onOutput(o);
      onDone();
    } catch {
      toast.error('The sound didn’t move. Try again in a moment.');
    }
  };
  return (
    <View className="pt-1">
      {outputs.map((o) => (
        <Pressable
          key={o}
          role="button"
          accessibilityState={{ selected: o === output }}
          onPress={() => void pick(o)}
          className="min-h-12 flex-row items-center justify-between border-b border-border py-3"
          testID={`call-sound-${o}`}
        >
          <Text className="text-[16px]">{AUDIO_OUTPUTS[o]}</Text>
          {o === output ? <Icon as={Check} className="size-5 text-accent-text" /> : null}
        </Pressable>
      ))}
    </View>
  );
}

const KIND_LABEL: Record<VideoCallPerson['kind'], string> = W.kinds;

/** Who's asking to come in (Let in, Turn away) and who's in the call (Mute, Remove), as the web's People panel. */
function PeopleList({
  team,
  got,
  reload,
}: {
  team: TeamSide;
  got: VideoCallGot | null;
  reload: () => void;
}) {
  const inRoom = useParticipants().filter((p) => isPersonIdentity(p.identity));
  const rows = new Map((got?.people ?? []).map((p) => [p.id, p]));
  const asking = askingToJoin(got?.people ?? [], new Set(inRoom.map((p) => p.identity)));
  const [busy, setBusy] = React.useState<string | null>(null);
  const act = async (what: PersonAct, personId: string) => {
    if (busy) return;
    setBusy(`${what}:${personId}`);
    try {
      await actOn(what, { workspaceId: team.workspaceId, callId: team.callId, personId });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <View className="gap-4 pt-1" testID="call-people-list">
      {asking.length ? (
        <View testID="call-asking">
          <Text className="mb-1 text-[12px] font-medium uppercase tracking-wide text-text-3">
            Asking to join
          </Text>
          {asking.map((p) => (
            <View
              key={p.id}
              className="flex-row items-center gap-2.5 py-2"
              testID={`call-asking-${p.id}`}
            >
              <Avatar name={p.name} seed={p.id} size="md" />
              <View className="min-w-0 flex-1">
                <Text className="text-[15px]" numberOfLines={1}>
                  {p.name}
                </Text>
                <Text className="text-[12.5px] text-text-3">
                  {p.state === 'admitted'
                    ? 'Let in, joining now'
                    : p.kind === 'customer'
                      ? 'On their own link, coming in now'
                      : KIND_LABEL[p.kind]}
                </Text>
              </View>
              {p.state === 'waiting' && p.kind === 'guest' ? (
                <>
                  <Button
                    size="sm"
                    loading={busy === `admit:${p.id}`}
                    onPress={() => void act('admit', p.id)}
                    testID="call-let-in"
                  >
                    {W.letIn}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === `turn_away:${p.id}`}
                    onPress={() => void act('turn_away', p.id)}
                  >
                    {W.turnAway}
                  </Button>
                </>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <View testID="call-in">
        <Text className="mb-1 text-[12px] font-medium uppercase tracking-wide text-text-3">
          In the call ({inRoom.length})
        </Text>
        {inRoom.map((p) => (
          <InCall
            key={p.identity}
            participant={p}
            row={rows.get(p.identity) ?? null}
            busy={busy}
            onAct={(what) => void act(what, p.identity)}
          />
        ))}
      </View>
    </View>
  );
}

function InCall({
  participant: p,
  row,
  busy,
  onAct,
}: {
  participant: Participant;
  row: VideoCallPerson | null;
  busy: string | null;
  onAct: (what: 'mute' | 'remove') => void;
}) {
  const micOff = useIsMuted({ participant: p, source: Track.Source.Microphone });
  const name = p.name || row?.name || 'Guest';
  return (
    <View className="flex-row items-center gap-2.5 py-2" testID="call-person">
      <Avatar name={name} seed={p.identity} size="md" />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px]" numberOfLines={1}>
          {p.isLocal ? `${name} (you)` : name}
        </Text>
        {row ? <Text className="text-[12.5px] text-text-3">{KIND_LABEL[row.kind]}</Text> : null}
      </View>
      {micOff ? (
        <Icon as={MicOff} className="size-4 text-text-3" accessibilityLabel="Microphone off" />
      ) : null}
      {!p.isLocal ? (
        <>
          {!micOff ? (
            <Button
              variant="ghost"
              size="sm"
              loading={busy === `mute:${p.identity}`}
              onPress={() => onAct('mute')}
            >
              {W.mute}
            </Button>
          ) : null}
          <Button
            variant="ghostDanger"
            size="sm"
            loading={busy === `remove:${p.identity}`}
            onPress={() => onAct('remove')}
          >
            {W.remove}
          </Button>
        </>
      ) : null}
    </View>
  );
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The call's chat: seen by everyone in it, and gone with it. */
function ChatList({ chat }: { chat: Chat }) {
  const [text, setText] = React.useState('');
  const list = React.useRef<ScrollView>(null);
  const keyboard = useKeyboardHeight();
  const count = chat.chatMessages.length;
  React.useEffect(() => {
    setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
  }, [count]);
  const send = async () => {
    const said = text.trim();
    if (!said || chat.isSending) return;
    try {
      await chat.send(said);
      setText('');
    } catch {
      toast.error('Your message didn’t send. Try again in a moment.');
    }
  };
  return (
    <View className="gap-3 pt-1">
      <ScrollView ref={list} className="max-h-[320px]" contentContainerClassName="gap-3">
        {count === 0 ? (
          <Text className="text-[13.5px] text-text-3">
            Messages here are seen by everyone in the call, and aren’t kept after it.
          </Text>
        ) : null}
        {chat.chatMessages.map((m) => (
          <View key={m.id} className="gap-0.5" testID="call-chat-message">
            <Text className="text-[12px] text-text-3">
              <Text className="text-[12px] font-medium text-text-2">
                {m.from?.isLocal ? 'You' : m.from?.name || 'Guest'}
              </Text>{' '}
              · {clock(m.timestamp)}
            </Text>
            <Text className="text-[15px]">{m.message}</Text>
          </View>
        ))}
      </ScrollView>
      <View className="flex-row items-end gap-2">
        <Input
          className="max-h-28 min-w-0 flex-1"
          value={text}
          onChangeText={setText}
          placeholder="Send a message to everyone"
          aria-label="Message"
          maxLength={1000}
          multiline
          testID="call-chat-input"
        />
        <Button
          size="md"
          icon={Send}
          accessibilityLabel="Send"
          loading={chat.isSending}
          disabled={!text.trim()}
          onPress={() => void send()}
          testID="call-chat-send"
        />
      </View>
      {keyboard ? <View style={{ height: keyboard }} /> : null}
    </View>
  );
}
