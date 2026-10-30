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
 * - **A session's call is a webinar** (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md): the team presents to up to 500
 *   people who watch, chat, react and raise a hand. The team can bring one on stage, and chooses whether attendees
 *   may turn their cameras on, and who sees them.
 */
import type { VideoProvider } from '../calendar/config';

/** What it's called in HandsFreeOS (2a). Customers see the business's own name, never this. */
export const VIDEO_CALL_NAME = 'HandsFreeOS video call';

/** Up to 10 people at once for now (7a), the AI's listener aside. */
export const VIDEO_CALL_MAX_PEOPLE = 10;

// ---------- webinars (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 1) ----------

/**
 * A meeting, where everyone talks and is on camera, or a webinar: a session's call, where the team presents and
 * everyone else watches. Set when the call is made, from its appointment, and never changed.
 */
export const VIDEO_CALL_FORMATS = ['meeting', 'webinar'] as const;
export type VideoCallFormat = (typeof VIDEO_CALL_FORMATS)[number];

/** Up to 500 in a webinar at once (the owner's 2b), the listener aside: as many seats as a sessions calendar holds. */
export const WEBINAR_MAX_PEOPLE = 500;

/** How many people a call holds at once. */
export const maxPeopleOf = (format: VideoCallFormat): number =>
  format === 'webinar' ? WEBINAR_MAX_PEOPLE : VIDEO_CALL_MAX_PEOPLE;

/**
 * Attendees' cameras in a webinar (the owner's 4): off; on, with only the team seeing them; or on, with everyone
 * seeing everyone. The presenter or a shared screen is always the big picture either way.
 */
export const ATTENDEE_VIDEO_CHOICES = ['off', 'team', 'everyone'] as const;
export type AttendeeVideo = (typeof ATTENDEE_VIDEO_CHOICES)[number];

/** Attendees on stage at once, beside the team: past this, the presenter sends someone back first. */
export const WEBINAR_MAX_ON_STAGE = 3;

/** What someone may send in the room. LiveKit holds them to it: their ticket and permissions say so. */
export interface VideoCallPublish {
  readonly camera: boolean;
  readonly microphone: boolean;
  readonly screen: boolean;
}

/**
 * What someone may send: everything in a meeting, and for the team in a webinar. An attendee on stage talks and is on
 * camera; the rest watch, with a camera only when the presenter allows one.
 */
export function mayPublish(p: {
  readonly format: VideoCallFormat;
  readonly kind: 'team' | 'customer' | 'guest';
  readonly onStage: boolean;
  readonly attendeeVideo: AttendeeVideo;
}): VideoCallPublish {
  if (p.format === 'meeting' || p.kind === 'team')
    return { camera: true, microphone: true, screen: true };
  if (p.onStage) return { camera: true, microphone: true, screen: false };
  return { camera: p.attendeeVideo !== 'off', microphone: false, screen: false };
}

/**
 * Who sees an attendee's camera in a webinar: everyone when the presenter said so or they're on stage, else only the
 * team. Their own page holds LiveKit to it (track subscription permissions), so it isn't just hidden.
 */
export const attendeeSeenBy = (p: {
  readonly onStage: boolean;
  readonly attendeeVideo: AttendeeVideo;
}): 'everyone' | 'team' => (p.onStage || p.attendeeVideo === 'everyone' ? 'everyone' : 'team');

/**
 * The link anyone can use for a webinar (the owner's 5c), `/live/<key>`: a door form that saves a seat on the session
 * and, while it's open, goes straight in. The key is public, not secret, and only its webinar has it.
 */
export const WEBINAR_DOOR_KEY_LENGTH = 24;
const DOOR_KEY_RE = new RegExp(`^[0-9A-Za-z]{${WEBINAR_DOOR_KEY_LENGTH}}$`);
export const isWebinarDoorKey = (key: string): boolean => DOOR_KEY_RE.test(key);
export const webinarDoorPath = (key: string): string => `/live/${key}`;

/** The webinar settings a sessions calendar gives each session's call (the owner's 4 and 24). */
export interface WebinarSettings {
  readonly attendeeVideo: AttendeeVideo;
  readonly startingNow: boolean;
  readonly missedFollowUp: boolean;
}

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

// ---------- calls any time (part 5, pick 5c) ----------

/**
 * A call that isn't for an appointment, started from a customer's page, a conversation or a phone call: the
 * customer's own link is `/j/<key>`, a random key of this many letters and digits that only its hash is kept of. An
 * appointment's Join link is 18 long, so the two never mix.
 */
export const VIDEO_CALL_LINK_KEY_LENGTH = 32;
const LINK_KEY_RE = new RegExp(`^[0-9A-Za-z]{${VIDEO_CALL_LINK_KEY_LENGTH}}$`);
export const isVideoCallLinkKey = (token: string): boolean => LINK_KEY_RE.test(token);
export const videoCallLinkPath = (key: string): string => `/j/${key}`;

