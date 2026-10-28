'use client';
/**
 * A HandsFreeOS video call in progress (docs/video-calls.md): LiveKit's room, joined on the ticket the worker signed.
 * The same screen for the team, a customer and anyone let in; the team's has their buttons on people too.
 *
 * - **The controls**: microphone, camera, screen share (from a computer: phones' browsers can't share), background
 *   blur where the browser can, reactions, raise hand, chat, who's here, and Leave. The team's Leave also offers
 *   End for everyone.
 * - **Reactions and chat aren't kept.** Reactions travel on their own data topic, one emoji at a time; chat is
 *   LiveKit's, and goes with the call.
 * - **A raised hand** is an attribute of the person in the room, so someone who comes in later sees it too.
 * - **The AI's notes** (part 2): "AI notes on" shows while the AI's unseen listener hears the call (the room's
 *   metadata says so). The team's pill also turns them off or on for this call. CC shows the listener's captions,
 *   which come only from it: anyone else's message on that topic is ignored.
 * - **How it ends** is LiveKit's word on why the room let them go: they left, the team took them out, the call was
 *   ended for everyone, or they joined again somewhere else. A dropped connection rejoins on its own first.
 * - **The stand-in** (`fake:` tickets, on laptops and in tests without LiveKit) has no video to carry, so the screen
 *   says so; the team's panel still works, from the API.
 */
import {
  LISTENER_IDENTITY,
  VIDEO_CALL_ATTRIBUTES,
  VIDEO_CALL_CAPTIONS_TOPIC,
  VIDEO_CALL_REACTIONS,
  VIDEO_CALL_REACTIONS_TOPIC,
  VIDEO_CALL_WORDS,
  captionOf,
  isPersonIdentity,
  roomAiOn,
  type VideoCallCaption,
} from '@hfos/core';
import {
  RoomAudioRenderer,
  RoomContext,
  useChat,
  useConnectionState,
  useDataChannel,
  useLocalParticipant,
  useParticipantAttribute,
  useParticipants,
  useRoomContext,
  useRoomInfo,
  useSequentialRoomConnectDisconnect,
  useStartAudio,
} from '@livekit/components-react';
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Participant,
} from 'livekit-client';
import {
  Captions,
  CaptionsOff,
  ChevronDown,
  FileText,
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  SmilePlus,
  Sparkles,
  Users,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { BrandMark } from '@/components/ui/brand';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { VideoTicket } from '@/lib/api/public-booking';
import { errorMessage } from '@/lib/api/errors';
import { brandLook } from '@/lib/look';
import { cn } from '@/lib/utils';
import { canBlur, setBlur } from './blur';
import { ChatPanel, PeoplePanel } from './call-panels';
import { CallStage } from './call-stage';
import { mediaProblem } from './pre-join';
import { actOn, endForEveryone, setAiNotes, useVideoCall } from './team-call';
import type { CallEnd, CallHeading, DeviceChoices, TeamSide } from './types';

/** The stand-in's tickets (apps/worker/src/video-calls/fake.ts): nothing to connect to. */
export const STAND_IN_URL = 'fake:';

export interface CallRoomProps {
  readonly ticket: VideoTicket;
  readonly choices: DeviceChoices;
  readonly heading: CallHeading;
  /** The business's colour, on the pages its customers see; null for the team's own. */
  readonly color?: string | null;
  /** The team's side; null for a customer or a guest. */
  readonly team?: TeamSide | null;
  /** For the team: what add-ons show beside the video (the Sales Coach's cards, ./call-coach.tsx). */
  readonly coach?: ReactNode;
  readonly onEnd: (why: CallEnd) => void;
}

export function CallRoom(props: CallRoomProps) {
  return props.ticket.url === STAND_IN_URL ? <StandIn {...props} /> : <LiveRoom {...props} />;
}

function endOf(reason: DisconnectReason | undefined): CallEnd {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return 'left';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'removed';
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return 'ended';
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'elsewhere';
    default:
      return 'lost';
  }
}

/** Phones' browsers can't share a screen; computers' can. */
const canShareScreen = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

