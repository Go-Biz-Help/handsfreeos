/**
 * What a playbook says (docs/outreach.md, decision 164; the owner, 13 Nov 2026: "the system should follow the
 * playbook"). Every message Social Outreach writes for a customer has a part here, in the business's own words: the
 * first message, Reconnect, what follows a yes, a question, a not now and a no, the follow-ups, the monthly check-in,
 * the messages around a booking, comments, warm-up comments, replies in public, and birthday and new-job notes.
 *
 * The AI writes each message from its part (`asMessage`, `asHow` in ./today.ts's tasks), so changing a part changes
 * what goes out, and nothing about how a message reads lives only in code. A part the business hasn't changed reads as
 * its starting words (`startingScript`, by the playbook's goal), which are the owner's own latest way (decisions 144,
 * 152, 153, 155, 161 and 163). What no playbook can change is in `LOCKED_RULES`, shown beside the parts.
 *
 * Words in [square brackets] are filled in for each person (`SCRIPT_BLANKS`, `FILL_BLANKS`). Browser-safe: the web's
 * and the phone's editors, the Test console and the server read it.
 */
import { z } from 'zod';
import type { PlaybookGoal } from './playbooks';

/** The parts, in the order a conversation meets them. */
export const SCRIPT_PARTS = [
  'first',
  'reconnect',
  'yes',
  'question',
  'later',
  'no',
  'followUp',
  'checkIn',
  'reminder',
  'missed',
  'comment',
  'warmUp',
  'postReply',
  'groupReply',
  'birthday',
  'newJob',
] as const;
export type ScriptPart = (typeof SCRIPT_PARTS)[number];
/** Every part but the first message, which has up to three versions that take turns. */
export type ScriptTextPart = Exclude<ScriptPart, 'first'>;
export const SCRIPT_TEXT_PARTS = SCRIPT_PARTS.filter(
  (p): p is ScriptTextPart => p !== 'first',
) as readonly ScriptTextPart[];
export const isScriptPart = (v: unknown): v is ScriptPart =>
  typeof v === 'string' && (SCRIPT_PARTS as readonly string[]).includes(v);

/** How much a part holds. */
export const SCRIPT_LIMITS = {
  /** A first message, and how many versions take turns (the owner's 2a). */
  first: { line: 600, most: 3 },
  /** Any other part. */
  text: 800,
} as const;

/**
 * What each part is for the editor: its name, when it goes, and whether its words are the message itself (kept close
 * to, fitted to each person: the owner's 1a) or say how the message goes.
 */
export const SCRIPT_INFO: Readonly<
  Record<
    ScriptPart,
    { readonly label: string; readonly when: string; readonly says: 'message' | 'how' }
  >
> = {
  first: {
    label: 'First message',
    when: 'Once they accept your request or follow you back, after the days you set under Steps and pace. Also to a friend you’ve never talked to.',
    says: 'message',
  },
  reconnect: {
    label: 'Reconnect',
    when: 'To someone you’ve talked with before, once neither of you has written in over a month.',
    says: 'how',
  },
  yes: {
    label: 'When they say yes',
    when: 'Right after they say yes, or when the chat shows they’re ready.',
    says: 'message',
  },
  question: {
    label: 'When they ask something',
    when: 'When their reply asks about the price, how it works, or anything else.',
    says: 'how',
  },
  later: {
    label: 'When they say not now',
    when: 'When their reply says later, they’re busy, or not right now.',
    says: 'how',
  },
  no: {
    label: 'When they say no',
    when: 'When their reply says no. Nothing more goes to them after it unless they write.',
    says: 'how',
  },
  followUp: {
    label: 'Follow-ups',
    when: 'When they go quiet after one of your messages, as many times and as far apart as Steps and pace says.',
    says: 'how',
  },
  checkIn: {
    label: 'Monthly check-in',
    when: 'Once a month after the last follow-up, or after they said not now.',
    says: 'how',
  },
  reminder: {
    label: 'Reminder the day before',
    when: 'The day before a time they booked through your link.',
    says: 'how',
  },
  missed: {
    label: 'After a missed booking',
    when: 'When they booked through your link and didn’t make it.',
    says: 'how',
  },
  comment: {
    label: 'Comments on posts',
    when: 'Under posts about what you do, found with your search words.',
    says: 'how',
  },
  warmUp: {
    label: 'Warm-up comments',
    when: 'Under a post of someone who is deciding on your request, one a visit.',
    says: 'how',
  },
  postReply: {
    label: 'Replies to comments on your posts',
    when: 'When someone comments on one of your helpful posts.',
    says: 'how',
  },
  groupReply: {
    label: 'Answers in your groups',
    when: 'Under the day’s question in one of your Facebook groups.',
    says: 'how',
  },
  birthday: { label: 'Birthdays', when: 'On their birthday.', says: 'how' },
  newJob: {
    label: 'New jobs',
    when: 'When their page says they started a new job.',
    says: 'how',
  },
};