/** How long after it was made such a call's link still opens it, besides while it's going. */
export const VIDEO_CALL_LINK_OPEN_MS = 24 * 60 * 60_000;

/** Whether the customer's own link to a call that isn't for an appointment opens it now. */
export function customerCallLinkOpens(
  at: { readonly createdAt: number; readonly live: boolean },
  now: number,
): 'open' | 'over' {
  return at.live || now - at.createdAt <= VIDEO_CALL_LINK_OPEN_MS ? 'open' : 'over';
}

/** What a call that isn't for an appointment is called, on its page, its line and its push. */
export const videoCallTitle = (customer: string | null | undefined): string =>
  customer?.trim() ? `Video call with ${customer.trim()}` : 'Video call';

/** Where a call's link goes: a conversation's own channel, a text, or an email. */
export const VIDEO_CALL_INVITE_CHANNELS = [
  'sms',
  'email',
  'chat',
  'portal',
  'messenger',
  'instagram',
] as const;
export type VideoCallInviteChannel = (typeof VIDEO_CALL_INVITE_CHANNELS)[number];

/**
 * How the customer gets their link when nobody said: in the conversation it was started from, on that
 * conversation's own channel; otherwise a text when they have a number that takes texts, else an email. Null when
 * there's no way to reach them.
 */
export function videoCallInviteChannel(input: {
  readonly asked?: 'sms' | 'email' | null;
  readonly conversation?: string | null;
  readonly phone: boolean;
  readonly textsOk: boolean;
  readonly email: boolean;
}): VideoCallInviteChannel | null {
  const sms = input.phone && input.textsOk;
  if (input.asked === 'sms') return sms ? 'sms' : null;
  if (input.asked === 'email') return input.email ? 'email' : null;
  // A text conversation with someone who can't take texts now (they texted STOP) goes on to their email.
  const c = input.conversation;
  if (c && (VIDEO_CALL_INVITE_CHANNELS as readonly string[]).includes(c) && (c !== 'sms' || sms))
    return c as VideoCallInviteChannel;
  if (sms) return 'sms';
  return input.email ? 'email' : null;
}

/** The message that carries the customer's link, sent as whoever started the call. */
export function videoCallInviteWords(input: {
  readonly business: string;
  readonly firstName: string | null;
  readonly link: string;
  readonly channel: VideoCallInviteChannel;
  readonly aiNotes: boolean;
}): { readonly subject: string | null; readonly body: string } {
  const notice = input.aiNotes ? ` ${VIDEO_CALL_WORDS.emailNotice}` : '';
  if (input.channel !== 'email')
    return {
      subject: null,
      body: `Here’s the link to our video call: ${input.link}\nIt opens in your browser, with nothing to install.${notice}`,
    };
  return {
    subject: `Video call with ${input.business}`,
    body: [
      `Hi ${input.firstName?.trim() || 'there'},`,
      '',
      'Here’s the link to our video call:',
      input.link,
      '',
      `It opens in your browser, with nothing to install.${notice}`,
    ].join('\n'),
  };
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
export const VIDEO_CALL_ATTRIBUTES = {
  kind: 'hfos.kind',
  hand: 'hfos.hand',
  /** A webinar: `webinar`, so every page lays the room out as one. */
  format: 'hfos.format',
  /** A webinar: attendees' cameras (`off`, `team`, `everyone`), kept up to date by the worker. */
  video: 'hfos.video',
  /** A webinar: `on` for an attendee the team brought on stage. */
  stage: 'hfos.stage',
} as const;

/**
 * What the worker puts on someone in the room, besides who they are: a webinar's format, its camera choice and
 * whether they're on stage. A meeting carries none of it.
 */
export function videoCallAttributes(p: {
  readonly format: VideoCallFormat;
  readonly attendeeVideo: AttendeeVideo;
  readonly onStage: boolean;
}): Record<string, string> {
  if (p.format !== 'webinar') return {};
  return {
    [VIDEO_CALL_ATTRIBUTES.format]: 'webinar',
    [VIDEO_CALL_ATTRIBUTES.video]: p.attendeeVideo,
    [VIDEO_CALL_ATTRIBUTES.stage]: p.onStage ? 'on' : '',
  };
}

/**
 * What someone carries in the room, read back from their attributes: the format, who they are to the call, whether
 * they're on stage, the camera choice, and so what they may send. Every page and the phone read it the same way.
 */
export function roomRightsOf(attrs: Readonly<Record<string, string>> | undefined): {
  readonly format: VideoCallFormat;
  readonly kind: VideoCallKind;
  readonly onStage: boolean;
  readonly attendeeVideo: AttendeeVideo;
  readonly publish: VideoCallPublish;
} {
  const a = attrs ?? {};
  const format: VideoCallFormat =
    a[VIDEO_CALL_ATTRIBUTES.format] === 'webinar' ? 'webinar' : 'meeting';
  const kind = (VIDEO_CALL_KINDS as readonly string[]).includes(a[VIDEO_CALL_ATTRIBUTES.kind] ?? '')
    ? (a[VIDEO_CALL_ATTRIBUTES.kind] as VideoCallKind)
    : 'guest';
  const video = a[VIDEO_CALL_ATTRIBUTES.video] ?? '';
  const attendeeVideo: AttendeeVideo = (ATTENDEE_VIDEO_CHOICES as readonly string[]).includes(video)
    ? (video as AttendeeVideo)
    : 'off';
  const onStage = a[VIDEO_CALL_ATTRIBUTES.stage] === 'on';
  return {
    format,
    kind,
    onStage,
    attendeeVideo,
    publish: mayPublish({ format, kind, onStage, attendeeVideo }),
  };
}

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
  // Calls any time (part 5).
  /** On a customer's page and in a conversation. */
  start: 'Video call',
  /** On the phone call's bar. */
  switchToVideo: 'Switch to video',
  /** The choice of how the link goes, when the customer has a number and an email. */
  sendBy: {
    sms: (to: string) => `Text the link to ${to}`,
    email: (to: string) => `Email the link to ${to}`,
  },
  /** Under the choice, on the phone. */
  sendHow: 'They join from their own link, and the call opens for you.',
  /** In quiet hours, only a person's yes sends a text (as in the composer). */
  sendAnyway: 'Send the link anyway',
  starting: 'Sending the link…',
  /** Once the link is on its way, and the call opens for whoever pressed it. */
  started: (name: string, channel: VideoCallInviteChannel) =>
    `${name}’s link is on its way ${channel === 'sms' ? 'by text' : channel === 'email' ? 'by email' : 'in your conversation'}. The call opens for you now.`,
  /** After Switch to video, while the phone call is still going. */
  switchHint: 'Hang up the phone call once they’re in the video call.',
  /** On that line: the call's summary, After the call and transcript. */
  notes: 'Notes from the call',
  notesSoon:
    'The summary and suggestions show here a minute after the call ends, when its AI notes were on.',
} as const;

