/**
 * HandsFreeOS video calls (docs/video-calls.md): the rules and words the worker, the web and the phone share.
 * Browser-safe.
 *
 * - **The Online place's choice** is `handsfree` in `VideoProvider`. While a business has video calls on, an Online
 *   place with no link of its own makes one too (the owner's 4a), so a place nobody set up still works.
 * - **A call is a LiveKit room** named after the call (`hf-<call id>`), and everyone in it is a row of
 *   `app.video_call_people`, whose id is their identity in the room. The AI's listener (part 2) is the one identity
 *   that isn't a row.
 * - **Getting in** (6a): a customer on their own Join link goes straight in once someone from the team is there;
 *   anyone else waits until the team lets them in.
 */
import type { VideoProvider } from '../calendar/config';

/** What it's called in HandsFreeOS (2a). Customers see the business's own name, never this. */
export const VIDEO_CALL_NAME = 'HandsFreeOS video call';

/** Up to 10 people at once for now (7a), the AI's listener aside. */
export const VIDEO_CALL_MAX_PEOPLE = 10;

/** How early a customer's own link opens the call, as with Zoom and Meet links today. */
export const VIDEO_CALL_OPENS_MS = 60 * 60_000;

/**
 * Whether a customer's own link opens the call now: from an hour before the start until the end, and after the end
 * for as long as the call is still going.
 */
export function videoCallLinkOpens(
  at: { readonly startsAt: number; readonly endsAt: number; readonly live: boolean },
  now: number,
): 'early' | 'open' | 'over' {
  if (now < at.startsAt - VIDEO_CALL_OPENS_MS) return 'early';
  if (now > at.endsAt && !at.live) return 'over';
  return 'open';
}

/** How long a ticket to the room lasts: long enough to connect and reconnect, no longer. */
export const VIDEO_CALL_TICKET_SECONDS = 15 * 60;

/** How often a waiting page asks again whether it may come in. */
export const VIDEO_CALL_WAIT_POLL_MS = 3_000;

/**
 * What an Online place makes, with what the business has on. A HandsFreeOS call while video calls are off makes
 * nothing (the appointment says why); a place with no link and nothing to make one makes a HandsFreeOS call while
 * they're on.
 */
export function effectiveVideo(
  video: VideoProvider | null | undefined,
  meetingUrl: string | null | undefined,
  videoCalls: boolean,
): VideoProvider {
  const v = video ?? 'none';
  if (v === 'handsfree') return videoCalls ? 'handsfree' : 'none';
  if (v === 'none' && !meetingUrl && videoCalls) return 'handsfree';
  return v;
}

// ---------- the room ----------

const ROOM_PREFIX = 'hf-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The LiveKit room a call is held in. */
export const videoCallRoom = (callId: string): string => `${ROOM_PREFIX}${callId}`;

/** The call a room is, or null for a room that isn't one of ours. */
export function callIdOfRoom(room: string | null | undefined): string | null {
  if (!room?.startsWith(ROOM_PREFIX)) return null;
  const id = room.slice(ROOM_PREFIX.length).toLowerCase();
  return UUID.test(id) ? id : null;
}

/**
 * The call a HandsFreeOS video call's own link opens (`<web>/call/<id>`, the team's address on the appointment), or
 * null for any other link: the phone's Join opens that call in the app rather than the browser.
 */