/** The parts as the editor groups them. */
export const SCRIPT_GROUPS: readonly {
  readonly key: string;
  readonly title: string;
  readonly parts: readonly ScriptPart[];
}[] = [
  { key: 'start', title: 'Starting a chat', parts: ['first', 'reconnect'] },
  { key: 'answers', title: 'When they answer', parts: ['yes', 'question', 'later', 'no'] },
  { key: 'quiet', title: 'When they go quiet', parts: ['followUp', 'checkIn'] },
  { key: 'booking', title: 'Around a booking', parts: ['reminder', 'missed'] },
  {
    key: 'public',
    title: 'In public',
    parts: ['comment', 'warmUp', 'postReply', 'groupReply'],
  },
  { key: 'occasions', title: 'Birthdays and new jobs', parts: ['birthday', 'newJob'] },
];

/** The words in brackets a part can hold, and what goes in each for a person. */
export const SCRIPT_BLANKS = [
  { blank: '[first name]', fills: 'Their first name' },
  {
    blank: '[their kind of business]',
    fills: 'What they do, from their page: roofing, real estate',
  },
  {
    blank: '[what your offer gets them]',
    fills: 'What your main offer does for them, in a few words',
  },
  { blank: '[what your offer is]', fills: 'What your main offer is, in a few words' },
  { blank: '[open times]', fills: 'Open times on your booking page, when it’s one of yours' },
  { blank: '[booking link]', fills: 'Your booking link' },
] as const;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Write what it says, or go back to the starting words.')
    .max(max, `Keep it under ${max} characters.`);
const once = (list: readonly string[]) =>
  new Set(list.map((v) => v.trim().replace(/\s+/g, ' ').toLowerCase())).size === list.length;

/**
 * A playbook's own words for its parts. A part left out reads as its starting words (`scriptOf`), so a playbook
 * saved before decision 164, or one that never changed a part, follows them.
 */
const part = text(SCRIPT_LIMITS.text).optional();
export const PlaybookScript = z.object({
  first: z
    .array(text(SCRIPT_LIMITS.first.line))
    .min(1, 'Write a first message, or go back to the starting words.')
    .max(SCRIPT_LIMITS.first.most, `Up to ${SCRIPT_LIMITS.first.most} first messages.`)
    .refine(once, 'Each first message once.')
    .optional(),
  reconnect: part,
  yes: part,
  question: part,
  later: part,
  no: part,
  followUp: part,
  checkIn: part,
  reminder: part,
  missed: part,
  comment: part,
  warmUp: part,
  postReply: part,
  groupReply: part,
  birthday: part,
  newJob: part,
} satisfies Record<ScriptPart, z.ZodType>);
export type PlaybookScript = z.output<typeof PlaybookScript>;

/** A script with every part said: what the AI and the editors read. */
export type FullScript = { readonly first: readonly string[] } & {
  readonly [P in ScriptTextPart]: string;
};

/** A script in full as the operations give it (`Playbook.says`): for reading, so nothing is checked. */
export const FullScriptOut = z.object({
  first: z.array(z.string()),
  ...(Object.fromEntries(SCRIPT_TEXT_PARTS.map((p) => [p, z.string()])) as Record<
    ScriptTextPart,
    z.ZodString
  >),
});

