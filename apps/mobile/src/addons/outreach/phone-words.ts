import { ANSWER_NEXTS, type AnswerNext } from '@hfos/core/addons/outreach/playbooks';

/**
 * Social Outreach's words the phone says that core doesn't hold yet ("The rest on the phone"): the web's screens write
 * these same sentences in place (the computers in live-view.tsx, the country picker and lists in country-picker.tsx
 * and country-skipped.tsx, and AI help in ai-help.tsx), so they belong beside the rest in core's `OUTREACH_WORDS`,
 * where the web and the phone would both read them. Until they move there, the phone keeps them here, word for word
 * the web's, so no screen writes a sentence of its own. Plain words, short sentences, curly apostrophes.
 */

const people = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export const PHONE_WORDS = {
  /** The person's computers the extension runs on, under Settings → Your computer (the Live screen). */
  computers: {
    title: 'Your computers',
    about:
      'The one you used last works; the others stand by. Open the panel on one to work from it.',
    /** Under each name: how it stands, and when it was last seen. */
    line: (state: string, seen: string) => `${state} · seen ${seen}`,
    rename: 'Rename',
    remove: 'Remove',
    nameLabel: 'Computer name',
    renamed: 'Renamed.',
    removed: (name: string) => `Removed ${name}.`,
    removeStandingBy: (n: number) => `Remove the ${n.toLocaleString('en-US')} standing by`,
    removeStandingByAsk: (n: number) =>
      `Remove the ${n.toLocaleString('en-US')} computers standing by? One the extension still runs on comes back the next time it checks in.`,
    removeThem: 'Remove them',
    removedMany: (n: number) => `Removed ${n.toLocaleString('en-US')} computers.`,
    cancel: 'Cancel',
  },
  /** The business's country setting (decision 61), and the lists it makes (decision 86). */
  countries: {
    find: 'Find a country',
    noMatch: (typed: string) => `No country called “${typed}”. Check the spelling.`,
    takeOff: (name: string) => `Take ${name} off`,
    picked: 'Countries picked',
    skippedTitle: 'Skipped for country',
    reaches: (rule: string) => `Your business reaches: ${rule}.`,
    skippedAbout:
      'Nobody here is sent a friend request or a message, suggested on Today or listed as a good fit. Unskip lets someone through for good.',
    unskipped: (n: number) => `${people(n, 'person is', 'people are')} let through.`,
    skippedEmpty:
      'Nobody is skipped yet. People show here once a “Lives in” on their profile, or a look at their profile and mutual friends, says they’re outside the countries you reach.',
    unskip: 'Unskip',
    throughDone: (name: string) => `${name} is let through from now on.`,
    skipDone: (name: string) => `${name} is skipped from now on.`,
    undoDone: (name: string) => `${name} is back under the country setting.`,
    unskipDone: (name: string) =>
      `${name} is let through from now on, whatever the country setting says.`,
  },
  /** AI help on a playbook's parts (`outreach.playbook.assist`). */
  aiHelp: {
    title: 'AI help',
    improve: 'Improve',
    writeIt: 'Write it for me',
    suggestMore: 'Suggest more',
    suggestQuestions: 'Suggest questions',
    /** For a screen reader: what the button does, and to which part. */
    improveLabel: (part: string) => `Improve ${part} with AI`,
    suggestLabel: (part: string, words: boolean) =>
      `${words ? 'Write' : 'Suggest more'} ${part} with AI`,
    pickOne: 'Pick one to use, then change it as you like',
    addFits: 'Add the ones that fit',
    rewritten: 'Your list, rewritten',
    tapToAdd: 'Tap to add',
    close: 'Close the AI’s ideas',
    useThese: 'Use these instead',
    add: 'Add',
    nothingNew: 'The AI had nothing new to add here. Try again, or write more first.',
    /** A list at the most it takes. */
    full: (most: number) => `That’s ${most}, the most it takes. Take one out first.`,
    /** One of a suggested question's answers: what they say, what it leads to, and the tag it adds. */
    answer: (label: string, next: AnswerNext, tag: string | null) =>
      `“${label}” · ${ANSWER_NEXTS[next]}${tag ? ` · tags ${tag}` : ''}`,
  },
  /** The short video's script: the main offer's version it was written for, after how long it runs. */
  writtenFor: (version: number) => `written for your main offer, version ${version}`,
} as const;
