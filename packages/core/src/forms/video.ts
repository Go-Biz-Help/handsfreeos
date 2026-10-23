/**
 * A video on a form (funnels): a link the business pasted from YouTube, Vimeo or Loom, played on the page, with
 * how much of it they watched kept as the question's answer, 0 to 100.
 *
 * The video lives with them, not us: they host and stream it, we play it. Which links we take, the address the
 * page plays, and how a stream of "the player is at 0:42" reports becomes "watched 30%" are all here, so the
 * editor, the public page and the server agree on them. Browser-safe.
 *
 * How far they got is the furthest point they reached by watching, not by dragging the bar ahead. The viewer's
 * browser reports it, so a determined person can fake it: the gate is a nudge to watch first, not proof.
 */

export const VIDEO_HOSTS = ['youtube', 'vimeo', 'loom'] as const;
export type VideoHost = (typeof VIDEO_HOSTS)[number];

export const VIDEO_HOST_NAMES: Readonly<Record<VideoHost, string>> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  loom: 'Loom',
};

/** The players whose position the page can read, and so the ones that can hold the Next button. */
export const TRACKED_HOSTS: ReadonlySet<VideoHost> = new Set(['youtube', 'vimeo']);

/** Where each player's frame comes from: what the page plays, and the only origin its messages are read from. */
export const VIDEO_ORIGINS: Readonly<Record<VideoHost, string>> = {
  youtube: 'https://www.youtube-nocookie.com',
  vimeo: 'https://player.vimeo.com',
  loom: 'https://www.loom.com',
};

export interface VideoSource {
  readonly provider: VideoHost;
  /** The provider's id for it. */
  readonly id: string;
  /** What the page frames. The page adds its own origin for YouTube, which only it knows. */
  readonly embedUrl: string;
  /** Whether the page can tell how much was watched. */
  readonly tracked: boolean;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/i;
const LOOM_ID = /^[0-9a-f]{32}$/i;

function youtubeId(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') return parts[0] ?? null;
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (parts[0] === 'watch') return url.searchParams.get('v');
  if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') return parts[1] ?? null;
  return null;
}

/**
 * The video a link points at, or null when it isn't one we can play: a YouTube, Vimeo or Loom address for one
 * video (not a channel, a playlist or a search).
 */
export function parseVideoUrl(raw: string): VideoSource | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  const yt = youtubeId(url);
  if (yt !== null)
    return YOUTUBE_ID.test(yt)
      ? {
          provider: 'youtube',
          id: yt,
          embedUrl: `${VIDEO_ORIGINS.youtube}/embed/${yt}?enablejsapi=1&rel=0&playsinline=1`,
          tracked: true,
        }
      : null;

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    // vimeo.com/123456789, vimeo.com/123456789/abcdef (unlisted), player.vimeo.com/video/123456789?h=abcdef
    const [first, second] =
      host === 'player.vimeo.com' && parts[0] === 'video' ? parts.slice(1) : parts;
    if (!first || !VIMEO_ID.test(first)) return null;
    const hash = url.searchParams.get('h') ?? second ?? null;
    if (hash !== null && !VIMEO_HASH.test(hash)) return null;
    return {
      provider: 'vimeo',
      id: first,
      embedUrl: `${VIDEO_ORIGINS.vimeo}/video/${first}?${hash ? `h=${hash}&` : ''}dnt=1&api=1`,
      tracked: true,
    };
  }

  if (host === 'loom.com' && (parts[0] === 'share' || parts[0] === 'embed')) {
    const id = parts[1] ?? '';
    return LOOM_ID.test(id)
      ? { provider: 'loom', id, embedUrl: `${VIDEO_ORIGINS.loom}/embed/${id}`, tracked: false }
      : null;
  }
  return null;
}

/** What's wrong with a video question's link, or null when it plays. `title` is the question's, for the words. */
export function videoLinkProblem(
  title: string,
  config: { url: string; minPercent: number | null },
): string | null {
  if (!config.url.trim()) return `“${title}” needs a video link.`;
  const source = parseVideoUrl(config.url);
  if (!source) return `“${title}” needs a YouTube, Vimeo or Loom link to one video.`;
  if (config.minPercent !== null && !source.tracked)
    return `“${title}” is a ${VIDEO_HOST_NAMES[source.provider]} video, and we can’t tell how much of it was watched, so it can’t hold the Next button. Let them move on any time, or use a YouTube or Vimeo link.`;
  return null;
}

// ---- Talking to the player ----

/** What a player said: that it's ready, where it is, how long the video is. Any of them can be missing. */
export interface PlayerReport {
  readonly ready?: boolean;
  readonly seconds?: number;
  readonly duration?: number;
}

