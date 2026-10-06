/**
 * Facebook Messenger and Instagram direct messages (20261025000200): the rules and words the web, the phone, the API
 * and the worker share. Browser-safe.
 *
 * Both reach the business through Meta, one app for both, and answer through the business's Facebook Page (an
 * Instagram professional account is linked to one). What they don't share is limits: Instagram takes shorter
 * messages and smaller photos, and has no delivery receipts, only "Seen".
 */
import { messagePreview } from './sms';

export const SOCIAL_CHANNELS = ['messenger', 'instagram'] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];
/** Where the account lives: a Facebook Page answers Messenger, an Instagram account answers Instagram. */
export type MetaPlatform = 'facebook' | 'instagram';

export const isSocialChannel = (channel: string | null | undefined): channel is SocialChannel =>
  channel === 'messenger' || channel === 'instagram';

export const platformOfChannel = (channel: SocialChannel): MetaPlatform =>
  channel === 'messenger' ? 'facebook' : 'instagram';
export const channelOfPlatform = (platform: MetaPlatform): SocialChannel =>
  platform === 'facebook' ? 'messenger' : 'instagram';

/** What each is called on a screen. */
export const SOCIAL_CHANNEL_NAMES: Readonly<Record<SocialChannel, string>> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
};
export const META_PLATFORM_NAMES: Readonly<Record<MetaPlatform, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};

/** What the screens call a Page or account: "Bright Plumbing" (a Page), "@brightplumbing" (an Instagram account). */
export const metaAccountLabel = (a: {
  readonly platform: MetaPlatform;
  readonly name: string;
  readonly username?: string | null;
}): string =>
  a.platform === 'instagram' && a.username ? `@${a.username.replace(/^@/, '')}` : a.name;

/** Somebody Meta won't name (their privacy settings): what the inbox calls them until they say. */
export const SOCIAL_CONTACT_NAMES: Readonly<Record<SocialChannel, string>> = {
  messenger: 'Facebook user',
  instagram: 'Instagram user',
};

/** How a customer is named in a Messenger or Instagram thread: their name, their @handle, or who they are to us. */
export function socialContactName(
  channel: SocialChannel,
  contact: { readonly name?: string | null; readonly username?: string | null } | null | undefined,
): string {
  const name = contact?.name?.trim();
  if (name) return name;
  const handle = contact?.username?.trim();
  if (handle) return `@${handle.replace(/^@/, '')}`;
  return SOCIAL_CONTACT_NAMES[channel];
}

const ID = /^[0-9]{1,40}$/;
const SCOPED = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * A thread's counterpart: `messenger:<page id>:<their id>`, `instagram:<account id>:<their id>`. Their id only means
 * something to that Page or account, so the account is part of who they are.
 */
export function socialCounterpart(
  channel: SocialChannel,
  accountExternalId: string,
  scopedId: string,
): string {
  if (!ID.test(accountExternalId) || !SCOPED.test(scopedId))
    throw new Error('Not a Meta account id and page-scoped id');
  return `${channel}:${accountExternalId}:${scopedId}`;
}

export function socialCounterpartParts(counterpart: string): {
  readonly channel: SocialChannel;
  readonly accountExternalId: string;
  readonly scopedId: string;
} | null {
  const [channel, account, scoped, ...rest] = counterpart.split(':');
  if (rest.length || !isSocialChannel(channel) || !account || !scoped) return null;
  if (!ID.test(account) || !SCOPED.test(scoped)) return null;
  return { channel, accountExternalId: account, scopedId: scoped };
}

// ------------------------------------------------------------------------------------------------- the reply window

/** Meta lets a business answer for a day after the customer last wrote. */
export const SOCIAL_REPLY_WINDOW_MS = 24 * 3_600_000;
/** With the Human Agent tag (approved by Meta for the app), a person may answer for seven. */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 3_600_000;

export interface SocialReplyWindow {
  /** Anybody may reply: the customer wrote within a day. */
  readonly open: boolean;
  /** Only a person may reply, with the Human Agent tag: more than a day, less than seven. */
  readonly peopleOnly: boolean;
  /** When the window that's open now closes. Null when it's closed, or nothing was ever written. */
  readonly closesAt: string | null;
}

/**
 * Whether a reply can go now. The window runs from the customer's last message, whatever the business sent since,
 * because that is how Meta counts it.
 */
export function socialReplyWindow(
  lastInboundAt: string | Date | null | undefined,
  humanAgent: boolean,
  now: number = Date.now(),
): SocialReplyWindow {
  const at = lastInboundAt ? new Date(lastInboundAt).getTime() : NaN;
  if (!Number.isFinite(at)) return { open: false, peopleOnly: false, closesAt: null };
  if (now < at + SOCIAL_REPLY_WINDOW_MS)
    return {
      open: true,
      peopleOnly: false,
      closesAt: new Date(at + SOCIAL_REPLY_WINDOW_MS).toISOString(),
    };
  if (humanAgent && now < at + HUMAN_AGENT_WINDOW_MS)
    return {
      open: false,
      peopleOnly: true,
      closesAt: new Date(at + HUMAN_AGENT_WINDOW_MS).toISOString(),
    };
  return { open: false, peopleOnly: false, closesAt: null };
}

// ---------------------------------------------------------------------------------------------- what a reply takes

/** The most words one message carries. */
export const SOCIAL_TEXT_LIMITS: Readonly<Record<SocialChannel, number>> = {
  messenger: 2000,
  instagram: 1000,
};