function cameraOf(room: Room): LocalVideoTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as
    LocalVideoTrack | undefined;
}

function LiveRoom({ ticket, choices, heading, color, team, coach, onEnd }: CallRoomProps) {
  const [room] = useState(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: VideoPresets.h720.resolution,
          ...(choices.videoDeviceId ? { deviceId: choices.videoDeviceId } : {}),
        },
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(choices.audioDeviceId ? { deviceId: choices.audioDeviceId } : {}),
        },
      }),
  );
  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);
  const ending = useRef(onEnd);
  ending.current = onEnd;
  const first = useRef(choices);
  const [blur, setBlurOn] = useState(choices.blur);
  const blurWanted = useRef(choices.blur);
  blurWanted.current = blur;

  useEffect(() => {
    const gone = (reason?: DisconnectReason) => ending.current(endOf(reason));
    const failed = (e: Error) => {
      const kind = /audio|microphone/i.test(e.message) ? 'microphone' : 'camera';
      toast.error(mediaProblem(e, kind));
    };
    // A camera that starts later (turned on in the call) gets the blur they asked for.
    const published = (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.Camera && blurWanted.current && pub.track)
        void setBlur(pub.track as LocalVideoTrack, true).catch(() => undefined);
    };
    room.on(RoomEvent.Disconnected, gone);
    room.on(RoomEvent.MediaDevicesError, failed);
    room.on(RoomEvent.LocalTrackPublished, published);
    let live = true;
    connect(ticket.url, ticket.token)
      .then(async () => {
        if (!live) return;
        const want = first.current;
        await room.localParticipant
          .setMicrophoneEnabled(want.mic)
          .catch((e: unknown) => toast.error(mediaProblem(e, 'microphone')));
        await room.localParticipant
          .setCameraEnabled(want.camera)
          .catch((e: unknown) => toast.error(mediaProblem(e, 'camera')));
      })
      .catch(() => {
        // Never got in: the page offers to join again, with a new ticket.
        if (live) ending.current('lost');
      });
    return () => {
      live = false;
      room.off(RoomEvent.Disconnected, gone);
      room.off(RoomEvent.MediaDevicesError, failed);
      room.off(RoomEvent.LocalTrackPublished, published);
      void disconnect();
    };
  }, [room, connect, disconnect, ticket.url, ticket.token]);

  const toggleBlur = useCallback(
    async (on: boolean) => {
      setBlurOn(on);
      const cam = cameraOf(room);
      if (!cam) return;
      try {
        await setBlur(cam, on);
      } catch {
        setBlurOn(false);
        toast.error('Your browser couldn’t blur your background.');
      }
    },
    [room],
  );

  return (
    <RoomContext.Provider value={room}>
      <CallScreen
        heading={heading}
        color={color}
        team={team ?? null}
        coach={team ? coach : null}
        blur={blur}
        onBlur={(on) => void toggleBlur(on)}
        onLeave={() => void room.disconnect()}
      />
      <RoomAudioRenderer />
    </RoomContext.Provider>
  );
}

interface Floating {
  readonly id: number;
  readonly emoji: string;
  readonly from: string;
}