/** A webinar's words (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md), one copy for the web and the phone. */
export const WEBINAR_WORDS = {
  /** In the call's header, on the appointment and in Settings. */
  name: 'Webinar',
  // ---- attendees' cameras (the owner's 4) ----
  attendeeVideo: 'Attendees’ cameras',
  attendeeVideoChoices: {
    off: 'Off',
    team: 'On, only your team sees them',
    everyone: 'On, everyone sees everyone',
  } satisfies Record<AttendeeVideo, string>,
  /** The team's pill in the call's header. */
  attendeeVideoShort: {
    off: 'Attendee cameras off',
    team: 'Attendee cameras: team sees',
    everyone: 'Attendee cameras: everyone sees',
  } satisfies Record<AttendeeVideo, string>,
  attendeeVideoHelp:
    'Attendees join muted. Choose whether they can turn their cameras on, and who sees them. You or your slides are always the big picture.',
  attendeeVideoChanged: {
    off: 'Attendees’ cameras are off.',
    team: 'Attendees can turn their cameras on. Only your team sees them.',
    everyone: 'Attendees can turn their cameras on, and everyone sees everyone.',
  } satisfies Record<AttendeeVideo, string>,
  // ---- the stage ----
  onStage: 'On stage',
  bringOnStage: 'Bring on stage',
  backToAudience: 'Back to the audience',
  stageFull: `Up to ${WEBINAR_MAX_ON_STAGE} people can be on stage at once. Send someone back to the audience first.`,
  youreOnStage: 'You’re on stage. You can turn on your microphone and camera now.',
  backInAudience: 'You’re back in the audience.',
  // ---- in the room ----
  watching: (n: number) => (n === 1 ? '1 watching' : `${n} watching`),
  audience: 'Audience',
  presenting: 'Presenting',
  /** The attendee's own page: why there's no microphone button. */
  watchOnly:
    'You’re watching. Raise your hand or use the chat, and the presenter can bring you on stage.',
  /** The page before joining: why it asks for no microphone or camera. */
  joinHint:
    'You’ll join watching, with your microphone and camera off. Use the chat or raise your hand to take part.',
  /** Before the presenter is in. */
  waitingFor: 'The webinar starts soon. Stay on this page, and you’ll go in as soon as it starts.',
  full: `This webinar is full: it has room for ${WEBINAR_MAX_PEOPLE} people at once. Try again in a few minutes.`,
  // ---- the link anyone can use (5c) ----
  doorLink: 'Link anyone can use',
  doorLinkHelp:
    'Anyone with this link can save a seat, or join while it’s on. Share it in posts, ads and emails.',
  doorSave: 'Save my seat',
  doorJoin: 'Join now',
  doorSaving: 'Saving your seat…',
  doorRegistered: (when: string) =>
    `You’re registered for ${when}. Your own Join link is on its way, and it opens an hour before the start.`,
  doorSent:
    'You’re already on file with this business, so we sent your own Join link to the phone or email they have for you.',
  doorOver: 'This webinar has ended.',
  doorCancelled: 'This webinar was cancelled.',
  doorFull: 'This webinar is full.',
  doorOff: 'This link doesn’t work right now. Ask the business for another way to join.',
  // ---- Settings → Calendars, on a sessions calendar with HandsFreeOS video calls ----
  settingsHelp:
    'Each session on this calendar runs as a webinar: you and your team present, and up to 500 people watch.',
  startingNow: 'Message people when it starts',
  startingNowHelp:
    'Everyone booked who isn’t in yet gets their own Join link by text, or by email when a text can’t go.',
  missedFollowUp: 'Follow up with anyone who misses it',
  missedFollowUpHelp:
    'Anyone who never came in is told when the next session is, with a link to save a seat.',
} as const;

