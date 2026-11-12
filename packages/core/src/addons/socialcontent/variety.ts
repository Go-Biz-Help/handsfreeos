/**
 * Variety on the calendar (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decisions 34 to 37; docs/socialcontent.md,
 * "Variety"). On 12 Nov 2026 nearly every post on the owner's calendar said the same thing: its ideas had run out, so
 * each post was written alone from the same Playbook and the offer's first line. The owner picked 1a 2a 3a 4a:
 *
 * - **A topic for each post** (decision 34): each takes its own line from the main offer's lists for content, the
 *   lists taking turns and the line used longest ago first, and the AI sees the business's last posts so it never
 *   repeats a hook.
 * - **Ideas refill on their own** (decision 35): 10 more whenever fewer than 5 wait, each planned here as a kind and a
 *   line before the AI writes it.
 * - **A set weekly mix** (decision 36): of every 10 posts, about 4 teach a tip, 2 show a customer's problem, 2 tell a
 *   story or show behind the scenes, and 2 are about the offer with an ask; never the same kind twice in a row.
 * - **The drafts written again** (decision 37): the AI's drafts from before, written over with the new variety on the
 *   same days and times (the worker, apps/worker/src/addons/socialcontent/content.ts).
 *
 * Its pictures vary too (decision 39, the owner's ask of 12 Nov: "the designs always look the same"): about half the
 * posts with pictures are carousels and half single pictures, words alone now and then on Facebook and LinkedIn, and
 * about 3 in 10 have a photo OpenAI makes under the words, never two in a row.
 *
 * Browser-safe and pure: the worker plans with it, and the tests hold it.
 */
import type { MainOfferLists, OfferList } from '../../main-offer/lists';

/** The kinds of post in the mix (decision 36). */
export const ANGLES = ['tip', 'problem', 'story', 'offer'] as const;
export type Angle = (typeof ANGLES)[number];
export const isAngle = (v: unknown): v is Angle =>
  typeof v === 'string' && (ANGLES as readonly string[]).includes(v);

/** How many of every 10 posts are each kind (the owner's pick 3a). */
export const MIX: Readonly<Record<Angle, number>> = { tip: 4, problem: 2, story: 2, offer: 2 };
const MIX_OF = 10;

export const VARIETY = {
  /** The business's last posts the AI sees, so it never repeats a hook (pick 1a). */
  recentShown: 20,
  /** Topics looked back over, so a line comes round again only after the others. */
  topicsRemembered: 60,
  /** Ideas get more on their own when fewer than this many wait, this many at a time (pick 2a). */
  ideasBelow: 5,
  ideasAdded: 10,
  /** The AI's drafts from before written again in one run of the calendar (pick 4a). */
  rewritePerRun: 5,
} as const;

/** The lists each kind takes its topic from, in turn (decision 34). */
export const ANGLE_LISTS: Readonly<Record<Angle, readonly OfferList[]>> = {
  tip: ['topics', 'questions', 'myths'],
  problem: ['problems', 'questions', 'beforeAfter'],
  story: ['story', 'beforeAfter'],
  offer: ['different', 'benefits'],
};

/** What the AI is told each kind of post does. */
export const ANGLE_FOR_AI: Readonly<Record<Angle, string>> = {
  tip: 'Teach one useful tip, how-to or truth (a myth set straight) people can use today. Give the value in the post itself. Mention the offer lightly, if at all.',
  problem:
    'Show one problem the business’s customers have, in their words: what it looks like, why it hurts, and a way out. The post is about the problem, not a sales pitch.',
  story:
    'Tell a short, real story or show behind the scenes: why the business started, something it learned, a day in its work, or a customer’s before and after. Never invent a result.',
  offer:
    'Make the case for the main offer: one thing that makes it different or one thing it gives the customer, and end with a clear ask from “What to ask people to do”.',
};

/** What each kind is called on the page and to the Assistant. */
export const ANGLE_LABELS: Readonly<Record<Angle, string>> = {
  tip: 'Tip',
  problem: 'Customer problem',
  story: 'Story',
  offer: 'Offer',
};

