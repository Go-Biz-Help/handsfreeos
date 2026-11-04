/**
 * The business's video library (docs/outreach.md, decision 154; the owner, 4 Nov 2026: "with follow ups if they don't
 * book or miss the booking we can send different videos. we should have a video link library each with a description
 * of what they are so the ai knows what to send and when based on the conversation").
 *
 * The owner's picks (1a 2a 3a):
 *
 * - **One library for the whole business,** in Social Outreach → Settings → Videos, on the web and the phone. Each
 *   video is a name, a link (Loom, YouTube or Google Drive, checked as the playbook's was: ./video.ts) and what it
 *   shows and when it helps. Kept with the business's Social Outreach settings (`videos`), saved as the rest of them
 *   are (`addon.save_settings`), by owners and admins.
 * - **Where the AI may send one:** a follow-up after the demo ask when they haven't booked, the message after a missed
 *   demo, and a reply when a video answers what they asked. The AI picks by each video's words: at most one in a
 *   message, none when nothing fits, and never one they were sent before (their sent messages and chat are read for
 *   its link, and a draft that breaks either is dropped: `fitsVideos`).
 * - **The old video step is gone:** a yes to the first message gets the demo ask straight away (decision 153), and a
 *   playbook's short video moves into the library: until the library is first saved, it reads as the playbooks'
 *   videos (`libraryOf`). The playbook keeps its script, to record one from.
 *
 * Browser-safe: the web and the phone show the words and check a video before it's saved.
 */
import { z } from 'zod';
import { quoteData } from '../../knowledge/prompt';
import type { ConversationStep } from './conversation';
import { VIDEO_LINK_WORDS, VIDEO_LIMITS, VIDEO_WORDS } from './video';

export const LIBRARY_LIMITS = {
  /** Videos in the library. */
  videos: 20,
  /** A video's name. */
  name: 80,
  /** What it shows and when it helps. */
  about: 400,
} as const;

/** One video: its name, its link and what it shows and when it helps, which is what the AI picks it by. */
export const LibraryVideo = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: 'Give the video a short name, like “2-minute walkthrough”.' })
    .max(LIBRARY_LIMITS.name, {
      error: `That name is too long. Keep it under ${LIBRARY_LIMITS.name} characters.`,
    }),
  link: z
    .url({ protocol: /^https$/, hostname: z.regexes.domain, error: VIDEO_LINK_WORDS })
    .max(VIDEO_LIMITS.link, {
      error: 'That link is too long. Paste a shorter link to your video.',
    }),
  about: z
    .string()
    .trim()
    .min(1, {
      error: 'Say what the video shows and when it helps, so the AI knows when to send it.',
    })
    .max(LIBRARY_LIMITS.about, {
      error: `That’s too long. Say what it shows and when it helps in under ${LIBRARY_LIMITS.about} characters.`,
    }),
});
export type LibraryVideo = z.output<typeof LibraryVideo>;

/** The whole library: up to 20, each link once. */
export const VideoLibrary = z
  .array(LibraryVideo)
  .max(LIBRARY_LIMITS.videos, {
    error: `Your library holds ${LIBRARY_LIMITS.videos} videos. Remove one to add another.`,
  })
  .refine((videos) => new Set(videos.map((v) => v.link)).size === videos.length, {
    error: 'That video is in your library already. Change the one that’s there instead.',
  });
export type VideoLibrary = z.output<typeof VideoLibrary>;

/** What a playbook's short video says of itself once it's in the library (3a): what the old video step sent it for. */
export const FROM_PLAYBOOK_ABOUT =
  'The short video on how it works and how others got results. Good for someone who hasn’t booked yet and wants to see more first.';

/** A playbook as the library reads its short video: its name and the link it kept (data version 4). */
export interface PlaybookVideo {
  readonly name: string;
  readonly details: { readonly videoLink?: string | null };
}

/**
 * The library as it stands: the one saved, or, until it's first saved, the playbooks' short videos (3a), by playbook
 * name, each link once and as many as the library holds. Saving it from Settings → Videos keeps it as its own.
 */
export function libraryOf(
  saved: readonly LibraryVideo[] | null | undefined,
  playbooks: readonly PlaybookVideo[],
): LibraryVideo[] {
  if (saved) return [...saved];
  const seen = new Set<string>();
  const videos: LibraryVideo[] = [];
  for (const p of [...playbooks].sort((a, b) => a.name.localeCompare(b.name))) {
    const link = LibraryVideo.shape.link.safeParse(p.details.videoLink?.trim() ?? '');
    if (!link.success || seen.has(link.data)) continue;
    seen.add(link.data);
    videos.push({
      name: `${p.name}: short video`.slice(0, LIBRARY_LIMITS.name),
      link: link.data,
      about: FROM_PLAYBOOK_ABOUT,
    });
  }
  return videos.slice(0, LIBRARY_LIMITS.videos);
}

/** Whether the library shown is still the playbooks' videos, never saved as its own. */
export const fromPlaybooks = (saved: readonly LibraryVideo[] | null | undefined): boolean => !saved;

/** The draft kinds a video may go in (answer 2a), as ./today.ts names them. */
type VideoKind = 'follow_up' | 'rebook' | 'reply';
const VIDEO_KINDS: ReadonlySet<string> = new Set<VideoKind>(['follow_up', 'rebook', 'reply']);

