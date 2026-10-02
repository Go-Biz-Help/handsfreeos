/**
 * Asking a customer for a file (20261018000400): a qualifying question they answer by sending something, like a photo
 * or PDF of their electric bill. The AI teammate texts them a link (a video link that asks for a file instead), or
 * they text or email it back; either way it lands on the lead's Files and answers the question.
 *
 * What the web, the phone and the worker all need to agree on lives here: the kinds of file, the limits and the
 * words.
 */
import { videoSize } from './video-link';

/** A link lasts a week, as a video link does. */
export const FILE_LINK_DAYS = 7;
/** It takes five files: a bill photographed a page at a time fits. */
export const FILE_LINK_MAX_UPLOADS = 5;
/** 25 MB each: the `attachments` bucket's own limit, where every file ends up. */
export const FILE_LINK_MAX_BYTES = 25 * 1024 * 1024;
/** The most files one message can put on a lead. */
export const FILE_ANSWER_MAX_FILES = 5;

/**
 * The files that answer a file question, and their extensions: photos and PDFs, the ones the `attachments` bucket
 * takes (20260912000400). A photo a phone takes, or a bill a utility emails, is one of these.
 */
export const FILE_ANSWER_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

/** What the customer's page offers to pick from. */
export const FILE_LINK_ACCEPT = 'image/*,application/pdf';

export const isFileAnswerType = (contentType: string | null | undefined): boolean =>
  !!contentType && contentType.split(';')[0]!.trim().toLowerCase() in FILE_ANSWER_TYPES;

/**
 * The answer a file question keeps, in words: “Sent “bill.pdf””, or “Sent 3 files: “a.jpg”, “b.jpg” and “c.pdf””.
 * The files themselves are on the lead.
 */
export function fileAnswerWords(names: readonly string[]): string {
  const quoted = names.map((n) => `“${n}”`);
  if (quoted.length <= 1) return `Sent ${quoted[0] ?? 'a file'}`;
  const list = `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
  const text = `Sent ${quoted.length} files: ${list}`;
  return text.length <= 500 ? text : `Sent ${quoted.length} files`;
}

export const FILE_LINK_WORDS = {
  /** What the thread and the conversation list say for one. */
  preview: 'Sent a file',
  /** Under a file that came this way. */
  cameByLink: 'Sent with your file link',

  // ---- the customer's page ----
  heading: (business: string) => `Send ${business} a file`,
  /** The question it answers, as it was asked ("Your latest electric bill" gets its full stop). */
  intro: (ask: string) => {
    const a = ask.trim();
    if (!a) return 'Send a photo or a PDF.';
    return `${/[.?!…][”"’)]?$/.test(a) ? a : `${a}.`} Send a photo or a PDF.`;
  },
  choose: 'Choose a photo or PDF',
  note: 'Up to 25 MB each. Keep this page open until it says Sent.',
  sending: (percent: number) => `Sending… ${percent}%`,
  sent: (business: string) => `Sent. ${business} has your file.`,
  another: 'Send another',

  // ---- what goes wrong, and what to do ----
  full: (business: string, max: number) =>
    `You’ve sent ${max} files with this link, which is all it takes. To send more, ask ${business} for a new link.`,
  tooLarge: (size: string) =>
    `That file is ${size}, and this link takes 25 MB at most. Take a photo of it instead, or send a smaller PDF.`,
  notAFile: (name: string) =>
    `“${name}” isn’t a photo or a PDF. Pick a photo of it, take one now, or pick a PDF.`,

  // ---- for the team and the AI teammate ----
  notAFileQuestion: (question: string) =>
    `“${question}” isn’t a question that asks for a file. Change it to a file question in AI teammate → Qualify first.`,
  questionGone:
    'That question isn’t in the AI teammate’s qualifying questions anymore. Refresh to see the current ones.',
  nothingToSave:
    'That message has no photo or PDF to save. Ask them to send it with the link, or to text a photo of it.',
} as const;

/** "180 MB", "900 KB": the size of a file the way a person reads it. */
export const fileSize = videoSize;