/** A line from one of the lists for content: what a post or an idea is about. */
export interface Topic {
  readonly list: OfferList;
  readonly line: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The next `n` kinds, after the kinds of the posts before (most recent first): each the kind furthest behind its share
 * of the last 10, and never the same as the one just before. From nothing, the first 10 are
 * tip, problem, story, offer, tip, problem, tip, story, offer, tip.
 */
export function nextAngles(recent: readonly (string | null)[], n: number): Angle[] {
  const before = recent.filter(isAngle).slice(0, MIX_OF - 1);
  const out: Angle[] = [];
  for (let k = 0; k < n; k++) {
    const window = [...[...out].reverse(), ...before].slice(0, MIX_OF - 1);
    const last = window[0];
    let best: Angle = ANGLES[0];
    let bestNeed = -Infinity;
    for (const a of ANGLES) {
      if (a === last) continue;
      const had = window.filter((w) => w === a).length;
      const need = (MIX[a] * (window.length + 1)) / MIX_OF - had;
      if (need > bestNeed + 1e-9) {
        best = a;
        bestNeed = need;
      }
    }
    out.push(best);
  }
  return out;
}

/**
 * The topic for a post of this kind (decision 34): from the kind's lists, the one used longest ago (or never) goes
 * next, skipping lists whose lines were all used lately while another has a fresh one, and from it the line used
 * longest ago. `used` is the topics of the posts and ideas before, most recent first.
 * Null when none of the kind's lists has a line.
 */
export function pickTopic(
  angle: Angle,
  lists: MainOfferLists,
  used: readonly Topic[],
): Topic | null {
  const options = ANGLE_LISTS[angle].filter((l) => (lists[l] ?? []).some((s) => s.trim()));
  if (!options.length) return null;
  const listAgo = (l: OfferList) => {
    const i = used.findIndex((u) => u.list === l);
    return i < 0 ? Infinity : i;
  };
  const lineAgo = (s: string) => {
    const i = used.findIndex((u) => same(u.line, s));
    return i < 0 ? Infinity : i;
  };
  // A list with a line not used lately goes before one whose lines all were, so a line isn't said again too soon.
  const fresh = (l: OfferList) => (lists[l] ?? []).some((s) => s.trim() && lineAgo(s) === Infinity);
  const ready = options.some(fresh) ? options.filter(fresh) : options;
  let list = ready[0]!;
  for (const l of ready) if (listAgo(l) > listAgo(list)) list = l;
  const lines = (lists[list] ?? []).filter((s) => s.trim());
  let line = lines[0]!;
  for (const s of lines) if (lineAgo(s) > lineAgo(line)) line = s;
  return { list, line: line.trim() };
}

/** What's known about a post before, for the mix and the topics: its kind, its topic, and whether it used a fact. */
export interface PostBefore {
  readonly angle: string | null;
  readonly topic: Topic | null;
  /** Written from news or a fact found online (decision 38). */
  readonly fact?: boolean;
  /** How it's shown (decision 39): its format, and whether its picture has a photo under the words. */
  readonly format?: string | null;
  readonly photo?: boolean;
}

// ------------------------------------------------------------------------------------------------ looks

/**
 * How a post is shown (decision 39): a carousel, one picture, or words alone, and whether its picture has a photo
 * OpenAI makes under the words, like a picture the owner put together in Canva.
 */
export interface Look {
  readonly format: 'carousel' | 'photo' | 'text';
  readonly photo: boolean;
}

export const LOOKS = {
  /** Of every 10 posts with pictures, about this many are carousels and the rest single pictures (pick 8a). */
  carousels: 5,
  /** Of every 10 posts with pictures, about this many have a photo under the words, never two in a row (pick 6a). */
  photos: 3,
  /** Words alone at most once in this many posts, on the networks that take them (pick 8a). */
  textEvery: 10,
} as const;

/** The networks where a post can be words alone. */
const TEXT_NETWORKS: readonly string[] = ['facebook', 'linkedin'];

/**
 * The next post's look, after the posts before (most recent first): words alone on Facebook or LinkedIn when none of
 * the last 9 posts was; otherwise a carousel or one picture, whichever is behind its half of the last 10 posts with
 * pictures (a carousel first), and a photo under the words when photos are behind their 3 in 10 and the post before
 * had none. `photos` is false when OpenAI's image model isn't set up.
 */
export function nextLook(before: readonly PostBefore[], network: string, photos: boolean): Look {
  const known = before.filter(
    (b) => b.format === 'carousel' || b.format === 'photo' || b.format === 'text',
  );
  if (
    TEXT_NETWORKS.includes(network) &&
    !known.slice(0, LOOKS.textEvery - 1).some((b) => b.format === 'text')
  )
    return { format: 'text', photo: false };
  const pics = known.filter((b) => b.format !== 'text').slice(0, MIX_OF - 1);
  const share = (want: number, had: number) => (want * (pics.length + 1)) / MIX_OF - had;
  const carousels = pics.filter((b) => b.format === 'carousel').length;
  const format = share(LOOKS.carousels, carousels) >= 0.5 - 1e-9 ? 'carousel' : 'photo';
  const withPhoto = pics.filter((b) => b.photo).length;
  const photo = photos && pics[0]?.photo !== true && share(LOOKS.photos, withPhoto) >= 0.5 - 1e-9;
  return { format, photo };
}

/**
 * The kinds and topics of the next `n` ideas (decision 35), after the posts before and the ideas already waiting
 * (both most recent first): the AI writes one idea for each.
 */
export function planIdeas(
  n: number,
  before: readonly PostBefore[],
  lists: MainOfferLists,
): { angle: Angle; topic: Topic | null }[] {
  const history = [...before];
  const out: { angle: Angle; topic: Topic | null }[] = [];
  for (let k = 0; k < n; k++) {
    const [angle] = nextAngles(
      history.map((h) => h.angle),
      1,
    ) as [Angle];
    const topic = pickTopic(
      angle,
      lists,
      history.flatMap((h) => (h.topic ? [h.topic] : [])).slice(0, VARIETY.topicsRemembered),
    );
    out.push({ angle, topic });
    history.unshift({ angle, topic });
  }
  return out;
}

/** An idea waiting to be written, as the plan sees it. */
export interface IdeaToPlan {
  readonly id: string;
  readonly network: string | null;
  readonly angle: string | null;
  readonly topic: Topic | null;
  /** Saved by a person: it goes first. */
  readonly saved: boolean;
  /** News or a fact found online, with its page (decision 38): every other tip is one, when one waits. */
  readonly fact?: boolean;
}

export interface PlannedWrite<S> {
  readonly slot: S;
  readonly angle: Angle;
  readonly ideaId: string | null;
  readonly topic: Topic | null;
  /** How it's shown (decision 39). */
  readonly look: Look;
}

/**
 * What each open place on the calendar is written from (decisions 34 to 36), in the slots' order. A saved idea that
 * fits the network goes first, whatever its kind. Otherwise the slot takes the kind the mix needs next, and then a
 * waiting idea of that kind for its network, else a line from the lists for that kind, else an older idea with no
 * kind, else nothing but the kind (the Playbook and the business's profile alone). Every other tip is news or a fact
 * found online when one waits, so 2 of each 10 posts are (decision 38); the tips between take a fact only when
 * nothing else is left. Each takes the next look too (decision 39); `photos` is false without OpenAI's image model.
 */
export function planWrites<S extends { readonly network: string }>(input: {
  readonly slots: readonly S[];
  readonly before: readonly PostBefore[];
  readonly ideas: readonly IdeaToPlan[];
  readonly lists: MainOfferLists;
  readonly photos?: boolean;
}): PlannedWrite<S>[] {
  const history = [...input.before];
  const ideas = [...input.ideas];
  const fits = (i: IdeaToPlan, network: string) => i.network === null || i.network === network;
  const take = (at: number) => (at >= 0 ? ideas.splice(at, 1)[0]! : null);
  const out: PlannedWrite<S>[] = [];
  for (const slot of input.slots) {
    const kinds = history.map((h) => h.angle);
    let idea = take(ideas.findIndex((i) => i.saved && fits(i, slot.network)));
    const angle: Angle =
      idea && isAngle(idea.angle) ? idea.angle : (nextAngles(kinds, 1)[0] as Angle);
    if (!idea && angle === 'tip') {
      const factDue = history.find((h) => h.angle === 'tip')?.fact !== true;
      idea = take(
        ideas.findIndex((i) => i.angle === angle && !!i.fact === factDue && fits(i, slot.network)),
      );
    } else idea ??= take(ideas.findIndex((i) => i.angle === angle && fits(i, slot.network)));
    let topic =
      idea?.topic ??
      (idea
        ? null
        : pickTopic(
            angle,
            input.lists,
            history.flatMap((h) => (h.topic ? [h.topic] : [])).slice(0, VARIETY.topicsRemembered),
          ));
    if (!idea && !topic) {
      idea =
        take(ideas.findIndex((i) => i.angle === angle && fits(i, slot.network))) ??
        take(ideas.findIndex((i) => !isAngle(i.angle) && fits(i, slot.network)));
      topic = idea?.topic ?? null;
    }
    const look = nextLook(history, slot.network, input.photos ?? false);
    out.push({ slot, angle, ideaId: idea?.id ?? null, topic, look });
    history.unshift({ angle, topic, fact: !!idea?.fact, format: look.format, photo: look.photo });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ creators' posts

/** A studied creator's post, as the writer may be shown it. */
export interface CreatorPost {
  readonly caption: string;
  readonly network: string;
  readonly standout: boolean;
  /** How many times its creator's usual it did, on likes and comments, when known. */
  readonly times: number | null;
  /** The AI's note on why a standout worked, when it has one. */
  readonly why: string | null;
}

export const EXAMPLES = {
  /** Creators' posts shown beside each post the AI writes (pick 3a). */
  shown: 3,
  caption: 500,
} as const;

const SMALL_WORDS = new Set(
  'about after again also because been before being both could does doing each from have having here into just like more most much only other over same should some such than that their them then there these they this those through very what when where which while will with would your yours you’re'.split(
    ' ',
  ),
);

/** The words that say what something is about: 4 letters or more, not the small ones every sentence has. */
export function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .split(/[^\p{L}\p{N}’']+/u)
      .map((w) => w.replace(/[’']s$/, ''))
      .filter((w) => w.length >= 4 && !SMALL_WORDS.has(w)),
  );
}

/**
 * The studied creators' posts closest to what a post is about (pick 3a): the ones sharing the most of its words,
 * standouts and the ones that did best for their creator first; with none close, the best standouts, to learn hooks
 * and shape from. Never copied: the writer is told so.
 */
export function examplesFor(about: string, posts: readonly CreatorPost[]): CreatorPost[] {
  const want = wordsOf(about);
  const worth = (p: CreatorPost) => (p.standout ? 2 : 1) * Math.max(1, Math.min(p.times ?? 1, 10));
  const scored = posts
    .filter((p) => p.caption.trim())
    .map((p) => {
      const have = wordsOf(p.caption);
      let shared = 0;
      for (const w of want) if (have.has(w)) shared++;
      return { p, shared, worth: worth(p) };
    });
  const close = scored
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.worth - a.worth);
  const picked = (close.length ? close : scored.filter((s) => s.p.standout))
    .sort((a, b) => b.shared - a.shared || b.worth - a.worth)
    .slice(0, EXAMPLES.shown);
  return picked.map((s) => ({ ...s.p, caption: s.p.caption.trim().slice(0, EXAMPLES.caption) }));
}