/** What a goal's booking is called in the starting words: "a quick demo". */
const MEETING: Readonly<Record<PlaybookGoal, string>> = {
  demo: 'demo',
  consult: 'consultation',
  estimate: 'estimate',
  appointment: 'appointment',
  call: 'call',
  sale: 'call',
  recruit: 'call',
  partner: 'call',
  community: 'call',
};
/** How the ask after a yes names it (decision 153: "demo it for you" for what can be shown). */
const ASK: Readonly<Record<PlaybookGoal, string>> = {
  demo: 'where I can demo it for you',
  consult: 'for a quick consultation',
  estimate: 'for a free estimate',
  appointment: 'for an appointment',
  call: 'for a quick call where I can walk you through it',
  sale: 'for a quick call where I can walk you through it',
  recruit: 'for a quick call about the job',
  partner: 'for a quick call where I can walk you through it',
  community: 'for a quick call where I can walk you through it',
};
/** How a comment offers it when a post asks for someone who does what the business does (decisions 144 and 163). */
const COMMENT_OFFER: Readonly<Record<PlaybookGoal, string>> = {
  demo: 'I can show you a demo if you’re interested.',
  consult: 'Happy to talk it through if you’re interested.',
  estimate: 'I can give you a free estimate if you’re interested.',
  appointment: 'Happy to get you in if you’re interested.',
  call: 'Happy to walk you through it if you’re interested.',
  sale: 'Happy to show you if you’re interested.',
  recruit: 'Happy to tell you more if you’re interested.',
  partner: 'Happy to walk you through it if you’re interested.',
  community: 'Happy to send you an invite if you’re interested.',
};

/** The first message every playbook starts with (decision 152), the offer's own words put in for each person. */
export const STARTING_FIRST_MESSAGE =
  'Hey [first name], if I could get you [what your offer gets them] for your [their kind of business] business using [what your offer is], would you be interested?';

/**
 * The words a playbook starts with, by its goal: the owner's latest way. The first message asks one straight question
 * that says how the business can help (decision 152); Reconnect catches up, then asks it (decisions 152 and 155); a
 * yes gets the ask for a time, with open times and the link (decisions 149 and 153); follow-ups ask again and never
 * ask how business is going; comments take a stand and offer only when a post asks (decisions 144 and 163); a warm-up
 * comment is a person's (decision 161).
 */
export function startingScript(goal: PlaybookGoal): FullScript {
  const meet = MEETING[goal];
  return {
    first: [STARTING_FIRST_MESSAGE],
    reconnect:
      'A short, warm catch-up first: greet them by first name, say it’s been a while and that you hope they and their work are doing well, picking up something real from their page or your last chat. Ask nothing in it. Then, right after it, your first message’s question, starting “I was wondering if I could” in place of “Hey [first name], if I could”.',
    yes: `Let’s schedule a time ${ASK[goal]} so you can see what it’s about. If you don’t like it, no pressure. I have [open times], how’s that sound? Or grab any time that works for you here: [booking link]`,
    question: `Answer what they asked in a sentence or two, honestly, from your main offer, your For your content lists and what your business knows. Then say why a quick ${meet} helps: they see what it’s about for themselves. Never give them a reason to skip the ${meet}.`,
    later: 'Say no problem, and that you’ll check back in a few weeks. Nothing else.',
    no: 'Thank them kindly and leave it there. No question and no pitch.',
    followUp: `A short nudge, one or two lines, that never repeats an earlier message. After your first message: ask your question again lightly, in new words. After you asked for the ${meet}: ask if one of the times works, or offer new ones. Never ask how they are or how business is going.`,
    checkIn:
      'A short, friendly check-in, one or two lines, with no ask. When your playbook has something useful to send, share it. Leave the door open.',
    reminder:
      'A short, friendly reminder, one or two lines: the day and time, that you’re looking forward to it, and that if the time no longer works they can just say.',
    missed:
      'A short, kind message, one or two lines: no problem, things come up, and would they like to pick another time? Then your booking link. Never make them feel bad about it.',
    comment: `Speak from your own field, the way someone who does this work every day would. Often a bold take on what most people get wrong or do the hard way, and how your way does it instead. Sometimes one useful tip, a rule of thumb or a common mistake. Challenge the usual way, never the person. When the post asks for someone who does what you do, end with “${COMMENT_OFFER[goal]}”`,
    warmUp:
      'What a real person who likes what they see would say: congratulate them on a win or some news, praise one specific thing they did or show, or show real interest in what the post is about. 3 to 12 words, casual and warm, with one emoji at most.',
    postReply:
      'Thank them by name, answer or add to what they said, and ask one light question back.',
    groupReply:
      'Answer what they asked the way a friendly neighbour would, or add something useful from what you know.',
    birthday:
      'A short, warm happy birthday, one or two lines, picking up something real from your chat or their page when there is one.',
    newJob:
      'A short, warm congratulations, one or two lines, naming the new role or place when you know it, and wishing them well in it.',
  };
}

