/**
 * A campaign email written in blocks (design tools, part 5): words, a picture, a button, a line and a space, in the
 * order they're in, each lined up on the left, in the centre or on the right, like a form's items. The blocks are kept
 * beside the email's plain words (`campaigns.email_body`), which are worked out from them for mail apps that show
 * text only, for the Assistant and for everything that already reads the body. Browser-safe.
 */
import { z } from 'zod';
import { ITEM_ALIGNS, PICTURE_SIZES } from '../forms/questions';
import { PictureRef } from '../look/pictures';

export const EMAIL_BLOCK_KINDS = ['words', 'picture', 'button', 'line', 'space'] as const;
export type EmailBlockKind = (typeof EMAIL_BLOCK_KINDS)[number];
export const EMAIL_BLOCK_NAMES: Readonly<Record<EmailBlockKind, string>> = {
  words: 'Words',
  picture: 'Picture',
  button: 'Button',
  line: 'Line',
  space: 'Space',
};

/** The most blocks one email has. */
export const EMAIL_BLOCKS_MAX = 40;
/** The most words one block of words has. */
export const EMAIL_BLOCK_WORDS_MAX = 4000;
export const EMAIL_BUTTON_LABEL_MAX = 40;

export const EMAIL_SPACE_SIZES = ['small', 'medium', 'large'] as const;
export type EmailSpaceSize = (typeof EMAIL_SPACE_SIZES)[number];
/** Each space's height in pixels. */
export const EMAIL_SPACE_PX: Readonly<Record<EmailSpaceSize, number>> = {
  small: 8,
  medium: 20,
  large: 40,
};

const id = z.string().trim().min(1).max(40);
const align = z.enum(ITEM_ALIGNS);
/** An address a button or picture opens: a web page, an email or a phone number. */
const link = z
  .string()
  .trim()
  .max(500)
  .regex(/^(https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+|tel:\+?[0-9-]+)$/i, {
    error: 'Type a web address that starts with https://.',
  });

export const EmailBlock = z.discriminatedUnion('kind', [
  z.object({
    id,
    kind: z.literal('words'),
    text: z
      .string()
      .trim()
      .min(1, 'Write something in this block, or take it out.')
      .max(EMAIL_BLOCK_WORDS_MAX),
    align: align.default('left'),
  }),
  z.object({
    id,
    kind: z.literal('picture'),
    /** From Your pictures. */
    picture: PictureRef,
    size: z.enum(PICTURE_SIZES).default('full'),
    align: align.default('center'),
    /** The line under it, also read out to people who can't see it; blank for none. */
    words: z.string().trim().max(200).default(''),
    /** What it opens when pressed; blank for nothing. */
    link: z.union([link, z.literal('')]).default(''),
  }),
  z.object({
    id,
    kind: z.literal('button'),
    label: z
      .string()
      .trim()
      .min(1, 'Give the button its words.')
      .max(EMAIL_BUTTON_LABEL_MAX, `Keep a button under ${EMAIL_BUTTON_LABEL_MAX} characters.`),
    url: link,
    align: align.default('left'),
  }),
  z.object({ id, kind: z.literal('line') }),
  z.object({ id, kind: z.literal('space'), size: z.enum(EMAIL_SPACE_SIZES).default('medium') }),
]);
export type EmailBlock = z.infer<typeof EmailBlock>;

export const EmailBlocks = z
  .array(EmailBlock)
  .min(1, 'Add something to the email.')
  .max(EMAIL_BLOCKS_MAX, `Keep an email to ${EMAIL_BLOCKS_MAX} blocks.`)
  .refine((blocks) => blocks.some((b) => b.kind === 'words' || b.kind === 'button'), {
    error: 'Add some words or a button: an email of only pictures often lands in spam.',
  });

/** The blocks kept on a campaign, read forgivingly: ones that don't parse are left out, none is null. */
export function emailBlocksOf(v: unknown): EmailBlock[] | null {
  if (!Array.isArray(v)) return null;
  const out: EmailBlock[] = [];
  for (const b of v.slice(0, EMAIL_BLOCKS_MAX)) {
    const r = EmailBlock.safeParse(b);
    if (r.success) out.push(r.data);
  }
  return out.length ? out : null;
}

/** A line the plain words draw for a Line block: never "--", which starts an email's small print. */
const LINE_TEXT = '———';

/**
 * The email's plain words from its blocks: what a mail app that shows text only shows, and what's kept as the body. A
 * button is "Its words: its address", which an automatic email draws as a button again.
 */
export function emailBlocksText(blocks: readonly EmailBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'words') parts.push(b.text);
    else if (b.kind === 'button') parts.push(`${b.label}: ${b.url}`);
    else if (b.kind === 'picture') {
      const lines = [b.words, b.link].filter(Boolean);
      if (lines.length) parts.push(lines.join('\n'));
    } else if (b.kind === 'line') parts.push(LINE_TEXT);
  }
  return parts.join('\n\n');
}

/** The blocks with each piece of words changed by `fill` (the person's first name, for one email). */
export const fillEmailBlocks = (
  blocks: readonly EmailBlock[],
  fill: (text: string) => string,
): EmailBlock[] =>
  blocks.map((b) =>
    b.kind === 'words'
      ? { ...b, text: fill(b.text) }
      : b.kind === 'button'
        ? { ...b, label: fill(b.label) }
        : b.kind === 'picture'
          ? { ...b, words: fill(b.words) }
          : b,
  );

/** A line an automatic email draws as a button: a few words, a colon, and a web address, alone on the line. */
export const EMAIL_BUTTON_LINE = /^([^:\n]*[\p{L}\p{N}][^:\n]*):\s+(https?:\/\/\S+)$/u;

/** The button a line of an automatic email stands for ("Pay your invoice: https://…"), or null when it isn't one. */
export function emailButtonOf(line: string): { label: string; url: string } | null {
  const m = EMAIL_BUTTON_LINE.exec(line.trim());
  if (!m || m[1]!.trim().length > EMAIL_BUTTON_LABEL_MAX) return null;
  return { label: m[1]!.trim(), url: m[2]! };
}

/**
 * Plain words made into blocks, to go on designing them: a block of words for each run of paragraphs, and a button
 * for each line that's one.
 */
export function emailBlocksFromText(text: string): EmailBlock[] {
  const out: EmailBlock[] = [];
  let words: string[] = [];
  const flush = () => {
    const t = words.join('\n').trim();
    if (t) out.push({ id: newEmailBlockId(out), kind: 'words', text: t, align: 'left' });
    words = [];
  };
  for (const line of text.trim().split('\n')) {
    const button = emailButtonOf(line);
    if (!button || button.url.length > 500) {
      words.push(line);
      continue;
    }
    flush();
    out.push({ id: newEmailBlockId(out), kind: 'button', ...button, align: 'left' });
  }
  flush();
  return out.slice(0, EMAIL_BLOCKS_MAX);
}

/** A new block's id: short, and different from the others in the email. */
export function newEmailBlockId(blocks: readonly { readonly id: string }[]): string {
  const taken = new Set(blocks.map((b) => b.id));
  for (let n = blocks.length + 1; ; n++) if (!taken.has(`b${n}`)) return `b${n}`;
}