/** Inside the room: the stage, the panels and the controls. */
function CallScreen({
  heading,
  color,
  team,
  coach,
  blur,
  onBlur,
  onLeave,
}: {
  heading: CallHeading;
  color?: string | null | undefined;
  team: TeamSide | null;
  coach: ReactNode;
  blur: boolean;
  onBlur: (on: boolean) => void;
  onLeave: () => void;
}) {
  const state = useConnectionState();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();
  const people = useParticipants().filter((p) => isPersonIdentity(p.identity));
  const [panel, setPanel] = useState<'chat' | 'people' | null>(null);
  const chat = useChat();
  const [seen, setSeen] = useState(0);
  const [floating, setFloating] = useState<Floating[]>([]);
  const [blurs, setBlurs] = useState(false);
  const [sharing, setSharing] = useState(false);
  const hand = useParticipantAttribute(VIDEO_CALL_ATTRIBUTES.hand, {
    participant: localParticipant,
  });
  const { got, reload } = useVideoCall(team?.workspaceId ?? '', team?.callId ?? '', !!team);
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // The AI hearing the call: the listener says so in the room; the team also knows the call's own setting.
  const aiHeard = roomAiOn(useRoomInfo().metadata);
  const aiNotes = team && got?.call ? got.call.aiNotes : aiHeard;
  const [cc, setCc] = useState(false);
  const captions = useCaptions(cc);
  const [confirmAiOff, setConfirmAiOff] = useState(false);
  const [turningAi, setTurningAi] = useState(false);

  useEffect(() => {
    void canBlur().then(setBlurs);
  }, []);

  // Chat that arrives while the chat is closed: a count on its button, and the message in passing.
  const count = chat.chatMessages.length;
  useEffect(() => {
    if (panel === 'chat') {
      setSeen(count);
      return;
    }
    const last = chat.chatMessages[count - 1];
    if (last && count > seen && !last.from?.isLocal)
      toast(`${last.from?.name || 'Guest'}: ${last.message}`, { duration: 4000 });
    // Only a new message says anything, not the panel closing: `seen` and the list are read, not watched.
  }, [count, panel]);
  const unread = panel === 'chat' ? 0 : Math.max(0, count - seen);

  const float = useCallback((emoji: string, from: string) => {
    const id = Date.now() + Math.random();
    setFloating((f) => [...f.slice(-11), { id, emoji, from }]);
    setTimeout(() => setFloating((f) => f.filter((x) => x.id !== id)), 4000);
  }, []);
  const { send: sendData } = useDataChannel(VIDEO_CALL_REACTIONS_TOPIC, (msg) => {
    const emoji = new TextDecoder().decode(msg.payload);
    if ((VIDEO_CALL_REACTIONS as readonly string[]).includes(emoji))
      float(emoji, msg.from?.name || 'Guest');
  });
  const react = (emoji: string) => {
    float(emoji, 'You');
    void sendData(new TextEncoder().encode(emoji), { reliable: true }).catch(() => undefined);
  };

  // A hand going up says so, for whoever isn't looking at that tile.
  useHandsUp();

  // Someone asking to come in, for the team: who, with Let in right there.
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!team || !got) return;
    for (const p of got.people) {
      if (p.state !== 'waiting' || p.kind !== 'guest' || told.current.has(p.id)) continue;
      told.current.add(p.id);
      toast(VIDEO_CALL_WORDS.askingToJoin(p.name), {
        duration: 10_000,
        action: {
          label: VIDEO_CALL_WORDS.letIn,
          onClick: () => setPanel('people'),
        },
      });
    }
  }, [got, team]);
  const asking = got?.people.filter((p) => p.state === 'waiting' && p.kind === 'guest').length ?? 0;

  const toggleMic = () =>
    void localParticipant
      .setMicrophoneEnabled(!isMicrophoneEnabled)
      .catch((e: unknown) => toast.error(mediaProblem(e, 'microphone')));
  const toggleCamera = () =>
    void localParticipant
      .setCameraEnabled(!isCameraEnabled)
      .catch((e: unknown) => toast.error(mediaProblem(e, 'camera')));
  const toggleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: false });
    } catch (e) {
      // Pressing Cancel in the browser's picker is no trouble.
      if (!(e instanceof Error && e.name === 'NotAllowedError'))
        toast.error('Your screen didn’t share. Try again, or pick a window instead.');
    } finally {
      setSharing(false);
    }
  };
  const toggleHand = () =>
    void localParticipant
      .setAttributes({ [VIDEO_CALL_ATTRIBUTES.hand]: hand === 'up' ? '' : 'up' })
      .catch(() => toast.error('Your hand didn’t go up. Try again in a moment.'));

  const end = async () => {
    if (!team || ending) return;
    setEnding(true);
    try {
      await endForEveryone({ workspaceId: team.workspaceId, callId: team.callId });
      setConfirmEnd(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setEnding(false);
    }
  };

  const turnAi = async (on: boolean) => {
    if (!team || turningAi) return;
    setTurningAi(true);
    try {
      await setAiNotes({ workspaceId: team.workspaceId, callId: team.callId, on });
      setConfirmAiOff(false);
      reload();
      toast(on ? VIDEO_CALL_WORDS.aiTurnedOn : VIDEO_CALL_WORDS.aiTurnedOff);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTurningAi(false);
    }
  };

  const look = brandLook(color);
  const title = team && got?.appointment ? got.appointment.title : heading.title;
  const detail =
    team && got?.appointment
      ? got.appointment.customers.map((c) => c.name).join(', ') || null
      : (heading.detail ?? null);

  return (
    <div data-theme="dark" className="fixed inset-0 z-40 bg-[#0b0e13] text-text">
      <div
        className={cn('flex h-full flex-col', look.className)}
        style={look.style as CSSProperties | undefined}
        data-testid="call-room"
      >
        <header className="flex items-center gap-3 px-4 py-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-medium" data-testid="call-title">
              {title}
            </span>
            {detail ? <span className="truncate text-[12px] text-text-3">{detail}</span> : null}
          </span>
          {team && got?.call ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(aiPillClass(aiNotes), 'hover:brightness-110')}
                  data-testid="call-ai-notes"
                >
                  <FileText size={13} aria-hidden />
                  {aiNotes ? VIDEO_CALL_WORDS.aiOn : 'AI notes off'}
                  <ChevronDown size={13} aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" data-theme="dark">
                {aiNotes ? (
                  <DropdownMenuItem
                    onSelect={() => setConfirmAiOff(true)}
                    data-testid="call-ai-notes-off"
                  >
                    {VIDEO_CALL_WORDS.aiTurnOff}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onSelect={() => void turnAi(true)}
                    data-testid="call-ai-notes-on"
                  >
                    {VIDEO_CALL_WORDS.aiTurnOn}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : aiNotes ? (
            <span className={aiPillClass(true)} data-testid="call-ai-notes">
              <FileText size={13} aria-hidden />
              {VIDEO_CALL_WORDS.aiOn}
            </span>
          ) : null}
          {team ? null : (
            <span className="flex flex-none items-center gap-1 text-[11.5px] text-text-3">
              <BrandMark size={12} />
              {VIDEO_CALL_WORDS.poweredBy}
            </span>
          )}
        </header>
        {state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting ? (
          <p
            className="mx-auto mb-1 rounded-full bg-warning-soft px-3 py-1 text-[12.5px] text-warning-text"
            role="status"
            data-testid="call-reconnecting"
          >
            {VIDEO_CALL_WORDS.reconnecting}
          </p>
        ) : null}
        <div className="relative flex min-h-0 flex-1 gap-2 px-2">
          <div className="relative min-h-0 min-w-0 flex-1">
            {state === ConnectionState.Connecting ? (
              <div className="flex h-full items-center justify-center text-[13px] text-text-2">
                {VIDEO_CALL_WORDS.joining}
              </div>
            ) : (
              <CallStage alone={team ? VIDEO_CALL_WORDS.aloneTeam : VIDEO_CALL_WORDS.aloneOthers} />
            )}
            <Reactions floating={floating} />
            {cc ? <CaptionLines lines={captions} aiOn={aiNotes} /> : null}
          </div>
          {panel === 'chat' ? (
            <ChatPanel
              messages={chat.chatMessages}
              send={chat.send}
              sending={chat.isSending}
              onClose={() => setPanel(null)}
            />
          ) : panel === 'people' ? (
            <PeoplePanel team={team} got={got} reload={reload} onClose={() => setPanel(null)} />
          ) : coach ? (
            // The coach's cards beside the video, or over its top on a phone; nothing while there are none.
            <div
              className="absolute inset-x-2 top-2 z-10 max-h-[45%] overflow-y-auto empty:hidden md:static md:max-h-none md:w-[340px] md:flex-none"
              data-testid="call-coach"
            >
              {coach}
            </div>
          ) : null}
        </div>
        <StartAudioPrompt />
        <nav
          className="flex flex-none items-center justify-center gap-1.5 overflow-x-auto px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:gap-2"
          aria-label="Call controls"
        >
          <Control
            label={isMicrophoneEnabled ? 'Turn off microphone' : 'Turn on microphone'}
            off={!isMicrophoneEnabled}
            onClick={toggleMic}
            testId="call-mic"
          >
            {isMicrophoneEnabled ? <Mic size={19} /> : <MicOff size={19} />}
          </Control>
          <Control
            label={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'}
            off={!isCameraEnabled}
            onClick={toggleCamera}
            testId="call-camera"
          >
            {isCameraEnabled ? <Video size={19} /> : <VideoOff size={19} />}
          </Control>
          {canShareScreen() ? (
            <Control
              label={isScreenShareEnabled ? 'Stop sharing your screen' : 'Share your screen'}
              active={isScreenShareEnabled}
              onClick={() => void toggleShare()}
              testId="call-share"
            >
              <MonitorUp size={19} />
            </Control>
          ) : null}
          {blurs && isCameraEnabled ? (
            <Control
              label={blur ? 'Stop blurring your background' : 'Blur your background'}
              active={blur}
              onClick={() => onBlur(!blur)}
              testId="call-blur"
            >
              <Sparkles size={19} />
            </Control>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Send a reaction"
                title="Send a reaction"
                className={controlClass()}
                data-testid="call-react"
              >
                <SmilePlus size={19} />
              </button>
            </DropdownMenuTrigger>
            {/* Menus open outside the call's dark frame, so each says dark itself. */}
            <DropdownMenuContent
              align="center"
              side="top"
              className="flex min-w-0 gap-1 p-1.5"
              data-theme="dark"
            >
              {VIDEO_CALL_REACTIONS.map((emoji) => (
                <DropdownMenuItem
                  key={emoji}
                  className="h-10 w-10 justify-center px-0 text-[22px]"
                  aria-label={`React with ${emoji}`}
                  onSelect={() => react(emoji)}
                >
                  {emoji}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Control
            label={hand === 'up' ? 'Lower your hand' : 'Raise your hand'}
            active={hand === 'up'}
            onClick={toggleHand}
            testId="call-raise-hand"
          >
            <Hand size={19} />
          </Control>
          <Control
            label={cc ? VIDEO_CALL_WORDS.captionsOff : VIDEO_CALL_WORDS.captionsOn}
            active={cc}
            onClick={() => setCc(!cc)}
            testId="call-captions-button"
          >
            {cc ? <Captions size={19} /> : <CaptionsOff size={19} />}
          </Control>
          <Control
            label="People"
            active={panel === 'people'}
            badge={team ? asking : people.length}
            badgeTone={team && asking ? 'warning' : 'plain'}
            onClick={() => setPanel(panel === 'people' ? null : 'people')}
            testId="call-people-button"
          >
            <Users size={19} />
          </Control>
          <Control
            label="Chat"
            active={panel === 'chat'}
            badge={unread}
            badgeTone="warning"
            onClick={() => setPanel(panel === 'chat' ? null : 'chat')}
            testId="call-chat-button"
          >
            <MessageSquare size={19} />
          </Control>
          {team ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-11 flex-none items-center gap-2 rounded-full bg-[#c43335] px-4 text-[14px] font-medium text-white hover:brightness-95"
                  data-testid="call-leave"
                >
                  <PhoneOff size={18} />
                  Leave
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" data-theme="dark">
                <DropdownMenuItem onSelect={onLeave} data-testid="call-leave-only">
                  {VIDEO_CALL_WORDS.leaveOnly}
                </DropdownMenuItem>
                <DropdownMenuItem
                  danger
                  onSelect={() => setConfirmEnd(true)}
                  data-testid="call-end-for-everyone"
                >
                  {VIDEO_CALL_WORDS.endForEveryone}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <button
              type="button"
              onClick={onLeave}
              className="inline-flex h-11 flex-none items-center gap-2 rounded-full bg-[#c43335] px-4 text-[14px] font-medium text-white hover:brightness-95"
              data-testid="call-leave"
            >
              <PhoneOff size={18} />
              Leave
            </button>
          )}
        </nav>
      </div>
      <Dialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <DialogContent
          title={VIDEO_CALL_WORDS.endForEveryoneConfirm}
          description={VIDEO_CALL_WORDS.endForEveryoneHow}
        >
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={ending}
              onClick={() => void end()}
              data-testid="call-end-confirm"
            >
              {VIDEO_CALL_WORDS.endForEveryone}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmAiOff} onOpenChange={setConfirmAiOff}>
        <DialogContent
          title={`${VIDEO_CALL_WORDS.aiTurnOff}?`}
          description={VIDEO_CALL_WORDS.aiOffConfirm}
        >
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={turningAi}
              onClick={() => void turnAi(false)}
              data-testid="call-ai-notes-off-confirm"
            >
              Turn off AI notes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const aiPillClass = (on: boolean) =>
  cn(
    'inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium',
    on ? 'bg-accent-soft text-accent-text' : 'bg-[#2c3139] text-text-3',
  );

/** A caption on screen: when it last changed, so finished ones can go after a moment. */
type ShownCaption = VideoCallCaption & { readonly at: number };

/** How long a finished caption stays, and one still being heard that stopped changing. */
const CAPTION_STAYS_MS = 6_000;
const CAPTION_STALE_MS = 10_000;

/**
 * The listener's captions, while CC is on: the newest few, each replaced as its words firm up. The listener is
 * unseen, so its messages come from nobody in the room; one from someone in the room isn't a caption.
 */
function useCaptions(on: boolean): readonly ShownCaption[] {
  const [lines, setLines] = useState<ShownCaption[]>([]);
  const want = useRef(on);
  want.current = on;
  useDataChannel(VIDEO_CALL_CAPTIONS_TOPIC, (msg) => {
    if (!want.current || (msg.from && msg.from.identity !== LISTENER_IDENTITY)) return;
    const c = captionOf(msg.payload);
    if (!c) return;
    setLines((now) => [...now.filter((x) => x.id !== c.id), { ...c, at: Date.now() }].slice(-3));
  });
  useEffect(() => {
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
    <div
      className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex flex-col items-center gap-1 px-4"
      aria-live="polite"
      data-testid="call-captions"
    >
      {lines.length ? (
        lines.map((l) => (
          <p
            key={l.id}
            className="max-w-[720px] rounded-md bg-black/75 px-3 py-1.5 text-[15px] leading-snug text-white"
          >
            <span className="font-medium text-white/70">{l.name}: </span>
            {l.text}
          </p>
        ))
      ) : aiOn ? null : (
        <p className="max-w-[520px] rounded-md bg-black/75 px-3 py-1.5 text-center text-[13px] text-white/85">
          {VIDEO_CALL_WORDS.captionsNeedAi}
        </p>
      )}
    </div>
  );
}

/** "Dana raised their hand", for everyone else. */
function useHandsUp() {
  const room = useRoomContext();
  useEffect(() => {
    const changed = (attrs: Record<string, string>, p: Participant) => {
      if (p.isLocal || attrs[VIDEO_CALL_ATTRIBUTES.hand] !== 'up') return;
      toast(`${p.name || 'Someone'} raised their hand`, { icon: '✋' });
    };
    room.on(RoomEvent.ParticipantAttributesChanged, changed);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, changed);
    };
  }, [room]);
}

/** Browsers hold sound back until the page is pressed; Join usually counts, but not always on a phone. */
function StartAudioPrompt() {
  const { mergedProps, canPlayAudio } = useStartAudio({ props: {} });
  if (canPlayAudio) return null;
  return (
    <div className="flex justify-center pb-1">
      <button
        type="button"
        onClick={mergedProps.onClick}
        className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-[13.5px] font-medium text-white"
        data-testid="call-start-audio"
      >
        <Volume2 size={16} />
        Turn on sound
      </button>
    </div>
  );
}

function Reactions({ floating }: { floating: readonly Floating[] }) {
  return (
    <div
      className="pointer-events-none absolute bottom-12 left-3 z-10 flex flex-col-reverse gap-1.5"
      aria-live="polite"
    >
      {floating.map((f) => (
        <FloatingReaction key={f.id} f={f} />
      ))}
    </div>
  );
}

function FloatingReaction({ f }: { f: Floating }) {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setUp(true));
    return () => cancelAnimationFrame(t);
  }, []);
  return (
    <span
      className={cn(
        'flex w-fit items-center gap-1.5 rounded-full bg-black/55 py-1 pl-1.5 pr-2.5 text-[12.5px] text-white transition-all duration-[3800ms] ease-out',
        up ? '-translate-y-24 opacity-0' : 'translate-y-0 opacity-100',
      )}
      data-testid="call-reaction"
    >
      <span className="text-[22px] leading-none">{f.emoji}</span>
      {f.from}
    </span>
  );
}

function controlClass(opts: { off?: boolean; active?: boolean } = {}) {
  return cn(
    'relative inline-flex h-11 w-11 flex-none items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/60',
    opts.off
      ? 'bg-[#c43335] text-white hover:brightness-95'
      : opts.active
        ? 'bg-accent text-white'
        : 'bg-[#2c3139] text-white hover:bg-[#3a4049]',
  );
}

function Control({
  label,
  off,
  active,
  badge,
  badgeTone = 'plain',
  onClick,
  testId,
  children,
}: {
  label: string;
  /** Microphone or camera off: red, as every call app shows it. */
  off?: boolean;
  /** Something they turned on (sharing, blur, a hand up, an open panel). */
  active?: boolean;
  badge?: number;
  badgeTone?: 'plain' | 'warning';
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active ?? (off === undefined ? undefined : !off)}
      onClick={onClick}
      className={controlClass({ off, active })}
      data-testid={testId}
    >
      {children}
      {badge ? (
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-semibold',
            badgeTone === 'warning' ? 'bg-[#f0a93b] text-[#191d25]' : 'bg-white text-[#191d25]',
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The stand-in's call (`fake:` tickets): no video or sound to carry, so the screen says so. Leaving works, and the
 * team's panel works from the API, so the rest of a call's flow can be tried without LiveKit.
 */
function StandIn({ heading, team, onEnd }: CallRoomProps) {
  const { got, reload } = useVideoCall(team?.workspaceId ?? '', team?.callId ?? '', !!team);
  return (
    <div
      data-theme="dark"
      className="fixed inset-0 z-40 flex flex-col bg-[#0b0e13] text-text"
      data-testid="call-room"
    >
      <header className="px-4 py-2.5">
        <span className="text-[15px] font-medium" data-testid="call-title">
          {team && got?.appointment ? got.appointment.title : heading.title}
        </span>
      </header>
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        data-testid="call-stand-in"
      >
        <Avatar name={heading.title} size="lg" />
        <p className="max-w-[420px] text-[13.5px] text-text-2">{VIDEO_CALL_WORDS.standIn}</p>
        {team && got ? (
          <div className="w-full max-w-[420px] text-left">
            {got.people
              .filter((p) => p.state === 'waiting' && p.kind === 'guest')
              .map((p) => (
                <StandInAsking
                  key={p.id}
                  name={p.name}
                  personId={p.id}
                  team={team}
                  reload={reload}
                />
              ))}
          </div>
        ) : null}
      </div>
      <nav className="flex justify-center pb-4">
        <button
          type="button"
          onClick={() => onEnd('left')}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-[#c43335] px-4 text-[14px] font-medium text-white"
          data-testid="call-leave"
        >
          <PhoneOff size={18} />
          Leave
        </button>
      </nav>
    </div>
  );
}

function StandInAsking({
  name,
  personId,
  team,
  reload,
}: {
  name: string;
  personId: string;
  team: TeamSide;
  reload: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 text-[13.5px]">
      {VIDEO_CALL_WORDS.askingToJoin(name)}
      <Button
        size="sm"
        onClick={() =>
          void actOn('admit', { workspaceId: team.workspaceId, callId: team.callId, personId })
            .then(reload)
            .catch((e: unknown) => toast.error(errorMessage(e)))
        }
      >
        {VIDEO_CALL_WORDS.letIn}
      </Button>
    </div>
  );
}