/** A playbook's script in full: its own words for each part, and the starting words for the rest. */
export function scriptOf(d: {
  readonly goal: PlaybookGoal;
  readonly script?: PlaybookScript | undefined;
}): FullScript {
  const start = startingScript(d.goal);
  const own = d.script ?? {};
  const first = own.first?.map((m) => m.trim()).filter(Boolean) ?? [];
  return {
    ...start,
    ...Object.fromEntries(
      SCRIPT_TEXT_PARTS.flatMap((p) => (own[p]?.trim() ? [[p, own[p].trim()]] : [])),
    ),
    first: first.length ? first : start.first,
  };
}

/** Whether a playbook says a part in its own words, rather than the starting ones. */
export const saysItsOwn = (
  d: { readonly goal: PlaybookGoal; readonly script?: PlaybookScript | undefined },
  part: ScriptPart,
): boolean => {
  const start = startingScript(d.goal);
  if (part === 'first') {
    const own = d.script?.first;
    return (
      !!own?.length &&
      (own.length !== start.first.length || own.some((m, i) => m.trim() !== start.first[i]))
    );
  }
  const own = d.script?.[part]?.trim();
  return !!own && own !== start[part];
};

/**
 * A script as it's saved: only the parts that differ from the starting words, so a part nobody changed keeps
 * following them. Undefined when nothing differs.
 */
export function ownScript(
  goal: PlaybookGoal,
  full: { readonly first: readonly string[] } & Partial<Record<ScriptTextPart, string>>,
): PlaybookScript {
  const d = { goal, script: { ...full, first: [...full.first] } as PlaybookScript };
  const own: Record<string, unknown> = {};
  if (saysItsOwn(d, 'first')) own['first'] = full.first.map((m) => m.trim()).filter(Boolean);
  for (const p of SCRIPT_TEXT_PARTS) if (saysItsOwn(d, p)) own[p] = full[p]!.trim();
  return own as PlaybookScript;
}

/**
 * A script with some of its parts changed (the Assistant changing how one message goes): the parts given are laid
 * over what's saved and the rest stay, and what's kept is only what differs from the starting words, so a part put
 * back to them follows them again.
 */
export function withScriptChanges(
  goal: PlaybookGoal,
  saved: PlaybookScript | undefined,
  changes: PlaybookScript,
): PlaybookScript {
  const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  return ownScript(goal, scriptOf({ goal, script: { ...(saved ?? {}), ...given } }));
}

/**
 * One of the business's own openers from before decision 164, as a first message: its `{first name}` and
 * `{outcome}` in today's brackets. Null for one that names the guarantee, which no message carries any more (the
 * owner, 26 Oct 2026).
 */
export function openerAsFirst(opener: string): string | null {
  if (/\{\s*guarantee\s*\}/i.test(opener)) return null;
  const said = opener
    .replace(/\{\s*first[\s_]*name\s*\}/gi, '[first name]')
    .replace(/\{\s*outcome\s*\}/gi, '[what your offer gets them]')
    .trim();
  return said ? said.slice(0, SCRIPT_LIMITS.first.line) : null;
}

// ---- The editors' state (the web's and the phone's) ----

