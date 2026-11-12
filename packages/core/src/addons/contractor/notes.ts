/**
 * Notes from the field (docs/contractor.md, "On the phone"): what a tech says about a job, or about one of its
 * visits, while they're there: typed, a recording, or photos. A recording's words follow on their own once it
 * reaches HandsFreeOS. One copy of what a note may hold and how it reads in a line, which the server keeps and both
 * apps and the AI read. Pure and browser-safe.
 */

/** Where a recording's words stand: there's no recording, they're on their way, they're here, or they couldn't be made. */
export const TRANSCRIPT_STATES = ['none', 'waiting', 'done', 'failed'] as const;
export type TranscriptState = (typeof TRANSCRIPT_STATES)[number];

export const NOTE_LIMITS = {
  body: 4000,
  /** Photos on one note. */
  photos: 20,
  transcript: 20_000,
  /** Notes one job's list answers, the newest first. */
  list: 300,
} as const;

/** What a note holds, as far as saying it in a line needs. */
export interface NoteParts {
  readonly body: string | null;
  /** It has, or had, a recording. */
  readonly spoken: boolean;
  readonly transcript: string | null;
  readonly transcriptState: TranscriptState;
  readonly photos: number;
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

export const photosWords = (n: number) => `${n} ${n === 1 ? 'photo' : 'photos'}`;

/**
 * A note in one line, for a list, a timeline or the AI: what was typed, else what was said (or that its words are on
 * their way), with how many photos came with it.
 */
export function noteLine(n: NoteParts, max = 140): string {
  const said = n.body ?? (n.spoken ? n.transcript : null);
  const photos = n.photos ? photosWords(n.photos) : null;
  if (said) return photos ? `${clip(said, max)} (${photos})` : clip(said, max);
  if (n.spoken) {
    const voice =
      n.transcriptState === 'waiting' ? 'Voice note, its words are on their way' : 'Voice note';
    return photos ? `${voice} (${photos})` : voice;
  }
  return photos ? photos[0]!.toUpperCase() + photos.slice(1) : 'Note';
}

/** What a note's addition says on the job's timeline: never the recording, only that there was one. */
export function noteAddedWords(n: Pick<NoteParts, 'body' | 'spoken' | 'photos'>): string {
  const parts: string[] = [];
  if (n.body) parts.push(`a note: “${clip(n.body, 200)}”`);
  else if (n.spoken) parts.push('a voice note');
  if (n.photos)
    parts.push(n.body || n.spoken ? `with ${photosWords(n.photos)}` : photosWords(n.photos));
  return `added ${parts.join(' ') || 'a note'}`;
}
