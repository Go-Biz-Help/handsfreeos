/**
 * Asking a customer for a video (20261018000200). MMS squeezes a texted video to almost nothing, so the team texts
 * a link instead: the customer opens it signed out, picks or records a video, and it goes up as it is. Each video
 * lands in the conversation as their reply.
 *
 * What the web, the phone and the worker all need to agree on lives here: the limits, the address, and the words.
 */

/** A link lasts a week. */
export const VIDEO_LINK_DAYS = 7;
/** It takes three videos. */
export const VIDEO_LINK_MAX_UPLOADS = 3;
/** And hands out at most this many uploads, finished or not, so it can't be used to fill storage. */
export const VIDEO_LINK_MAX_STARTS = 10;
/** 250 MB: two or three minutes of a phone's full-quality video. The `telephony` bucket's limit too. */
export const VIDEO_LINK_MAX_BYTES = 250 * 1024 * 1024;

/** The kinds of file a phone's camera or library hands over, and their extensions. */
export const VIDEO_LINK_TYPES: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/x-m4v': 'm4v',
};

/** Where the customer opens it, on the app's own address. */
export const videoLinkPath = (token: string): string => `/v/${token}`;

/** The size of a file the way a person reads it: "180 MB", "900 KB". */
export function videoSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const VIDEO_LINK_WORDS = {
  /** In the reply box, on the web and the phone. */
  button: 'Ask for a video',
  /** What the button puts in the reply box, for the person to send. */
  ask: (url: string) => `Can you send us a video? Use this link so it comes through clear: ${url}`,
  /** What the thread and the conversation list say for one. */
  preview: 'Sent a video',
  /** Under a video that came this way. */
  cameByLink: 'Sent with your video link',

  // ---- the customer's page ----
  heading: (business: string) => `Send ${business} a video`,
  intro: 'Texted videos arrive blurry. This link sends yours at full quality.',
  choose: 'Choose or record a video',
  note: 'Up to 250 MB. Keep this page open until it says Sent.',
  sending: (percent: number) => `Sending… ${percent}%`,
  sent: (business: string) => `Sent. ${business} has your video.`,
  another: 'Send another',
  tryAgain: 'Try again',

  // ---- what goes wrong, and what to do ----
  notFound:
    'This video link doesn’t work. Check you have the whole link, or ask the business that sent it for a new one.',
  expired: (business: string, date: string) =>
    `This link ran out on ${date}. Ask ${business} to send you a new one.`,
  full: (business: string, max: number) =>
    `You’ve sent ${max} videos with this link, which is all it takes. To send more, ask ${business} for a new link.`,
  tooLarge: (size: string) =>
    `That video is ${size}, and this link takes 250 MB at most. Trim it in your Photos app, or send a shorter one.`,
  notAVideo: (name: string) => `“${name}” isn’t a video. Pick a video, or record one.`,
  tooManyTries: (business: string) =>
    `This link has started too many uploads that didn’t finish. Ask ${business} for a new one.`,
  stopped: 'The upload stopped. Check your signal, then tap Try again.',
  notArrived: 'Your video didn’t arrive. Tap Try again to send it again.',
  /** For the team, in the reply box. */
  notByText: (thread: 'a website chat' | 'an email thread') =>
    `This conversation is ${thread}, and video links go by text. Open the customer’s texts to ask for a video.`,
  optedOut: (name: string) =>
    `${name} texted STOP, so no texts can go to them. They have to text START before you can ask for a video.`,
  needsSignal: 'Asking for a video needs signal. Try again when you’re back online.',
} as const;