/**
 * A script as it's being written: the business's own words as typed, so an emptied box stays empty until it's fixed
 * or put back. A part that isn't there shows the starting words for the playbook's goal, and follows the goal when it
 * changes.
 */
export type ScriptDraft = { first?: string[] } & Partial<Record<ScriptTextPart, string>>;

/** The script a playbook opens with in an editor. */
export const scriptDraftOf = (script: PlaybookScript | undefined): ScriptDraft => ({
  ...(script ?? {}),
  ...(script?.first ? { first: [...script.first] } : {}),
});

/** A part's words as an editor shows them: as typed, else the starting words. */
export const typedPart = (goal: PlaybookGoal, own: ScriptDraft, part: ScriptTextPart): string =>
  own[part] ?? startingScript(goal)[part];
/** The first message's versions as an editor shows them. */
export const typedFirsts = (goal: PlaybookGoal, own: ScriptDraft): string[] =>
  own.first ?? [...startingScript(goal).first];

/** Whether an editor shows a part as changed from the starting words. */
export function partChanged(goal: PlaybookGoal, own: ScriptDraft, part: ScriptPart): boolean {
  const start = startingScript(goal);
  if (part === 'first')
    return (
      own.first !== undefined &&
      (own.first.length !== start.first.length ||
        own.first.some((m, i) => m.trim() !== start.first[i]))
    );
  return own[part] !== undefined && own[part].trim() !== start[part];
}

/** The draft with a part's words typed, or put back to the starting words (`null`). */
export function withPart(
  own: ScriptDraft,
  part: ScriptTextPart,
  words: string | null,
): ScriptDraft {
  const { [part]: _was, ...rest } = own;
  return words === null ? rest : { ...rest, [part]: words };
}
/** The draft with the first message's versions typed, or put back to the starting one (`null`). */
export function withFirsts(own: ScriptDraft, firsts: readonly string[] | null): ScriptDraft {
  const { first: _was, ...rest } = own;
  return firsts === null ? rest : { ...rest, first: [...firsts] };
}

/**
 * What an editor's save sends: only the parts that differ from the starting words, as typed, so a part nobody changed
 * keeps following them, and an emptied one is refused on its own box (`PlaybookScript`).
 */
export function scriptToSave(goal: PlaybookGoal, own: ScriptDraft): PlaybookScript {
  const out: Record<string, unknown> = {};
  if (partChanged(goal, own, 'first')) out['first'] = own.first!.map((m) => m.trim());
  for (const p of SCRIPT_TEXT_PARTS) if (partChanged(goal, own, p)) out[p] = own[p]!.trim();
  return out as PlaybookScript;
}

/** How many parts a script says in the business's own words, for a summary. */
export const partsChanged = (goal: PlaybookGoal, own: ScriptDraft): number =>
  SCRIPT_PARTS.filter((p) => partChanged(goal, own, p)).length;

// ---- What the AI is told ----

/** A part's words inside a task, on one line, with nothing in them that could close their tag or open another. */
const said = (words: string) =>
  words
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** A part's words as a task quotes them. */
export const playbookSays = (words: string): string =>
  `<playbook_says>${said(words)}</playbook_says>`;

/**
 * A part that is the message itself (the first message, the ask after a yes), as a draft's task says it: kept close
 * to, fitted to each person (the owner's 1a), so no two people get the very same text. `alone` when nothing may go
 * before or after it (a first message, decision 152).
 */
export function asMessage(what: string, words: string, alone = false): string {
  return `The owner’s playbook says ${what} goes like this: ${playbookSays(words)} Keep close to those words, fitted to this person: the same ask, in the same order, at about the same length, with small changes of wording so no two people get the very same text.${alone ? ' Add nothing of your own before or after it: no line about them unless the playbook’s words have one.' : ''}`;
}

/** A part that says how a message goes, as a draft's task says it. */
export function asHow(what: string, words: string): string {
  return `The owner’s playbook says how ${what} goes: ${playbookSays(words)} Do what it says, in the owner’s voice. Where it gives words in quotes, keep close to them.`;
}