/**
 * Whether a draft may carry a video (answer 2a): a follow-up after the demo ask (the link step) when they haven't
 * booked, the message after a missed demo, and a reply, when a video answers what they asked. Never to someone who
 * turned the offer down, nor in a message to their Requests, nor to a client.
 */
export function videoFits(
  kind: string,
  step: ConversationStep | null | undefined,
  held: { readonly declined: boolean; readonly requests: boolean },
): boolean {
  if (!VIDEO_KINDS.has(kind) || held.declined || held.requests) return false;
  return kind !== 'follow_up' || step === 'link';
}

/** The library's links found in what was sent them: the videos they've had. */
export function sentLinks(
  videos: readonly Pick<LibraryVideo, 'link'>[],
  texts: readonly (string | null | undefined)[],
): string[] {
  return videos
    .map((v) => v.link)
    .filter((link) => texts.some((t) => typeof t === 'string' && t.includes(link)));
}

/** What a draft is told of the library: the videos they haven't had. */
export interface DraftVideos {
  readonly videos: readonly LibraryVideo[];
  /** Links they were sent before, never sent again. */
  readonly sent: readonly string[];
}

/** The ask that goes with the videos. */
export const VIDEO_ASK =
  'Under <videos> are the owner’s videos, each with what it shows and when it helps. When one fits where the chat is and would help them decide (they haven’t booked, they missed the call, or it answers what they asked), you may put it in, with a short line on why it’s worth a look, and its link exactly as written. At most one video in a draft, and none when nothing fits: then write it without one.';

/** A draft's lines for the library (answer 2a): none when every video was sent them, or there are none. */
export function videoLines(library: DraftVideos | null | undefined): string[] {
  const left = (library?.videos ?? []).filter((v) => !library!.sent.includes(v.link));
  if (!left.length) return [];
  const list = left.map((v, i) => `${i + 1}. ${v.name}: ${v.about}\n   ${v.link}`).join('\n');
  return [`<videos>\n${quoteData(list)}\n</videos>`, VIDEO_ASK];
}

/**
 * Whether a draft keeps to the library's rules: at most one of its videos, and never one they've had. A draft that
 * doesn't is dropped, as one with the playbook's words to avoid is.
 */
export function fitsVideos(draft: string, library: DraftVideos | null | undefined): boolean {
  if (!library?.videos.length) return true;
  const links = library.videos.map((v) => v.link).filter((link) => draft.includes(link));
  return links.length <= 1 && !links.some((link) => library.sent.includes(link));
}

/** Settings → Videos' words, on the web and the phone. */
export const VIDEO_LIBRARY_WORDS = {
  title: 'Videos',
  /** Under Owners in the menu. */
  row: 'Your video library',
  about:
    'Videos the AI can send when someone hasn’t booked, missed their demo, or asks something a video answers. Say what each one shows and when it helps: the AI picks by that, one at a time, and never sends anyone the same one twice.',
  none: 'No videos yet. Add one, and the AI starts sending it where it fits.',
  /** Until the library is saved, it's the playbooks' short videos (3a). */
  fromPlaybooks:
    'These came from your playbooks’ short videos. Change them or remove any, and the library is yours from then on.',
  add: 'Add a video',
  name: 'Name',
  namePlaceholder: '2-minute walkthrough',
  link: 'Link',
  linkHint: VIDEO_WORDS.linkHint,
  linkPlaceholder: VIDEO_WORDS.linkPlaceholder,
  aboutLabel: 'What it shows and when to send it',
  aboutHint:
    'The AI reads this to pick the video, so say who it’s for and when it helps: “A quick tour of the CRM, for someone who hasn’t booked and wants to see it first.”',
  aboutPlaceholder:
    'A quick tour of the CRM, for someone who hasn’t booked and wants to see it first.',
  save: 'Save video',
  cancel: 'Cancel',
  change: 'Change',
  remove: 'Remove',
  /** The library is full. */
  full: `Your library holds ${LIBRARY_LIMITS.videos} videos. Remove one to add another.`,
  /** How many, beside the title. */
  count: (n: number) => `${n.toLocaleString('en-US')} of ${LIBRARY_LIMITS.videos}`,
  /** The playbook's script, to record a video from. */
  fromScript: 'Need one? Each playbook can write a script for a short video, under Short video.',
  /** On a playbook's Short video step, where its link was. */
  onPlaybook:
    'Recorded it? Add it to your video library in Settings → Videos, with a line on what it shows, so the AI knows when to send it.',
  open: 'Open your video library',
  /** Only owners and admins change it. */
  ownersOnly: 'Only owners and admins change the video library.',
} as const;

/**
 * Why a video would be refused, in the save's own words, before it's sent (the web's and the phone's form): its
 * first problem, or null when it passes.
 */
export function libraryVideoProblem(
  video: { readonly name: string; readonly link: string; readonly about: string },
  others: readonly Pick<LibraryVideo, 'link'>[],
): string | null {
  const checked = LibraryVideo.safeParse(video);
  if (!checked.success) return checked.error.issues[0]?.message ?? VIDEO_LINK_WORDS;
  if (others.some((o) => o.link === checked.data.link))
    return 'That video is in your library already. Change the one that’s there instead.';
  return null;
}