const finite = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const parsed = (data: unknown): Record<string, unknown> | null => {
  let out = data;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      return null;
    }
  }
  return out && typeof out === 'object' && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : null;
};

/**
 * The messages that ask a player to report where it is, sent to its frame once it loads. We talk to the
 * players' frames by message rather than loading YouTube's or Vimeo's script into the page: the page is on
 * the business's or our own address, and a provider's script has no business running there.
 */
export function playerHello(host: VideoHost, playerId: string): readonly unknown[] {
  if (host === 'youtube')
    return [JSON.stringify({ event: 'listening', id: playerId, channel: 'widget' })];
  if (host === 'vimeo')
    return [
      { method: 'addEventListener', value: 'timeupdate' },
      { method: 'addEventListener', value: 'playProgress' },
    ];
  return [];
}

/**
 * One message from a player's frame, read into a report, or null when it isn't one we use. The caller has
 * already checked it came from `VIDEO_ORIGINS[host]`.
 */
export function readPlayerMessage(host: VideoHost, data: unknown): PlayerReport | null {
  const m = parsed(data);
  if (!m) return null;
  if (host === 'youtube') {
    if (m['event'] === 'onReady') return { ready: true };
    if (m['event'] !== 'infoDelivery' && m['event'] !== 'initialDelivery') return null;
    const info = parsed(m['info']);
    if (!info) return { ready: true };
    return {
      ready: true,
      seconds: finite(info['currentTime']),
      duration: finite(info['duration']),
    };
  }
  if (host === 'vimeo') {
    if (m['event'] === 'ready') return { ready: true };
    if (m['event'] !== 'timeupdate' && m['event'] !== 'playProgress') return null;
    const d = parsed(m['data']);
    if (!d) return { ready: true };
    return { ready: true, seconds: finite(d['seconds']), duration: finite(d['duration']) };
  }
  return null;
}

// ---- How much they watched ----

/** A jump bigger than this between two reports is the bar being dragged, not the video playing. */
export const WATCH_STEP_SECONDS = 2.5;

export interface WatchState {
  /** The furthest point reached by watching, in seconds. */
  readonly furthest: number;
  /** Where the player last said it was. */
  readonly last: number;
  /** How long the video is; 0 until the player says. */
  readonly duration: number;
  /** What was already watched before this visit (a sheet picked up again), applied once the length is known. */
  readonly startPercent: number;
}

/** A player that hasn't started, on a sheet that already says they watched `percent` of it. */
export function watchStart(percent = 0): WatchState {
  return { furthest: 0, last: 0, duration: 0, startPercent: clampPercent(percent) };
}

const clampPercent = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : 0;

/**
 * One report from the player: it's at `seconds` of `duration`. The furthest point moves on only while they are
 * watching at the edge of what they've seen, so dragging ahead and playing from there doesn't count the part
 * they skipped.
 */
export function watchTick(state: WatchState, report: PlayerReport): WatchState {
  const duration =
    report.duration !== undefined && Number.isFinite(report.duration) && report.duration > 0
      ? report.duration
      : state.duration;
  const seconds =
    report.seconds !== undefined && Number.isFinite(report.seconds)
      ? Math.max(0, report.seconds)
      : state.last;
  let furthest = state.furthest;
  if (duration > 0 && state.duration === 0 && state.startPercent > 0)
    furthest = Math.max(furthest, (state.startPercent / 100) * duration);
  const atTheEdge = state.last <= furthest + WATCH_STEP_SECONDS;
  const playing = seconds >= state.last && seconds - state.last <= WATCH_STEP_SECONDS;
  if (seconds > furthest && atTheEdge && playing) furthest = seconds;
  return { furthest, last: seconds, duration, startPercent: state.startPercent };
}

/** How much of it they've watched, 0 to 100. The last second counts as the end, since players stop just short. */
export function watchedPercent(state: WatchState): number {
  if (state.duration <= 0) return state.startPercent;
  if (state.furthest >= state.duration - 1) return 100;
  return Math.max(state.startPercent, clampPercent((state.furthest / state.duration) * 100));
}

/** "Watched 80%", for a result, a timeline and the export. */
export const watchedWords = (percent: number): string =>
  percent >= 100 ? 'Watched it all' : percent <= 0 ? 'Didn’t watch' : `Watched ${percent}%`;

/** Why the Next button is waiting, in the words the page shows under the video. */
export function watchFirstWords(minPercent: number): string {
  return minPercent >= 100
    ? 'Watch the whole video to go on.'
    : `Watch at least ${minPercent}% of the video to go on.`;
}