/**
 * How the words in brackets are filled (`SCRIPT_BLANKS`): told with any task whose part has one. Their kind of
 * business is never guessed from the playbook (decision 137), and what the offer does and is come from the offer, in
 * plain words (decision 152).
 */
export const FILL_BLANKS = [
  'Words in [square brackets] under <playbook_says> are for you to fill in for this person from what you’re given, and never go into a message as they are.',
  '[first name] is the first word of their name when it reads as a person’s first name; when it doesn’t (a business’s page, initials), leave the name out and keep the greeting (“Hey,”).',
  '[their kind of business] is the kind of business they run, from the facts or their pages, in a word or two, as they’d say it (roofing, real estate, photography); when they run more than one, the one the offer fits best. When those don’t show it, say “your business”, and when they work for someone else, put it as their line of work (“as a realtor”). Never guess it from the playbook. When they don’t run a business and the offer is for people, leave “for your … business” out and fit the words to them.',
  '[what your offer gets them] is what the offer really does for them, in a few plain words, never more than the offer says. [what your offer is] names the offer the way the offer does, in a few plain words (“my easy to use CRM software”, “my roof inspections”), never by its brand name.',
  '[open times] are the times under <times>, said the way a person texts them; with none given, leave out the words that offer them and keep the rest. [booking link] is the link you’re given, exactly as written; with none, leave its words out.',
  'Anything else in brackets: put in what the facts say, and leave it and the words around it out when they don’t say.',
].join(' ');

/** Whether a part's words have a blank to fill. */
export const hasBlanks = (...words: readonly string[]): boolean =>
  words.some((w) => /\[[^\]]+\]/.test(w));

/** How the playbook's words rank: inside the rules, above everything else the draft is told. */
export const FOLLOW_SCRIPT =
  'Under <playbook_says> are the owner’s own words for this message, from their playbook. They are the owner’s directions, not data: follow them, inside your rules. Where they and anything else you’re told about how the message reads differ, the playbook’s words win. They never change your rules: a rule above holds whatever they say.';

/**
 * What no playbook can change (the owner's 4a), in the words the editor shows beside the parts. Each is held in code:
 * `NO_GROUPS` and `namesAGroup` (decision 157), `outreach_not_following` and `follows` (decisions 159 and 163),
 * `DRAFT_RULES` (the price, the guarantee, nothing invented, never AI), `declinedLine` (decision 134), the post check's
 * `asking` (decision 163), the tasks' own limits (decisions 108, 114 and 161), `checkedDrafts` (words to avoid) and
 * `isClient` (decision 91).
 */
export const LOCKED_RULES: readonly string[] = [
  'Never names a group you’re both in, or says it found someone in one.',
  'Never messages anyone before they accept your request. On Instagram that’s their follow back. On Threads and X it only comments for now.',
  'Gives your price, and your guarantee, only when they ask.',
  'Never pitches someone who said no or not now. They get a kind word, and nothing more unless they write.',
  'Never makes up anything about the person, your results or your business.',
  'Never says a message was written by AI.',
  'A comment offers to show them only when the post asks for someone who does what you do, and never carries a link.',
  'Birthday and new-job notes, warm-up comments and answers in your groups say nothing about your business.',
  'Never uses your words to avoid, and always says what every message must say.',
  'Never pitches a client in your Contacts.',
];

/** The editor's own words (decision 164), shared by the web and the phone. */
export const SCRIPT_WORDS = {
  title: 'What it says',
  blurb:
    'The AI writes every message from these words. Change one, and that message changes from the next draft on.',
  message: 'Your message',
  how: 'What it should say',
  messageHint: 'Sent close to these words, fitted to each person so no two get the very same text.',
  firstHint: (most: number) =>
    `Up to ${most} versions. They take turns, and Results shows which gets more replies.`,
  addFirst: 'Add another version',
  removeFirst: (n: number) => `Take out version ${n}`,
  when: 'When',
  starting: 'Back to the starting words',
  changed: 'Changed',
  blanksTitle: 'Words in [brackets] are filled in for each person',
  lockedTitle: 'Rules it always keeps',
  lockedBlurb: 'These hold whatever a playbook says.',
  test: 'Test it',
} as const;