export function callIdOfLink(url: string | null | undefined): string | null {
  const m = /^https?:\/\/[^/?#]+\/call\/([^/?#]+)\/?(?:[?#]|$)/i.exec(url ?? '');
  const id = m?.[1]?.toLowerCase() ?? '';
  return UUID.test(id) ? id : null;
}

/**
 * Where the team's apps open a call, under the business: the phone's call screen, and on the web a page that goes on
 * to the call's own link. The push about someone waiting opens it.
 */
export const videoCallAppPath = (workspaceId: string, callId: string): string =>
  `/app/w/${workspaceId}/call/${callId}`;

/** Someone in the room who is a person on the call (a row's id), not the AI's listener. */
export const isPersonIdentity = (identity: string | null | undefined): boolean =>
  !!identity && UUID.test(identity);

/** The AI's listener (part 2): hidden, never counted, never charged as a person. */
export const LISTENER_IDENTITY = 'hfos-listener';

export const VIDEO_CALL_KINDS = ['team', 'customer', 'guest'] as const;
export type VideoCallKind = (typeof VIDEO_CALL_KINDS)[number];

export const VIDEO_CALL_STATES = ['open', 'live', 'ended'] as const;
export type VideoCallState = (typeof VIDEO_CALL_STATES)[number];

export const VIDEO_CALL_PERSON_STATES = [
  'waiting',
  'admitted',
  'in',
  'left',
  'turned_away',
  'removed',
] as const;
export type VideoCallPersonState = (typeof VIDEO_CALL_PERSON_STATES)[number];

/**
 * What each person carries in the room, as LiveKit participant attributes: who they are to the call, and whether
 * their hand is up. The kind is the ticket's, set by HandsFreeOS; the hand is theirs to raise and lower.
 */
export const VIDEO_CALL_ATTRIBUTES = { kind: 'hfos.kind', hand: 'hfos.hand' } as const;

/** The data topic reactions travel on: one emoji at a time, never kept. */
export const VIDEO_CALL_REACTIONS_TOPIC = 'hfos.reactions';

// ---------- the AI hearing the call (part 2) ----------

/**
 * The data topic captions travel on, from the listener to everyone in the call: each person's words as they're
 * heard, a guess first and then the finished line. The screens show them only with CC on.
 */
export const VIDEO_CALL_CAPTIONS_TOPIC = 'hfos.captions';

/** The room's metadata key that says the AI is hearing the call now ('on'), set by the listener. */
export const VIDEO_CALL_ROOM_AI = 'hfos.ai';

/** One caption: who's talking (their identity in the room and the name shown), what they've said so far. */
export interface VideoCallCaption {
  /** The same for every guess at one line and for the line itself, so a screen replaces rather than adds. */
  readonly id: string;
  readonly who: string;
  readonly name: string;
  readonly text: string;
  /** The finished line; before that, the listener's guess so far. */
  readonly final: boolean;
}

/** A caption as it travels, or null for anything that isn't one. */
export function captionOf(payload: Uint8Array | string): VideoCallCaption | null {
  try {
    const raw: unknown = JSON.parse(
      typeof payload === 'string' ? payload : new TextDecoder().decode(payload),
    );
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    if (
      typeof c['id'] !== 'string' ||
      typeof c['who'] !== 'string' ||
      typeof c['name'] !== 'string' ||
      typeof c['text'] !== 'string'
    )
      return null;
    return {
      id: c['id'].slice(0, 100),
      who: c['who'].slice(0, 100),
      name: c['name'].slice(0, 120),
      text: c['text'].slice(0, 2000),
      final: c['final'] === true,
    };
  } catch {
    return null;
  }
}

/** Whether the room says the AI is hearing it, from its metadata (JSON the listener sets). */
export function roomAiOn(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    const m: unknown = JSON.parse(metadata);
    return (
      !!m && typeof m === 'object' && (m as Record<string, unknown>)[VIDEO_CALL_ROOM_AI] === 'on'
    );
  } catch {
    return false;
  }
}

/** The team's side or the customer's, for the transcript and the coach: anyone let in is the customer's. */
export const sideOfKind = (kind: VideoCallKind): 'team' | 'customer' =>
  kind === 'team' ? 'team' : 'customer';

/**
 * What a stretch of a call said, as the appointment keeps it: one line per turn, "Name: words", a person's lines run
 * together while nobody else speaks, as Zoom's and Google Meet's transcripts read.
 */
export function videoCallTranscript(
  lines: readonly { readonly name: string; readonly body: string }[],
): string {
  const turns: { who: string; said: string }[] = [];
  for (const l of lines) {
    const said = l.body.trim();
    if (!said) continue;
    const last = turns[turns.length - 1];
    if (last && last.who === l.name) last.said += ` ${said}`;
    else turns.push({ who: l.name, said });
  }
  return turns.map((t) => `${t.who}: ${t.said}`).join('\n');
}
export const VIDEO_CALL_REACTIONS = ['👍', '❤️', '😂', '👏', '🎉', '😮'] as const;
export type VideoCallReaction = (typeof VIDEO_CALL_REACTIONS)[number];

/**
 * In-app browsers (Facebook, Instagram, Messenger, TikTok, WeChat, LINE) that can block the camera or the
 * microphone: the join page asks to open the link in Safari or Chrome instead.
 */
const IN_APP_BROWSER =
  /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|musical_ly|TikTok|MicroMessenger|\bLine\//i;
export const isInAppBrowser = (userAgent: string | null | undefined): boolean =>
  !!userAgent && IN_APP_BROWSER.test(userAgent);

/** A first name for "Dana will be right with you", from a full name or an email. */
export const hostFirstName = (name: string | null | undefined): string | null => {
  const n = (name ?? '').trim().split(/[\s@]+/)[0];
  return n ? n : null;
};