/** How many photos or files one reply may carry: each goes as a message of its own, before the words. */
export const SOCIAL_MAX_ATTACHMENTS = 5;

export type SocialAttachmentKind = 'image' | 'video' | 'audio' | 'file';

const MB = 1024 * 1024;
/** The types Meta delivers, and how big each may be, per channel. */
const ATTACHMENT_RULES: Readonly<
  Record<
    SocialChannel,
    Readonly<Record<SocialAttachmentKind, { types: readonly string[]; maxBytes: number }>>
  >
> = {
  messenger: {
    image: { types: ['image/jpeg', 'image/png', 'image/gif'], maxBytes: 25 * MB },
    video: { types: ['video/mp4', 'video/quicktime'], maxBytes: 25 * MB },
    audio: {
      types: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav'],
      maxBytes: 25 * MB,
    },
    file: { types: ['application/pdf'], maxBytes: 25 * MB },
  },
  instagram: {
    image: { types: ['image/jpeg', 'image/png'], maxBytes: 8 * MB },
    video: { types: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 25 * MB },
    audio: { types: ['audio/aac', 'audio/mp4', 'audio/wav', 'audio/x-wav'], maxBytes: 25 * MB },
    file: { types: ['application/pdf'], maxBytes: 25 * MB },
  },
};

/** What Meta calls a file of this type when it's sent, or null when this channel won't carry it. */
export function socialAttachmentKind(
  channel: SocialChannel,
  mimeType: string | null | undefined,
): SocialAttachmentKind | null {
  const type = (mimeType ?? '').toLowerCase();
  for (const [kind, rule] of Object.entries(ATTACHMENT_RULES[channel]))
    if (rule.types.includes(type)) return kind as SocialAttachmentKind;
  return null;
}

/** The most a file of this kind may weigh on this channel. */
export const socialAttachmentMaxBytes = (
  channel: SocialChannel,
  kind: SocialAttachmentKind,
): number => ATTACHMENT_RULES[channel][kind].maxBytes;

/** A file picker's `accept` for a reply on this channel: every type it carries. */
export const socialAttachmentAccept = (channel: SocialChannel): string =>
  Object.values(ATTACHMENT_RULES[channel])
    .flatMap((rule) => rule.types)
    .join(',');

/** "JPG, PNG or GIF photos, MP4 videos, …": what a refusal says this channel takes. */
export function socialAttachmentTypesWords(channel: SocialChannel): string {
  return channel === 'messenger'
    ? 'JPG, PNG or GIF photos, MP4 or MOV videos, MP3, M4A or WAV recordings, and PDFs'
    : 'JPG or PNG photos, MP4, MOV or WEBM videos, M4A or WAV recordings, and PDFs';
}

// ---------------------------------------------------------------------------------------------------------- words

/**
 * What a thread shows for something the customer sent that isn't words or a file we keep: a post they shared, a
 * story that mentioned the business, a sticker. Meta's own links to these stop working, so a line says what it was.
 */
export const SOCIAL_SHARED_WORDS: Readonly<Record<string, string>> = {
  share: 'Shared a post',
  ig_post: 'Shared a post',
  ig_reel: 'Shared a reel',
  reel: 'Shared a reel',
  story_mention: 'Mentioned you in their story',
  story_reply: 'Replied to your story',
  sticker: 'Sent a sticker',
  like_heart: 'Sent a heart',
  location: 'Shared a location',
  template: 'Sent a card',
  fallback: 'Shared a link',
  unsupported: 'Sent something Instagram doesn’t share with apps. Open Instagram to see it.',
  audio: 'Sent a voice message',
  video: 'Sent a video',
  image: 'Sent a photo',
  file: 'Sent a file',
};

/**
 * What a conversation's list shows for a Messenger or Instagram message: its words, or what it carried when it had
 * none ("Sent 3 photos", "Shared a reel"). `kinds` are Meta's types, files first, as the message keeps them.
 */
export function socialPreview(text: string | null | undefined, kinds: readonly string[]): string {
  const words = messagePreview(text, 0);
  if (words || kinds.length === 0) return words;
  const photos = kinds.filter((k) => k === 'image').length;
  if (photos > 1 && photos === kinds.length) return `Sent ${photos} photos`;
  return SOCIAL_SHARED_WORDS[kinds[0]!] ?? 'Sent something';
}

/** Where a reply sent outside HandsFreeOS was written, under it in the thread. */
export const SOCIAL_SENT_ELSEWHERE: Readonly<Record<SocialChannel, string>> = {
  messenger: 'Sent from Facebook',
  instagram: 'Sent from Instagram',
};

/** The thread's own line about the window, for the composer. */
export function socialWindowNote(
  channel: SocialChannel,
  window: SocialReplyWindow,
  who: string,
): string | null {
  const name = SOCIAL_CHANNEL_NAMES[channel];
  if (window.open) return null;
  if (window.peopleOnly)
    return `${who} last wrote more than a day ago. You can still answer them yourself on ${name} until ${shortWhen(window.closesAt)}, but the AI teammate and workflows can’t.`;
  return `${who} last wrote more than a day ago, and ${name} only lets a business answer within a day of the customer’s last message. You can reply as soon as they write again.`;
}

/** "Tue 3:40 PM", in the viewer's own time. */
const shortWhen = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'later';
