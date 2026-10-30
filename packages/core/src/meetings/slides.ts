/**
 * A live poll's slides in a HandsFreeOS video call (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 4): the
 * presenter's PDF, shown big on the stage one slide at a time, for everyone in the call.
 *
 * - **The team turns them** (`video_call.slide`), from the Live poll panel or the arrow keys.
 * - **The worker tells the room** each change on its own topic, from the server, so a page trusts it where it would
 *   ignore the same topic from a person. It carries a picture of the slide, and of the next one to fetch ahead, as
 *   links that work for a few hours. Someone who comes in later is told the slide that's up as they join.
 * - **Browser-safe**: the call's pages read the message with this file.
 */
import { z } from 'zod';
import { MAX_SLIDES } from '../forms/definition';

export const VIDEO_CALL_SLIDES_TOPIC = 'hfos.slides';
/** How long a slide's picture link works: longer than a webinar keeps one slide up. */
export const SLIDE_PICTURE_SECONDS = 6 * 3600;

/** A picture's link: storage's, over the web (plain http only on a laptop's own stack). */
const pictureLink = z.url({ protocol: /^https?$/ });

/** What the worker tells the room: the slide showing, with its picture, or that the slides came down. */
export const SlideMessage = z.object({
  t: z.literal('slide'),
  /** The slide showing, counted from 1; null when the slides came down. */
  slide: z.int().min(1).max(MAX_SLIDES).nullable(),
  /** How many slides there are. */
  of: z.int().min(0).max(MAX_SLIDES),
  /** The slide's picture; null with no slide. */
  picture: pictureLink.nullable(),
  /** The next slide's picture, fetched ahead so turning to it is instant; null at the end. */
  next: pictureLink.nullable(),
  /** When the slide changed: an older message never replaces a newer one. */
  at: z.iso.datetime(),
});
export type SlideMessage = z.infer<typeof SlideMessage>;

/** A message on the slides topic, or null for anything that isn't one. */
export function readSlideMessage(payload: Uint8Array | string): SlideMessage | null {
  try {
    const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
    const parsed = SlideMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The slide to turn to from `slide` with a key or a button, or null when there's nowhere to go. */
export function slideAfter(
  slide: number | null,
  of: number,
  step: 'next' | 'previous' | 'first' | 'last',
): number | null {
  if (of < 1) return null;
  const to =
    step === 'first'
      ? 1
      : step === 'last'
        ? of
        : slide === null
          ? 1
          : step === 'next'
            ? slide + 1
            : slide - 1;
  return to >= 1 && to <= of && to !== slide ? to : null;
}

export const SLIDE_WORDS = {
  /** The call. */
  slides: 'Slides',
  show: 'Show slides',
  stop: 'Stop showing slides',
  previous: 'Previous slide',
  next: 'Next slide',
  of: (n: number, of: number) => `Slide ${n} of ${of}`,
  count: (n: number) => (n === 1 ? '1 slide' : `${n} slides`),
  keys: 'The arrow keys turn them while the call has your attention.',
  loading: 'Getting the slide…',
  noSlides:
    'This poll has no slides. Add your presentation to it as a PDF in Forms, publish it, and you can show it here.',
  goesWith: 'It goes with the slide that just came up.',
  /** The forms editor. */
  title: 'Your slides',
  add: 'Add your slides',
  addHelp:
    'Your presentation as a PDF: save it as a PDF from PowerPoint, Keynote or Google Slides. You show it in the call, and the AI reads it to find each question’s moment.',
  replace: 'Replace',
  remove: 'Take them off',
  adding: 'Adding your slides…',
  readThem: 'Read the slides and write when to ask each question',
  readHelp:
    'The AI ties each question to the slide it goes with and writes when-to-ask phrases from what the slides say.',
  slide: 'Slide it goes with',
  anySlide: 'No slide in particular',
  tooMany: (n: number) =>
    `These slides have ${n} pages. A live poll’s slides can have up to ${MAX_SLIDES}. Save fewer pages as the PDF and add it again.`,
  notPdf: 'Slides are added as a PDF. Save your presentation as a PDF and add that.',
  unreadable: 'This PDF didn’t open. If it has a password, save a copy without one and add that.',
} as const;
