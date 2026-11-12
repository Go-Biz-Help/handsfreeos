/**
 * What AI Social Media Content Creator's pages say (docs/socialcontent.md): the web and the phone read these, and the
 * Assistant's places (./ai-places.ts) name the screens in them. Plain words, short sentences, curly apostrophes.
 * Browser-safe and pure.
 */
import { addDays, localDateOf, zonedParts } from '../../calendar/engine/zoned';
import { fmtDateLong, fmtDateShort, fmtTime } from '../../calendar/when';
import type { PostedTo, PostPlace } from './calendar';
import { hasNumbers, OWN, type DoneWell, type OwnNumbers, type OwnNumbersRead } from './own';
import { DONE_WELL, STANDOUT } from './standouts';

/** Its pages, which pop out of its one row in the side menu. */
export const SOCIALCONTENT_PAGES = {
  creators: 'Creators',
  standouts: 'Standouts',
  playbook: 'Playbook',
  ideas: 'Ideas',
  calendar: 'Calendar',
  // Not `settings`: that key would put the page in Settings search, which opens it on the web.
  gear: 'Settings',
} as const;

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "3 days ago", "today": how long ago a moment was, in days. */
export function daysAgo(at: Date | string | null, now: Date | number = Date.now()): string | null {
  if (!at) return null;
  const then = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const days = Math.floor(((now instanceof Date ? now.getTime() : now) - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.round(days / 365)} years ago`;
}

/** "2 minutes ago", "3 hours ago", "yesterday": how long ago a moment was, for what's happening now. */
export function momentAgo(
  at: Date | string | null,
  now: Date | number = Date.now(),
): string | null {
  if (!at) return null;
  const then = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const minutes = Math.floor(((now instanceof Date ? now.getTime() : now) - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${count(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${count(hours, 'hour')} ago`;
  return daysAgo(at, now);
}

/** "9:00 AM" from "09:00". */
export function clockShown(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const hour = ((h! + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
}

/** "Wed, Nov 12, 9:00 AM" (or just "9:00 AM") in the business's time zone, by core's calendar words. */
export function timeShown(at: string, timeZone: string, withDay = false): string {
  const clock = fmtTime(at, timeZone);
  return withDay ? `${fmtDateShort(localDateOf(Date.parse(at), timeZone))}, ${clock}` : clock;
}

/** A moment's time of day in the business's zone, "HH:MM", as a post's time is picked. */
export function clockOf(at: string, timeZone: string): string {
  const p = zonedParts(Date.parse(at), timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** A day on the Calendar: "Today", "Tomorrow", else "Wednesday, November 12". */
export function dayShown(date: string, today: string): string {
  const C = SOCIALCONTENT_WORDS.calendar;
  if (date === today) return C.today;
  if (date === addDays(today, 1)) return C.tomorrow;
  return fmtDateLong(date);
}

/** "in 6 days", "tomorrow", "today". */
export function daysUntil(at: string, now: number = Date.now()): string {
  const days = Math.ceil((Date.parse(at) - now) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** When the Calendar was filled and fills again, how to fill it the first time, or that filling on its own is off. */
export function filledLine(
  c: {
    readonly filledAt: string | null;
    readonly nextFillAt: string | null;
    readonly autoFill?: boolean;
  },
  now: number = Date.now(),
): string {
  const C = SOCIALCONTENT_WORDS.calendar;
  if (c.autoFill === false) return C.fillOffLine(c.filledAt ? daysAgo(c.filledAt, now) : null);
  return c.filledAt
    ? C.filled(daysAgo(c.filledAt, now), c.nextFillAt ? daysUntil(c.nextFillAt, now) : null)
    : C.neverFilled;
}

/** One network's plan as the pages read it; an older API's had only `perWeek` and `time`. */
export interface PlanForWords {
  readonly perWeek: number;
  readonly time: string;
  readonly mode?: 'ai' | 'mine';
  readonly perDay?: number | null;
  readonly week?: readonly (readonly string[])[];
}

/**
 * The plan in a line: "Your plan: Instagram: 3 posts a week at the times the AI picks · Facebook: 2 posts a week at
 * your times · … Change the plan in Settings."
 */
export function planShown(
  plan: Readonly<Record<string, PlanForWords>>,
  networks: readonly string[],
  networkNameOf: (network: string) => string,
): string {
  const C = SOCIALCONTENT_WORDS.calendar;
  const lines = networks
    .filter((n) => plan[n])
    .map((n) => {
      const p = plan[n]!;
      const name = networkNameOf(n);
      if (p.mode === 'mine') return C.planMine(name, (p.week ?? []).flat().length);
      if (p.mode === 'ai') return C.planAi(name, p.perWeek, p.perDay ?? null);
      return C.planLine(name, p.perWeek, clockShown(p.time));
    });
  return `${C.plan}: ${lines.join(' · ')}. ${C.planEdit}`;
}

/** "9:00 AM, 12:00 PM and 6:00 PM". */
const listShown = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');

/**
 * What AI picks learned on one network, in a line (decisions 25 and 26): its best hours so far and what from, or that
 * it hasn't learned any yet and starts near the plan's time.
 */
export function learnedLine(
  l: {
    readonly best: readonly string[];
    readonly from: 'own' | 'both' | 'creators' | 'none';
    readonly own: number;
    readonly creators: number;
  },
  startsNear: string,
): string {
  const S = SOCIALCONTENT_WORDS.settings;
  if (!l.best.length || l.from === 'none') return S.learnedNone(clockShown(startsNear));
  const from =
    l.from === 'creators'
      ? S.learnedFrom.creators(l.creators)
      : l.from === 'both'
        ? S.learnedFrom.both(l.own, l.creators)
        : S.learnedFrom.own(l.own);
  return `${S.learnedBest(listShown(l.best.map(clockShown)), from)} ${S.learnedTrying}`;
}

/** The reading computer counts as there when it asked for work in the last few minutes (it asks each minute). */
export const READER_THERE_MS = 10 * 60_000;

/**
 * What the Calendar says about putting OK'd posts up (part 9): how many wait, whose computer puts them up, and
 * whether it's checked in lately; with a warning when nobody's computer posts or it's been quiet. The web and the phone
 * both show these.
 */
export function postingLines(
  c: {
    readonly ready: number;
    readonly poster: {
      readonly name: string | null;
      readonly mine: boolean;
      readonly seenAt: string | null;
    } | null;
    readonly postsOn: readonly string[];
    readonly posts: readonly { readonly network: string; readonly state: string }[];
  },
  networkNameOf: (network: string) => string,
  now: number = Date.now(),
): { readonly text: string; readonly warn: boolean }[] {
  const out: { text: string; warn: boolean }[] = [];
  const ready = SOCIALCONTENT_WORDS.calendar.ready(c.ready);
  if (ready) out.push({ text: ready, warn: false });
  const later = [
    ...new Set(
      c.posts
        .filter((p) => !c.postsOn.includes(p.network) && p.state !== 'skipped')
        .map((p) => networkNameOf(p.network)),
    ),
  ];
  if (!c.ready && !later.length) return out;
  if (c.ready) {
    if (!c.poster) out.push({ text: SOCIALCONTENT_WORDS.calendar.posterNone, warn: true });
    else {
      out.push({
        text: SOCIALCONTENT_WORDS.calendar.poster(c.poster.name, c.poster.mine),
        warn: false,
      });
      const seen = c.poster.seenAt ? new Date(c.poster.seenAt).getTime() : null;
      if (seen === null) out.push({ text: SOCIALCONTENT_WORDS.calendar.posterNever, warn: true });
      else if (now - seen >= READER_THERE_MS)
        out.push({
          text: SOCIALCONTENT_WORDS.calendar.posterQuiet(momentAgo(c.poster.seenAt, now) ?? ''),
          warn: true,
        });
    }
  }
  if (later.length)
    out.push({ text: SOCIALCONTENT_WORDS.calendar.laterOn(later.join(' and ')), warn: false });
  return out;
}

/** A read's numbers in a line: "1,240 views · 86 likes · 9 comments", only those the network showed. */
export function numbersLine(r: OwnNumbersRead): string {
  if (!hasNumbers(r)) return SOCIALCONTENT_WORDS.post.numbers.couldnt(r.failure);
  const parts = [
    r.views !== null ? count(r.views, 'view') : null,
    r.likes !== null ? count(r.likes, 'like') : null,
    r.comments !== null ? count(r.comments, 'comment') : null,
    r.shares !== null ? count(r.shares, 'share') : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : SOCIALCONTENT_WORDS.post.numbers.noneShown;
}

/**
 * How one of the business's own posts did (part 11), in lines to show: each place it went up, its numbers after about
 * 2 days and about 7, and whether it did well against the business's own others (`well`). Before its first read it
 * says when they're read; nothing for a post that hasn't gone up. The web and the phone both show these.
 */
export function numbersLines(
  c: {
    readonly network: string;
    readonly postedTo: readonly PostedTo[];
    readonly numbers: OwnNumbers;
    readonly doneWell: DoneWell | null;
  },
  networkNameOf: (network: string) => string,
): { text: string; well: boolean }[] {
  const W = SOCIALCONTENT_WORDS.post;
  if (!c.postedTo.length) return [];
  const several = c.postedTo.length > 1;
  const where = (place: PostPlace) =>
    place === 'feed' ? W.wentUp.feed(networkNameOf(c.network)) : W.wentUp[place];
  const out: { text: string; well: boolean }[] = [];
  for (const p of c.postedTo) {
    const reads = c.numbers[p.place] ?? {};
    for (const r of [reads.d2, reads.d7]) {
      if (!r) continue;
      const line = `${W.numbers.after(r.days)}: ${numbersLine(r)}`;
      out.push({
        text: several ? `${where(p.place)}, ${line.charAt(0).toLowerCase()}${line.slice(1)}` : line,
        well: false,
      });
    }
  }
  if (!out.length) return [{ text: W.numbers.soon, well: false }];
  if (c.doneWell)
    out.push({
      text: W.numbers.doneWell(
        c.doneWell.times,
        c.doneWell.on,
        several ? where(c.doneWell.place) : null,
      ),
      well: true,
    });
  return out;
}

/**
 * What a piece of work did, or is doing, in short facts: "Searched 3 of 8: #crm, #saas, #automation", "Looked at 24
 * accounts", "Read 6 profiles", "6 suggested, 14 didn't fit". Only what it has.
 */
export function progressFacts(
  p: {
    searched?: readonly string[];
    searches?: number;
    accounts?: number;
    profiles?: number;
    posts?: number;
    notOpened?: number;
    suggested?: number;
    didntFit?: number;
  } | null,
): string[] {
  if (!p) return [];
  const facts: string[] = [];
  if (p.searched?.length) {
    const of = p.searches && p.searches > p.searched.length ? ` of ${p.searches}` : '';
    facts.push(`Searched ${p.searched.length}${of}: ${p.searched.join(', ')}`);
  }
  if (p.accounts) facts.push(`Looked at ${count(p.accounts, 'account')}`);
  if (p.profiles) facts.push(`Read ${count(p.profiles, 'profile')}`);
  if (p.posts) facts.push(`Read ${count(p.posts, 'post')}`);
  if (p.notOpened) facts.push(`Couldn’t open ${count(p.notOpened, 'profile')}`);
  if (p.suggested || p.didntFit)
    facts.push(
      [
        p.suggested ? `${p.suggested.toLocaleString('en-US')} suggested` : null,
        p.didntFit ? `${p.didntFit.toLocaleString('en-US')} didn’t fit` : null,
      ]
        .filter(Boolean)
        .join(', '),
    );
  return facts;
}

/** "3.1 times their normal": how far past the posts around it a post did. */
export const timesWords = (t: number) => `${t.toFixed(1)} times their normal`;

export const SOCIALCONTENT_WORDS = {
  title: 'AI Social Media Content Creator',
  count,
  /**
   * The main offer isn't live (the owner's pick 7b, 11 Nov 2026): like Social Outreach, the AI writes no posts and no
   * ideas until it is. The research goes on.
   */
  offer: {
    notLive:
      'Your main offer isn’t live yet, so the AI doesn’t write posts or ideas. Put it live in Settings → Main offer, and fill in For your content there too: every post is written from them.',
    open: 'Open Main offer',
  },
  needsReader:
    'No computer reads the networks yet. An owner or admin picks one in Settings, with the HandsFreeOS Social extension in Chrome.',
  niches: {
    title: 'Niches',
    intro:
      'What your content is about, and niches like it. Creators are looked for in the ones ticked.',
    own: 'Your niche',
    similar: 'Similar niches',
    suggest: 'Suggest niches',
    suggesting: 'Suggesting…',
    suggested: (n: number) =>
      n ? `Suggested ${count(n, 'niche')} like yours.` : 'No new niches this time.',
    add: 'Add a niche',
    addPlaceholder: 'Like “Small business marketing”',
    added: (name: string) => `Added “${name}”. Creators are looked for in it next time.`,
    pick: 'Search it',
    skip: 'Skip',
    picked: 'Searched',
    skipped: 'Skipped',
    none: 'No niches yet. Suggest niches to have the AI find yours and ones like it, or add one.',
    nameTaken: (name: string) => `There’s already a niche called “${name}”.`,
  },
  creators: {
    title: 'Creators',
    intro: `Creators in your niche and niches like it. Tick the ones to study: their posts are read back 12 months, and the ones that beat their normal show under Standouts.`,
    find: 'Find creators now',
    finding: (networks: string, niches: number) =>
      `Looking for creators on ${networks} in ${count(niches, 'niche')}. Your reading computer works on it while Chrome is open.`,
    add: 'Add a creator',
    addPlaceholder: 'Paste a link to their page',
    added: (who: string) => `Studying ${who}. Their posts are read next.`,
    tabs: { suggested: 'Suggested', studying: 'Studying', skipped: 'Skipped' },
    study: 'Study',
    skip: 'Skip',
    stop: 'Stop studying',
    studyAgain: 'Study after all',
    readAgain: 'Read again',
    readingAgain: (who: string) => `Asked your reading computer to read ${who} again.`,
    reading: 'Reading',
    seePosts: 'See posts',
    hidePosts: 'Hide posts',
    followers: (n: number) => count(n, 'follower'),
    posted: (when: string) => `posted ${when}`,
    postsRead: (n: number) => count(n, 'post') + ' read',
    standouts: (n: number) => count(n, 'standout'),
    readWhen: (when: string) => `read ${when}`,
    notRead: 'Not read yet',
    smaller: `Under ${DONE_WELL.followersAtLeast.toLocaleString('en-US')} followers, so a search wouldn’t have suggested them.`,
    noneSuggested: `Nobody to tick yet. Find creators now looks in your ticked niches for creators with ${DONE_WELL.followersAtLeast.toLocaleString('en-US')}+ followers who posted in the last ${DONE_WELL.postedWithinDays} days.`,
    noneStudying: 'Nobody studied yet. Tick creators under Suggested, or add one from a link.',
    noneSkipped: 'Nobody skipped.',
    posts: {
      title: 'Their posts',
      none: 'No posts read yet.',
      standout: 'Standout',
      tooNew: 'Under a week old',
      tooFew: 'Too few posts around it',
    },
  },
  standouts: {
    title: 'Standouts',
    intro: `Posts that did at least ${STANDOUT.times} times better than the ${STANDOUT.eachSide} posts on each side of them, on views or on likes plus comments, with the AI’s notes on why each worked.`,
    none: 'No standouts yet. Once creators are studied, their posts that beat their normal show here.',
    allNetworks: 'All networks',
    allCreators: 'All creators',
    open: 'Open post',
    views: (n: number) => count(n, 'view'),
    engagement: (n: number) => `${n.toLocaleString('en-US')} likes and comments`,
    on: { views: 'On views', engagement: 'On likes and comments', both: 'On both' },
    more: 'Show more',
    notes: {
      why: 'Why it worked',
      hook: 'Hook',
      format: 'Format',
      topic: 'Topic',
      techniques: 'Techniques',
      useIt: 'For you',
      waiting: 'The AI’s notes on this one are on the way.',
    },
    watched: {
      title: 'Watched',
      hook: 'First seconds',
      seen: 'On screen',
      heard: 'Heard',
      pacing: 'Pacing',
      why: 'Why it worked',
      watching: 'Your reading computer is watching it.',
    },
  },
  playbook: {
    title: 'Playbook',
    intro:
      'What works for the creators you study, and for your own posts that did best, written by the AI from its notes on their standouts. Use it to plan your own posts.',
    none: 'No Playbook yet. Once a few standouts have the AI’s notes, it writes one here.',
    write: 'Write it again',
    writing: 'Writing…',
    done: 'The Playbook is written.',
    written: (when: string, n: number) => `Written ${when} from ${count(n, 'standout')}.`,
    newSince: (n: number) => `${count(n, 'standout')} noted since.`,
    examples: 'From',
    yourPost: 'Your post',
    nothingToWrite:
      'There’s nothing to write a Playbook from yet: no standout has the AI’s notes. Study creators first, then their standouts get notes on their own.',
  },
  ideas: {
    title: 'Ideas',
    intro:
      'Ideas for your own posts, from the Playbook and what HandsFreeOS knows about your business. Write the post from one, and it goes on your Calendar. Saved ideas are written first when the calendar fills.',
    none: 'No ideas yet. Get ideas once there’s a Playbook.',
    get: 'Get ideas',
    getting: 'Thinking…',
    got: (n: number) => (n ? `Added ${count(n, 'idea')}.` : 'No new ideas this time.'),
    tabs: { new: 'New', saved: 'Saved', used: 'Used', skipped: 'Skipped' },
    save: 'Save',
    use: 'Mark used',
    write: 'Write the post',
    skip: 'Skip',
    again: 'Back to new',
    hook: 'Hook',
    format: 'Format',
    outline: 'Outline',
    why: 'Why it should work',
    basedOn: (n: number) => `Based on ${count(n, 'standout')}`,
    decided: 'Done.',
    needsPlaybook:
      'Ideas come from the Playbook, and there isn’t one yet. Once a few standouts have the AI’s notes, it’s written on its own.',
    noneNew: 'No new ideas. Get ideas for more.',
    noneSaved: 'Nothing saved yet.',
    noneUsed: 'Nothing used yet.',
    noneSkipped: 'Nothing skipped.',
  },
  watch: {
    title: 'Watching videos',
    intro:
      'The AI can also watch standout videos (Instagram’s for now): it looks at frames from each and listens to what’s said, then notes the hook, what’s on screen, the pacing and why it worked.',
    cost: 'This uses a lot more AI than notes from the numbers and caption alone, about 10 to 20 times as much for each video. It’s off until you turn it on.',
    on: 'Watch new standout videos',
    tryIt: 'Try it on a few videos',
    tryHint: 'Watches up to 5 of the newest standout videos once, without turning it on.',
    asked: (n: number) =>
      n
        ? `Asked your reading computer to watch ${count(n, 'video')}. The AI’s notes show on each under Standouts.`
        : 'No new Instagram standout videos to watch yet.',
  },
  kinds: {
    video: 'Video',
    photo: 'Photo',
    carousel: 'Carousel',
    text: 'Text',
    link: 'Link',
    other: 'Post',
  },
  settings: {
    title: 'Settings',
    networks: 'Networks',
    networksIntro: 'The networks creators are looked for and read on.',
    coming: 'Coming later',
    reader: 'Whose computer reads',
    readerIntro:
      'One computer reads the networks for the whole business, in Chrome with the HandsFreeOS Social extension, at a person’s pace. It shares each network’s pace with Social Outreach, so the two never add up.',
    readerIs: (name: string | null) =>
      name ? `${name}’s computer reads the networks.` : 'A teammate’s computer reads the networks.',
    readerMine: 'Your computer reads the networks.',
    readerNone: 'No computer reads yet.',
    readOnMine: 'Read on my computer',
    readerStop: 'Stop reading',
    managersOnly: 'Only an owner or admin of this business changes these.',
    extensionHow:
      'Install the extension (0.128.2 or later) in Chrome on that computer, sign in to it with your HandsFreeOS account, and stay signed in there to each network it studies (Instagram, Facebook, LinkedIn). It reads while Chrome is open, in a window of its own.',
    getExtension: 'Get the extension',
    watchSaved: (on: boolean) =>
      on ? 'Watching is on: new standout videos are watched as they’re found.' : 'Watching is off.',
    schedule:
      'Each creator studied is read again once a week for new posts, and new creators are looked for once a month.',
    saved: 'Saved.',
    doing: 'What it’s doing',
    waiting: (n: number) =>
      n ? `${count(n, 'thing')} waiting for the reading computer.` : 'Nothing waiting.',
    noWork: 'Nothing asked yet.',
    stop: 'Stop',
    stopped: 'Stopped.',
    posting: 'Posting',
    postingIntro:
      'How many of your own posts the AI writes for each network, and when they go, in your business’s time zone. The Calendar fills two weeks ahead from this. Posts go up from the reading computer, so a time only works while Chrome is open there.',
    perWeek: (network: string) => `Posts a week on ${network}`,
    perWeekOption: (n: number) => (n ? `${n} a week` : 'Off'),
    at: 'at',
    timeFor: (network: string) => `Time for ${network}`,
    /** AI picks or I pick, on each network (decision 21). */
    modeFor: (network: string) => `Who picks the times on ${network}`,
    modes: { ai: 'AI picks', mine: 'I pick' } as const,
    modeHints: {
      ai: 'You say how many. The AI picks the days and the best times, and learns from how your posts do.',
      mine: 'You pick the days and the times, up to 3 a day.',
    } as const,
    perDay: (network: string) => `Most a day on ${network}`,
    perDayOption: (n: number | null) => (n ? `Up to ${n} a day` : 'Spread them out'),
    between: 'between',
    and: 'and',
    fromFor: (network: string) => `Earliest time on ${network}`,
    toFor: (network: string) => `Latest time on ${network}`,
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const,
    addTime: 'Add a time',
    addTimeFor: (day: string) => `Add a time on ${day}`,
    removeTime: (day: string, time: string) => `Remove ${time} on ${day}`,
    noTimes: 'No posts',
    learnedNone: (time: string) =>
      `Nothing learned yet: it starts near ${time}, then learns from the creators’ best posts and your own.`,
    learnedBest: (times: string, from: string) => `Best times so far: ${times}, from ${from}.`,
    learnedFrom: {
      creators: (n: number) => `${count(n, 'post')} by the creators you study`,
      both: (own: number, creators: number) =>
        `${count(own, 'of your posts', 'of your posts')} and ${count(creators, 'by creators', 'by creators')}`,
      own: (n: number) => count(n, 'of your posts', 'of your posts'),
    },
    learnedTrying: 'About 1 in 5 posts go at a new time, so it keeps learning.',
    facebookPage: 'Your Facebook Page',
    savePage: 'Save',
    facebookWhere: 'Where Facebook posts go',
  },
  activity: {
    title: 'What it’s doing',
    reader: (name: string, ago: string, version: string | null) =>
      `Reading on ${name}’s computer · checked in ${ago}${version ? ` · extension ${version}` : ''}`,
    readerQuiet: (name: string, ago: string) =>
      `${name}’s computer last checked in ${ago}. Open Chrome there with the HandsFreeOS Social extension, and it picks up where it left off.`,
    readerNever: (name: string) =>
      `${name}’s computer hasn’t checked in yet. Open Chrome there with the HandsFreeOS Social extension (Get the extension is in Settings here), signed in to HandsFreeOS.`,
    now: 'Now',
    waiting: (n: number) => `${count(n, 'more thing')} waiting`,
    lately: 'Lately',
    nothing:
      'Nothing yet. Press Find creators now to search your ticked niches, or add a creator you know.',
    starting: 'Starting…',
    all: 'Everything it did is in Settings.',
  },
  /** The business's own posts and their calendar (part 8). */
  calendar: {
    title: 'Calendar',
    intro:
      'Your own posts for the next two weeks, written by the AI from your Playbook and ideas. Nothing goes up until you OK it.',
    fill: 'Fill the calendar',
    filling: 'Writing posts…',
    fillAsked:
      'Writing posts for the open days. They show here as they’re written, each waiting for your OK.',
    fillNothing: 'Every day in your plan already has a post.',
    filled: (ago: string | null, next: string | null) =>
      [ago ? `Filled ${ago}` : null, next ? `fills again ${next}` : null]
        .filter(Boolean)
        .join(' · '),
    neverFilled:
      'Press Fill the calendar to have the AI write posts for the open days in your plan. After that it tops up once a week on its own.',
    /** The switch that stops it filling itself (the owner, 11 Nov). */
    autoFill: 'Fill on its own',
    autoFillHint:
      'The AI writes posts for the open days in the next two weeks, and tops up once a week. Turn it off to stop it.',
    fillOffLine: (ago: string | null) =>
      ago
        ? `Filled ${ago} · filling on its own is off, so the AI writes no more posts unless you ask for one.`
        : 'Filling on its own is off, so the AI writes no posts unless you ask for one.',
    fillOffWho: 'An owner or admin can turn filling on its own back on.',
    fillStopped:
      'Stopped. The AI won’t write posts on its own until you turn Fill on its own back on. The posts already written stay.',
    fillStarted:
      'Filling on its own again. The AI writes posts for any open days now, each waiting for your OK.',
    approveWeek: 'OK the week',
    approvedWeek: (n: number, notReady: number) =>
      [
        n ? `OK’d ${count(n, 'post')}.` : 'Nothing new to OK this week.',
        notReady ? `${count(notReady, 'post')} still need something first.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    write: 'Write a post',
    writing: 'Writing…',
    written: 'Written. It’s waiting for your OK.',
    open: 'Open day',
    openHint: (network: string, time: string) => `${network} at ${time}`,
    writeFor: 'Write one',
    undated: 'No day yet',
    plan: 'Your plan',
    planEdit: 'Change the plan in Settings.',
    planLine: (network: string, perWeek: number, time: string) =>
      perWeek ? `${network}: ${count(perWeek, 'post')} a week at ${time}` : `${network}: off`,
    planAi: (network: string, perWeek: number, perDay: number | null) =>
      perWeek
        ? `${network}: ${count(perWeek, 'post')} a week${perDay ? `, up to ${perDay} a day` : ''}, at the times the AI picks`
        : `${network}: off`,
    planMine: (network: string, posts: number) =>
      posts ? `${network}: ${count(posts, 'post')} a week at your times` : `${network}: off`,
    /** An open place at an hour AI picks is trying out (decision 26). */
    trying: 'A new time, to keep learning',
    ready: (n: number) => (n ? `${count(n, 'post')} OK’d, going up at their times.` : null),
    /** Who puts the OK'd posts up (part 9): the reading computer, in Chrome with the extension. */
    poster: (name: string | null, mine: boolean) =>
      mine
        ? 'They go up from your computer, in Chrome with the HandsFreeOS Social extension, while Chrome is open.'
        : `They go up from ${name ? `${name}’s` : 'a teammate’s'} computer, in Chrome with the HandsFreeOS Social extension, while Chrome is open there.`,
    posterQuiet: (ago: string) =>
      `That computer last checked in ${ago}. Posts wait until Chrome is open there again, up to a day after their time.`,
    posterNever:
      'That computer hasn’t checked in yet. Open Chrome there with the HandsFreeOS Social extension, signed in to HandsFreeOS.',
    posterNone:
      'No computer puts them up yet. An owner or admin picks one in Settings → Whose computer reads.',
    laterOn: (networks: string) =>
      `Posting on ${networks} comes in a later update: copy those and post them yourself until then.`,
    empty: 'No posts yet. Fill the calendar, or write one from an idea under Ideas.',
    recent: 'Went up lately',
    today: 'Today',
    tomorrow: 'Tomorrow',
  },
  post: {
    states: {
      draft: 'Waiting for your OK',
      ready: 'OK’d',
      posting: 'Posting…',
      posted: 'Posted',
      failed: 'Didn’t post',
      skipped: 'Skipped',
    },
    formats: { photo: 'Picture', carousel: 'Carousel', video: 'Video', text: 'Words only' },
    ways: {
      design: 'Designed by the AI',
      photo: 'Photo-style, by the AI',
      own: 'Your own',
    },
    waysHint: {
      design:
        'A picture with words on it, in your colour: tips, steps, a quote, a big claim, or each slide of a carousel.',
      photo: 'A lifelike picture with no words, made by OpenAI’s image AI. It costs 9¢ each.',
      own: 'A photo or video you take: the real you, your team or your work.',
    },
    pictureStates: {
      none: null,
      waiting: 'Waiting to make the picture…',
      making: 'Making the picture…',
      made: null,
      failed: 'The picture didn’t work.',
    },
    title: 'Title',
    words: 'Words',
    hook: 'Hook',
    hashtags: 'Hashtags',
    hashtagsHint: 'Without the #, separated by spaces. They’re added at the end when it goes up.',
    slides: 'Slides',
    slide: (n: number) => `Slide ${n}`,
    addSlide: 'Add a slide',
    script: 'Script',
    lines: 'What to say',
    shots: 'What to film',
    picture: 'Picture',
    /** A post's pictures full screen (the owner, 11 Nov). */
    fullScreen: (name: string) => `See ${name} full screen`,
    viewer: 'Pictures full screen',
    viewerOf: (n: number, total: number) => `${n} of ${total}`,
    viewerPrevious: 'Previous picture',
    viewerNext: 'Next picture',
    viewerClose: 'Close',
    pictureShows: 'What it shows',
    makePicture: 'Make the picture',
    makeAgain: 'Make it again',
    makeAsk: 'What to change (optional)',
    makeAsked: 'Making it. It shows here in a minute.',
    switchTo: (way: string) => `Switch to ${way.toLowerCase()}`,
    upload: 'Add your photo',
    uploading: 'Adding…',
    remove: 'Remove',
    video: 'Your video',
    addVideo: 'Add your video',
    otherVideo: 'Use another video',
    videoHint:
      'Record the video from the script, then add it here. Up to 25 MB: about a minute at 720p. Your phone can make it smaller when you share it.',
    facebookWhere: 'Where on Facebook',
    facebookWhereOptions: { profile: 'Your profile', page: 'Your Page' },
    when: 'When it goes',
    time: 'Time',
    needsPage: 'Add your Facebook Page’s link in Settings → Posting first.',
    noDay: 'No day yet',
    save: 'Save',
    saved: 'Saved.',
    unOkd: 'Saved. Changing it took the OK back, so OK it again when it’s right.',
    approve: 'OK it',
    approved: 'OK’d. It goes up at its time.',
    postNow: 'Post it now',
    postingNow: 'Putting it up…',
    postNowAsked: 'It goes up in a minute or two, from the computer that posts.',
    postedOn: (ago: string | null) => `Posted${ago ? ` ${ago}` : ''}`,
    seeIt: {
      profile: 'See it on your profile',
      page: 'See it on your Page',
      feed: (network: string) => `See it on ${network}`,
    },
    wentUp: {
      profile: 'On your profile',
      page: 'On your Page',
      feed: (network: string) => `On ${network}`,
    },
    didntPost: 'Didn’t post',
    numbers: {
      title: 'How it did',
      after: (days: number) => `After ${days === 1 ? '1 day' : `${days} days`}`,
      soon: `Its numbers are read ${OWN.firstDays} and ${OWN.secondDays} days after it went up.`,
      noneShown: 'no numbers shown',
      couldnt: (why: string) => `couldn’t read its numbers. ${why}`,
      doneWell: (times: number, on: 'views' | 'engagement' | 'both', where: string | null) =>
        `It did well: ${times} times your usual ${on === 'views' ? 'views' : on === 'both' ? 'views, likes and comments' : 'likes and comments'}${where ? ` ${where.charAt(0).toLowerCase()}${where.slice(1)}` : ''}. It goes into the Playbook.`,
    },
    tryAgain:
      'Fix what it says, then press Post it now. Places it already went up in are left out, so it never goes up twice there.',
    copy: 'Copy the words',
    copied: 'Copied.',
    takeBack: 'Take the OK back',
    takenBack: 'The OK is taken back.',
    skip: 'Skip it',
    skipped: 'Skipped. Its day is open again.',
    restore: 'Bring it back',
    restored: 'It’s back, waiting for your OK.',
    /** Taking a post off the calendar (owners and admins, with `remove` as its button): its day opens again. */
    removeLabel: (title: string) => `Remove ${title}`,
    removeTitle: 'Remove this post?',
    removeAsk:
      'It comes off the calendar and isn’t posted. Its day opens up, so Fill the calendar or Write one puts a new post there.',
    removeYes: 'Remove it',
    removeNo: 'Keep it',
    removed: (hadDay: boolean) =>
      hadDay
        ? 'Removed. Its day is open: press Fill the calendar to have a new post written for it.'
        : 'Removed.',
    rewrite: 'Write it again',
    rewriteAsk: 'What to change (optional)',
    rewritten: 'Written again. It’s waiting for your OK.',
    fromIdea: 'From an idea',
    madeByAi: 'Written by the AI',
    approvedBy: (name: string | null, ago: string | null) =>
      `OK’d${name ? ` by ${name}` : ''}${ago ? ` ${ago}` : ''}`,
    network: 'Network',
    format: 'Format',
  },
  /** The phone's screens (part 5): its one row under More, its first screen's pages, and what needs signal there. */
  phone: {
    more: 'Creators, standout posts, the Playbook, ideas and your Calendar',
    pages: {
      creators: (studying: number, suggested: number) =>
        [
          studying ? `${count(studying, 'creator')} studied` : null,
          suggested ? `${suggested.toLocaleString('en-US')} to tick` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Your niches, and the creators found in them',
      standouts: (n: number) => (n ? count(n, 'standout') : 'Posts that beat their normal'),
      playbook: 'What works for the creators you study',
      ideas: 'Ideas for your own posts',
      calendar: 'Your own posts, two weeks ahead, and how they did',
      gear: 'Networks, whose computer reads, and watching videos',
    },
    needsSignal: (screen: string) => `${screen} needs signal. Try again when you’re back online.`,
    tryAgain: 'Try again',
    loading: 'Loading…',
    creator: 'Creator',
    pickCreator: 'Pick a creator',
    morePosts: 'Show more posts',
    openProfile: 'Open their page',
    extensionOnComputer:
      'Get the extension on that computer: open this add-on’s Settings in HandsFreeOS on the web there, and press Get the extension.',
    watchAsk: 'Turn on watching videos?',
    watchYes: 'Turn it on',
    watchKeep: 'Keep it off',
    /** A post's words handed to the phone's share sheet (Copy, or the network's own app). */
    shareWords: 'Share the words',
  },
  /** What HandsFreeOS says about a post that didn't go up (part 9), on the post and the Calendar. */
  posting: {
    unsure: (network: string) =>
      `The computer that posts started putting it up but never said how it went, so it may have gone up. Look on ${network}: if it isn’t there, press Post it now.`,
    late: 'The computer that posts wasn’t on within a day of its time. Pick a new day and OK it again, or press Post it now.',
    noVideo: 'It has no video yet. Add your video to the post, then press Post it now.',
    noPicture:
      'Its pictures aren’t on the post anymore. Make the picture again or add your own, then press Post it now.',
    notOn: (network: string) =>
      `The extension doesn’t post on ${network} yet. Copy the words and post it yourself, or skip it.`,
    stoppedAt: (place: string, why: string) => `${place}: ${why}`,
    gone: 'That post isn’t going up anymore. The extension moves on to the next one.',
  },
  work: {
    kinds: {
      find: (niche: string, network: string) => `Find creators for “${niche}” on ${network}`,
      profile: (who: string, network: string) => `Read ${who}’s profile on ${network}`,
      posts: (who: string, network: string) => `Read ${who}’s posts on ${network}`,
      watch: (who: string, network: string) => `Watch a video of ${who}’s on ${network}`,
    },
    states: {
      waiting: 'Waiting',
      taken: 'Working on it',
      done: 'Done',
      failed: 'Didn’t work',
      stopped: 'Stopped',
    },
    found: (n: number) => `${count(n, 'creator')} found`,
    read: (n: number) => `${count(n, 'post')} read`,
    askedFor: {
      person: 'asked for',
      weekly: 'weekly',
      monthly: 'monthly',
      added: 'added',
      studying: 'ticked',
      standout: 'new standout',
      trying: 'trying',
    },
  },
} as const;
