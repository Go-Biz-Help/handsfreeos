/**
 * What AI Social Media Content Creator's pages say (docs/socialcontent.md): the web and the phone read these, and the
 * Assistant's places (./ai-places.ts) name the screens in them. Plain words, short sentences, curly apostrophes.
 * Browser-safe and pure.
 */
import { DONE_WELL, STANDOUT } from './standouts';

/** Its pages, which pop out of its one row in the side menu. */
export const SOCIALCONTENT_PAGES = {
  creators: 'Creators',
  standouts: 'Standouts',
  playbook: 'Playbook',
  ideas: 'Ideas',
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

/** "3.1 times their normal": how far past the posts around it a post did. */
export const timesWords = (t: number) => `${t.toFixed(1)} times their normal`;

export const SOCIALCONTENT_WORDS = {
  title: 'AI Social Media Content Creator',
  count,
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
      'What works for the creators you study, written by the AI from its notes on their standouts. Use it to plan your own posts.',
    none: 'No Playbook yet. Once a few standouts have the AI’s notes, it writes one here.',
    write: 'Write it again',
    writing: 'Writing…',
    done: 'The Playbook is written.',
    written: (when: string, n: number) => `Written ${when} from ${count(n, 'standout')}.`,
    newSince: (n: number) => `${count(n, 'standout')} noted since.`,
    examples: 'From',
    nothingToWrite:
      'There’s nothing to write a Playbook from yet: no standout has the AI’s notes. Study creators first, then their standouts get notes on their own.',
  },
  ideas: {
    title: 'Ideas',
    intro:
      'Ideas for your own posts, from the Playbook and what HandsFreeOS knows about your business. Save the ones you like, and mark them used once you’ve posted them.',
    none: 'No ideas yet. Get ideas once there’s a Playbook.',
    get: 'Get ideas',
    getting: 'Thinking…',
    got: (n: number) => (n ? `Added ${count(n, 'idea')}.` : 'No new ideas this time.'),
    tabs: { new: 'New', saved: 'Saved', used: 'Used', skipped: 'Skipped' },
    save: 'Save',
    use: 'Mark used',
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
      'The AI can also watch standout videos: it looks at frames from each and listens to what’s said, then notes the hook, what’s on screen, the pacing and why it worked.',
    cost: 'This uses a lot more AI than notes from the numbers and caption alone, about 10 to 20 times as much for each video. It’s off until you turn it on.',
    on: 'Watch new standout videos',
    tryIt: 'Try it on a few videos',
    tryHint: 'Watches up to 5 of the newest standout videos once, without turning it on.',
    asked: (n: number) =>
      n
        ? `Asked your reading computer to watch ${count(n, 'video')}. The AI’s notes show on each under Standouts.`
        : 'Nothing new to watch.',
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
      'Install the extension (0.127.0 or later) in Chrome on that computer, sign in to it with your HandsFreeOS account, and stay signed in to Instagram in that Chrome. It reads while Chrome is open, in a window of its own.',
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