/** "4 min", "1 hr 5 min": how long someone was in a call. */
export function callLengthLabel(seconds: number): string {
  const min = Math.max(0, Math.round(seconds / 60));
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// ---------- the words, one copy for the web and the phone ----------

export const VIDEO_CALL_WORDS = {
  name: VIDEO_CALL_NAME,
  /** The Online place's choice in Settings → Calendars → Locations, and a service's. */
  placeOption: 'HandsFreeOS video call',
  placeHelp:
    'A video call in HandsFreeOS: nothing to set up. Customers join from their own link in any browser, and your team from the appointment.',
  /** Under an Online place with no link, while video calls are on: what customers get. */
  noLinkMakesCall: 'No link here, so each appointment gets a HandsFreeOS video call.',
  /** The Online place's choice while the business has video calls off (support turned them off since). */
  placeOff:
    'HandsFreeOS video calls aren’t on for this business, so these appointments get no video link. Pick another choice, or ask HandsFreeOS support to turn them on.',
  join: 'Join',
  joinCall: 'Join video call',
  waitingFor: (host: string | null) =>
    host ? `${host} will be right with you.` : 'Someone will be right with you.',
  waitingHint: 'Stay on this page. You’ll go in as soon as they join.',
  knocking: 'You’ve asked to join. Someone will let you in shortly.',
  turnedAway: 'You weren’t let into this call. If that seems wrong, contact the business.',
  removed: 'You were taken out of this call.',
  ended: 'This call has ended.',
  left: 'You left the call.',
  full: `This call is full: it has room for ${VIDEO_CALL_MAX_PEOPLE} people. Try again when someone leaves.`,
  inAppBrowser:
    'This app’s own browser can block your camera and microphone. Open this link in Safari or Chrome to join.',
  noCamera:
    'Your browser didn’t let this page use your camera or microphone. Allow them in your browser’s settings for this page, then try again.',
  poweredBy: 'Powered by HandsFreeOS',
  endForEveryone: 'End for everyone',
  endForEveryoneConfirm: 'End the call for everyone?',
  endForEveryoneHow:
    'Everyone leaves the call now. Customers can come back in on their own link once someone from your team joins again.',
  leaveOnly: 'Leave the call',
  letIn: 'Let in',
  turnAway: 'Turn away',
  remove: 'Remove',
  mute: 'Mute',
  /** Who someone in the call is, in the list of people. */
  kinds: { team: 'Team', customer: 'Customer', guest: 'Guest' },
  askingToJoin: (name: string) => `${name} is asking to join`,
  joining: 'Joining the call…',
  reconnecting: 'Reconnecting…',
  aloneTeam: 'You’re the only one here so far.',
  aloneOthers: 'Waiting for the others to join.',
  /** Why someone isn't in the call any more, past what `left`, `removed` and `ended` say. */
  endedTeam: 'Everyone has left. Starting it again lets customers back in on their own link.',
  elsewhereTitle: 'You’re in this call somewhere else',
  elsewhere: 'You joined from another tab or device, so this one stepped out.',
  lostTitle: 'Your connection to the call dropped',
  lost: 'Check your internet connection, then join again.',
  opening: 'Opening the call…',
  /** The stand-in's call (`fake:` tickets, on laptops and in tests without LiveKit): nothing is carried. */
  standIn:
    'Test call: video calls here run on a stand-in, so nobody’s camera or sound is carried. With LiveKit set up, this is the call.',
  // The AI hearing the call (the owner's 8a to 11a).
  /** In the call, for everyone, while the AI hears it. */
  aiOn: 'AI notes on',
  /** Before joining, while the call's AI notes are on: joining is agreeing (9a). */
  aiNotice: (business: string) =>
    `${business} uses AI to take notes from what’s said in this call. No video or sound is kept. By joining, you agree to this.`,
  /** On the booking page, before booking a HandsFreeOS call (9a). */
  bookingNotice: 'AI takes notes from what’s said in this video call. No video or sound is kept.',
  /** In the confirmation and reminders, beside the Join link (9a). */
  emailNotice: 'AI takes notes from what’s said in the call. No video or sound is kept.',
  /** The team's switch in the call. */
  aiTurnOff: 'Turn off AI notes for this call',
  aiTurnOn: 'Turn on AI notes for this call',
  aiOffConfirm:
    'The AI stops listening, and what it heard of this call so far is forgotten. There will be no notes or suggestions from it.',
  aiTurnedOff: 'AI notes are off for this call.',
  aiTurnedOn: 'AI notes are on for this call.',
  captions: 'Captions',
  captionsOn: 'Show captions',
  captionsOff: 'Hide captions',
  /** CC on while the AI isn't hearing the call: there's nothing to caption. */
  captionsNeedAi: 'Captions come from the AI’s notes, which are off for this call.',
  /** The appointment's transcript of a HandsFreeOS call. */
  transcriptFrom: 'From the video call',
  transcriptSoon: 'With AI notes on, the transcript shows here a minute after the call ends.',
} as const;

/** The push to the team when a customer waits for them, or someone asks to be let in. */
export function videoCallWaitingPushWords(input: {
  readonly name: string;
  readonly kind: 'customer' | 'guest';
  readonly title: string;
}): { title: string; body: string } {
  return input.kind === 'customer'
    ? { title: `${input.name} is waiting in the video call`, body: input.title }
    : { title: `${input.name} is asking to join the video call`, body: input.title };
}