/** "[Title] is starting now": to each person booked on a webinar who isn't in yet, with their own Join link. */
export function webinarStartingWords(input: {
  readonly title: string;
  readonly business: string;
  readonly firstName: string | null;
  readonly link: string;
}): { readonly text: string; readonly subject: string; readonly email: string } {
  return {
    text: `${input.title} is starting now. Join here: ${input.link}`,
    subject: `${input.title} is starting now`,
    email: [
      `Hi ${input.firstName?.trim() || 'there'},`,
      '',
      `${input.title} with ${input.business} is starting now. Join here:`,
      input.link,
      '',
      'It opens in your browser, with nothing to install.',
    ].join('\n'),
  };
}

/**
 * The follow-up for someone who missed a webinar completely (the owner's 24): the next session with seats and its link
 * anyone can use, or that they'll hear when there's another.
 */
export function webinarMissedWords(input: {
  readonly title: string;
  readonly business: string;
  readonly firstName: string | null;
  /** The next session on the same calendar with seats left: "Tue, Nov 3 · 7:00 pm" and its link anyone can use. */
  readonly next: { readonly when: string; readonly link: string } | null;
}): { readonly text: string; readonly subject: string; readonly email: string } {
  const sorry = `Sorry we missed you at ${input.title}.`;
  const after = input.next
    ? `The next one is ${input.next.when}. Save your seat: ${input.next.link}`
    : 'We’ll let you know when there’s another one.';
  return {
    text: `${sorry} ${after}`,
    subject: input.next ? `The next ${input.title}: ${input.next.when}` : `Sorry we missed you`,
    email: [
      `Hi ${input.firstName?.trim() || 'there'},`,
      '',
      `Sorry we missed you at ${input.title} with ${input.business}.`,
      '',
      ...(input.next
        ? [`The next one is ${input.next.when}. Save your seat here:`, input.next.link]
        : ['We’ll let you know when there’s another one.']),
    ].join('\n'),
  };
}

/**
 * Their own Join link again, for someone already on file who used a webinar's link anyone can use: it goes to the
 * phone or email the business has for them, never back to the page, so typing someone else's details gets nobody in.
 */
export function webinarJoinLinkWords(input: {
  readonly title: string;
  readonly business: string;
  readonly firstName: string | null;
  /** "Fri, Sep 18 at 10:00 AM". */
  readonly when: string;
  readonly link: string;
}): { readonly text: string; readonly subject: string; readonly email: string } {
  return {
    text: `Your own Join link for ${input.title} (${input.when}): ${input.link}`,
    subject: `Your Join link for ${input.title}`,
    email: [
      `Hi ${input.firstName?.trim() || 'there'},`,
      '',
      `Here’s your own Join link for ${input.title} with ${input.business}, ${input.when}:`,
      input.link,
      '',
      'It opens an hour before the start, in your browser, with nothing to install.',
    ].join('\n'),
  };
}

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

/**
 * A webinar's push while nobody from the team is in yet: one for the crowd, not one per person, at most every
 * `WEBINAR_WAITING_PUSH_MS`.
 */
export const WEBINAR_WAITING_PUSH_MS = 10 * 60_000;
export function webinarWaitingPushWords(input: {
  readonly waiting: number;
  readonly title: string;
}): {
  title: string;
  body: string;
} {
  return {
    title:
      input.waiting <= 1
        ? 'Someone is waiting for your webinar'
        : `${input.waiting} people are waiting for your webinar`,
    body: input.title,
  };
}
