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
 * A playbook that starts with an introduction (decisions 168 and 173) has a networking chat's parts too: the nudge after
 * it, the offers of a demo and a networking call, the line about sending people their way, and the ask for a time on a
 * networking call. Each offer goes only while its switch is on (`PLAYBOOK_NETWORKING`), and how the chat goes, as keen
 * as they are, is the playbook's too (`PLAYBOOK_CHAT`, decision 180).
 *
 * A playbook may start a chat more than one way (decision 183, `OPEN_WAYS`): the first message's question, the
 * introduction, and eight more, each with its own part; for each person the AI picks the one that fits best.
 *
 * Every playbook has a referral's parts too (decision 174): the comment that names someone the owner has talked with
 * under a post asking for a recommendation, and the heads-up to them with its link, while Refer them on posts is on
 * (`PLAYBOOK_REFER`).
 *
 * Words in [square brackets] are filled in for each person (`SCRIPT_BLANKS`, `FILL_BLANKS`). Browser-safe: the web's
 * and the phone's editors, the Test console and the server read it.
 */
import { z } from 'zod';
import { PLATFORMS } from './networks';
import type { PlaybookGoal } from './playbooks';

/** The parts, in the order a conversation meets them. */
export const SCRIPT_PARTS = [
  'first',
  'intro',
  'valueFirst',
  'trigger',
  'compliment',
  'opinion',
  'socialProof',
  'permission',
  'sharedGround',
  'problemCheck',
  'nudge',
  'demoOffer',
  'callOffer',
  'sendPeople',
  'callYes',
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
  'referComment',
  'referNote',
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
  intro: {
    label: 'Introduction',
    when: 'In place of the first message, when the playbook starts with an introduction: once they accept your request, you accept theirs, or they follow you, after the days you set under Steps and pace. Its question about them, to get them talking, goes right after it as a second message when you send messages as a few texts.',
    says: 'message',
  },
  valueFirst: {
    label: 'Value first',
    when: 'In place of the first message, when the AI picks Value first for someone: it opens with a quick tip, or offers your free thing.',
    says: 'how',
  },
  trigger: {
    label: 'Trigger event',
    when: 'In place of the first message, when the AI picks Trigger event for someone: something they posted about lately, like a move, a new location or a new job.',
    says: 'how',
  },
  compliment: {
    label: 'Compliment first',
    when: 'In place of the first message, when the AI picks Compliment first for someone: something real it likes on their page.',
    says: 'how',
  },
  opinion: {
    label: 'Ask for their opinion',
    when: 'In place of the first message, when the AI picks Ask for their opinion for someone.',
    says: 'how',
  },
  socialProof: {
    label: 'Social proof',
    when: 'In place of the first message, when the AI picks Social proof for someone: a real result from your playbook or main offer.',
    says: 'how',
  },
  permission: {
    label: 'Permission ask',
    when: 'In place of the first message, when the AI picks Permission ask for someone. Their yes gets the video, then your ask for a time.',
    says: 'how',
  },
  sharedGround: {
    label: 'Shared ground',
    when: 'In place of the first message, when the AI picks Shared ground for someone: something true you have in common.',
    says: 'how',
  },
  problemCheck: {
    label: 'Problem check',
    when: 'In place of the first message, when the AI picks Problem check for someone: a problem their page shows that your offer fixes.',
    says: 'how',
  },
  nudge: {
    label: 'Nudge after the first message',
    when: 'Once, a couple of days after a first message that starts a chat (an introduction, a compliment and the like), when they haven’t written. After it, only a friendly check-in once a month.',
    says: 'how',
  },
  demoOffer: {
    label: 'Offering a demo',
    when: 'Once in a chat, right after a quick answer, when they ask about what you do, your offer or how it works, or also when they name a problem you fix if How the chat goes says so. Only while Offer a demo is on.',
    says: 'message',
  },
  callOffer: {
    label: 'Offering a networking call',
    when: 'Once in a chat, with your own calendar’s link, by the reply How the chat goes says: to wrap it up when they only answer your questions, or as the next step when they’re chatting back. Only while Offer a networking call is on.',
    says: 'message',
  },
  sendPeople: {
    label: 'Sending people their way',
    when: 'Once in a chat, in the message that wraps it up, right after the networking call offer. Only while Offer to send people their way is on.',
    says: 'message',
  },
  callYes: {
    label: 'When they say yes to a call',
    when: 'Right after they say yes to a networking call. It offers times on your own calendar, not your demo’s.',
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
  referComment: {
    label: 'Referring them on a post',
    when: 'Under a post asking for a recommendation of what someone you’ve talked with does. Only while Refer them on posts is on, and only after your OK on Today.',
    says: 'message',
  },
  referNote: {
    label: 'The heads-up to them',
    when: 'To the person you referred, with the post’s link, right after your comment.',
    says: 'message',
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
  {
    key: 'start',
    title: 'Starting a chat',
    parts: [
      'first',
      'intro',
      'valueFirst',
      'trigger',
      'compliment',
      'opinion',
      'socialProof',
      'permission',
      'sharedGround',
      'problemCheck',
      'reconnect',
    ],
  },
  {
    key: 'networking',
    title: 'The networking chat',
    parts: ['nudge', 'demoOffer', 'callOffer', 'sendPeople', 'callYes'],
  },
  { key: 'answers', title: 'When they answer', parts: ['yes', 'question', 'later', 'no'] },
  { key: 'quiet', title: 'When they go quiet', parts: ['followUp', 'checkIn'] },
  { key: 'booking', title: 'Around a booking', parts: ['reminder', 'missed'] },
  {
    key: 'public',
    title: 'In public',
    parts: ['comment', 'warmUp', 'postReply', 'groupReply'],
  },
  {
    key: 'refer',
    title: 'Referring people you’ve talked with',
    parts: ['referComment', 'referNote'],
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
  { blank: '[calendar link]', fills: 'Your own calendar’s booking link, for a networking call' },
  { blank: '[your first name]', fills: 'Your first name, from your HandsFreeOS account' },
  { blank: '[your business name]', fills: 'Your business’s name' },
  {
    blank: '[something you have in common]',
    fills:
      'One true thing you share with them, like both running a business, or both working nearby',
  },
  {
    blank: '[a question about them]',
    fills: 'One friendly question about them, from something specific on their page',
  },
  { blank: '[what they do]', fills: 'What they do, in their own words' },
  { blank: '[their area]', fills: 'Where they work, or “anywhere” when they work nationwide' },
  { blank: '[their name]', fills: 'Their name as it shows on their page, so you can tag them' },
  { blank: '[what they need]', fills: 'What the post asks for, in a few words' },
  { blank: '[post link]', fills: 'The link to the post' },
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
  intro: part,
  valueFirst: part,
  trigger: part,
  compliment: part,
  opinion: part,
  socialProof: part,
  permission: part,
  sharedGround: part,
  problemCheck: part,
  nudge: part,
  demoOffer: part,
  callOffer: part,
  sendPeople: part,
  callYes: part,
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
  referComment: part,
  referNote: part,
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
 * The introduction a playbook starts with (decision 168, the owner, 15 Nov 2026: "thanks for connecting and who we are
 * and what we offer"): sent in place of the first message's question by a playbook that starts with one (`opens`). It
 * ends with a question about them (decision 173, the owner, 16 Nov 2026: "people like talking about themselves so if
 * there is anything from their profile we can pick up specifically then we should try to do that so it doesn't look
 * like a generic message"). Right after the thanks, one true thing the owner and they have in common (decision 181, the
 * owner's friend, 19 Nov 2026: "You’re skipping the identify part ... Find a way to say I see you own a business too
 * ... Share a commonality"), so they feel a connection before the owner says what the business does.
 */
export const STARTING_INTRO =
  'Hey [first name], thanks for connecting! [something you have in common] I’m [your first name] with [your business name]. We help [their kind of business] businesses get [what your offer gets them] with [what your offer is]. [a question about them]';

/**
 * The networking chat's offers (decision 173, the owner's words, 16 Nov 2026): a networking call "where i can learn a
 * bit more about them", and "if I know of anyone in their area (or if they are nationwide) that needs what they do i'll
 * make sure to mention them". The demo is offered only when they ask about the business (decision 176, the owner, 18
 * Nov 2026: "give a quick response to answer then say I’d love to show you a demo if you have a bit of time in the
 * next week or so"), and the chat wraps up with the call and the line about sending people their way in one message
 * (the owner, 18 Nov 2026: "if they ever want to network and see how we can support each other or refer each other
 * then let’s jump on a call and then send the Chris’s calendar and then say if i see anyone online looking for your
 * services in your area I’ll be sure to mention you").
 */
export const STARTING_DEMO_OFFER =
  'I’d love to show you a demo if you have a bit of time in the next week or so.';
export const STARTING_CALL_OFFER =
  'If you ever want to network and see how we can support each other or refer each other, let’s jump on a call. Here’s my calendar: [calendar link]';
export const STARTING_SEND_PEOPLE =
  'If I see anyone online looking for [what they do] in [their area], I’ll be sure to mention you.';

/**
 * A referral (decision 174, the owner, 16 Nov 2026: "we need to build the skill of referring these people on relevant
 * posts, only the ones that we've had a decent conversation with"): a comment naming them under a post asking for what
 * they do, honest about how the owner knows them, and a heads-up to them with the post's link.
 */
export const STARTING_REFER_COMMENT =
  'You should reach out to [their name]! They do [what they do] in [their area], and I’ve really enjoyed getting to know them.';
export const STARTING_REFER_NOTE =
  'Hey [first name], someone was just asking for [what they need], so I mentioned you. Here’s the post if you want to jump in: [post link]';

/**
 * How each other way to start a chat goes (decision 183, the owner, 20 Nov 2026: "allow the user to select which methods
 * they want the ai to be able to use either or all and the ai would select one based on the contacts profile, posts,
 * platform, business"), from the owner's own examples. Each says how the message goes, so the AI fits it to what it
 * found on their page; its example in quotes is kept close to. None carries a link: what it offers goes once they say
 * yes.
 */
export const STARTING_WAYS: Readonly<
  Record<Exclude<OpenWayPart, 'first' | 'intro'>, string>
> = {
  valueFirst:
    'Open with something free and useful for them, picked from what their page shows they’re working on: one quick tip from your main offer and its lists, or your free thing from Something useful to send. Like: “Hey [first name], saw you’re [what they’re working on]. Here’s a quick tip that helps with that: [the tip]. I also have [your free thing] if you want it. Want me to send it over?” No link in it, and one question, at the end.',
  trigger:
    'Mention something that just happened to them, from what they posted in the last month: a new location, hiring, a launch, a move, a new job, an engagement, a new baby, or a post asking for recommendations. Congratulate them or say something kind about it, then ask one easy question about it. Like: “Hey [first name], congrats on the new location! How’s the first week going?” Only news they posted themselves. Never health, a loss or money trouble. No pitch.',
  compliment:
    'Say one real, specific thing you like about a post of theirs, their work or their page, then ask one easy question about it. Like: “Hey [first name], that kitchen you posted came out so clean. How long did that one take?” Never praise that would fit anyone. No pitch.',
  opinion:
    'Ask for their quick take on what you’re working on for people like them, so your offer comes up on its own. Like: “Hey [first name], I’m working on [what your offer is] for [their kind of business] businesses and would love your quick take. What’s the hardest part of [the problem it fixes] for you?” No pitch.',
  socialProof:
    'Share one real result you got for someone like them, from your playbook’s proof or your main offer’s results, then ask if they’d like to see how. Like: “Hey [first name], I just helped a [business like theirs] get [the result]. Want to see how?” Only a result you were given: never make one up.',
  permission:
    'Ask if you can send them a quick video that shows what your offer gets them, so they say a small yes first. Like: “Hey [first name], mind if I send you a quick video showing how [their kind of business] businesses get [what your offer gets them]?” No link in it.',
  sharedGround:
    'Open with one true thing you have in common: your town or area, a school, your line of work, or mutual friends. Then ask one easy question. Like: “Hey [first name], always great to meet another business owner here in [their area]! How long have you been at it?” Never a group you’re both in, and never a guess.',
  problemCheck:
    'Point out, kindly, one problem their page shows that your offer fixes: no website or booking link, no posts in months, or no reviews. Then offer a quick idea to fix it. Like: “Hey [first name], I noticed there’s no way to book with you from your page. Want a quick idea that could help you get more bookings?” Only what their page shows: never call them out, and never guess.',
};

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
    intro: STARTING_INTRO,
    ...STARTING_WAYS,
    nudge:
      'One short, friendly line: pick up your question about them lightly, in new words, or ask another easy one about them from their page. No pitch and no ask for a call, and never “just following up” or “bumping this”.',
    demoOffer: STARTING_DEMO_OFFER,
    callOffer: STARTING_CALL_OFFER,
    sendPeople: STARTING_SEND_PEOPLE,
    callYes:
      'Great! I have [open times], do any of those work? Or grab any time that works for you here: [booking link]',
    reconnect:
      'A short, warm catch-up first: greet them by first name, say it’s been a while and that you hope they and their work are doing well, picking up something real from their page or your last chat. Ask nothing in it. Then, right after it, your first message’s question, starting “I was wondering if I could” in place of “Hey [first name], if I could”.',
    yes: `Let’s schedule a time ${ASK[goal]} so you can see what it’s about. If you don’t like it, no pressure. I have [open times], how’s that sound? Or grab any time that works for you here: [booking link]`,
    question: `Answer what they asked in a sentence or two, honestly, from your main offer, your For your posts and messages lists and what your business knows. Then say why a quick ${meet} helps: they see what it’s about for themselves. Never give them a reason to skip the ${meet}.`,
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
    referComment: STARTING_REFER_COMMENT,
    referNote: STARTING_REFER_NOTE,
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

// ---- How a playbook's first message goes (decision 168) ----

/**
 * Before decision 183, the one way a playbook started a chat; still saved beside its ways (`opensFor`) for a phone built
 * before them, and read for a playbook saved before them (`waysOf`).
 *
 * How a playbook starts a chat with someone who just connected (decision 168, the owner's 1a): the first message's
 * question (`pitch`, decisions 152 and 164), or an introduction in its place (`intro`): thanks for connecting, who the
 * owner is and what the business offers, and a question about them (decision 173), as a text of its own right after it
 * when the person sends a few (decision 175). A networking chat follows: one nudge if they stay quiet, then a check-in
 * once a month; a demo or a networking call offered once each, when it fits; and a yes to either gets the ask for a
 * time.
 */
export const PLAYBOOK_OPENS = {
  pitch: {
    label: 'Pitch',
    hint: 'Your first message asks straight out if they’d be interested, and follow-ups ask again when they go quiet.',
  },
  intro: {
    label: 'Introduction',
    hint: 'Thanks them for connecting, says something you have in common, who you are and what you offer, then asks them something about themselves in a second message to get them talking. Then a friendly chat, one nudge if they’re quiet, and a check-in once a month.',
  },
} as const;
export type PlaybookOpens = keyof typeof PLAYBOOK_OPENS;
export const PLAYBOOK_OPENS_KEYS = Object.keys(PLAYBOOK_OPENS) as [
  PlaybookOpens,
  ...PlaybookOpens[],
];

// ---- The ways to start a chat (decision 183) ----

/**
 * The ways a playbook may start a chat with someone new (decision 183, the owner, 20 Nov 2026: "allow the user to
 * select which methods they want the ai to be able to use either or all and the ai would select one based on the
 * contacts profile, posts, platform, business"). The playbook ticks the ones it may use (`details.ways`), and for each
 * person the AI picks the one that fits best (./today.ts `openerTask`).
 *
 * - `flow` is what follows it (the owner's 2a): `ask` ways ask about the offer, so they go as the pitch does (a yes gets
 *   the ask for a time, quiet gets follow-ups); `chat` ways start a chat, so they go as an introduction does (one nudge,
 *   a short networking chat, then the call or a demo, decisions 173 to 180).
 * - `needs` is what the business must have given for it, or the AI never picks it (the owner's 6a): a real result
 *   (`proof`), something free to send (`useful`), or a video (`video`).
 * - `bestOn` is the networks it tends to suit (the owner's 5a): the AI leans on it, with no setting.
 * - `fits` says whom it suits: businesses (`b2b`), or anyone (`both`).
 */
export const OPEN_WAYS = {
  pitch: {
    label: 'Direct pitch',
    hint: 'Asks straight out if they’d be interested.',
    flow: 'ask',
    part: 'first',
    needs: null,
    bestOn: [],
    fits: 'both',
  },
  intro: {
    label: 'Introduction',
    hint: 'Thanks them for connecting, says what you have in common, who you are and what you offer, then asks about them.',
    flow: 'chat',
    part: 'intro',
    needs: null,
    bestOn: [],
    fits: 'both',
  },
  valueFirst: {
    label: 'Value first',
    hint: 'Opens with something free and useful: a quick tip, or your free thing.',
    flow: 'ask',
    part: 'valueFirst',
    needs: 'useful',
    bestOn: ['facebook', 'instagram'],
    fits: 'both',
  },
  trigger: {
    label: 'Trigger event',
    hint: 'Mentions something that just happened to them, like a new location, a move or a new job.',
    flow: 'chat',
    part: 'trigger',
    needs: null,
    bestOn: [],
    fits: 'both',
  },
  compliment: {
    label: 'Compliment first',
    hint: 'Says one real thing it likes about their post or work, then asks a question.',
    flow: 'chat',
    part: 'compliment',
    needs: null,
    bestOn: ['facebook', 'instagram'],
    fits: 'both',
  },
  opinion: {
    label: 'Ask for their opinion',
    hint: 'Asks their quick take on what you’re working on. People like to give it.',
    flow: 'chat',
    part: 'opinion',
    needs: null,
    bestOn: [],
    fits: 'both',
  },
  socialProof: {
    label: 'Social proof',
    hint: 'Shares a real result you got for someone like them, and asks if they want to see how.',
    flow: 'ask',
    part: 'socialProof',
    needs: 'proof',
    bestOn: ['linkedin'],
    fits: 'both',
  },
  permission: {
    label: 'Permission ask',
    hint: 'Asks if it can send a quick video. A small yes first, then the video.',
    flow: 'ask',
    part: 'permission',
    needs: 'video',
    bestOn: [],
    fits: 'both',
  },
  sharedGround: {
    label: 'Shared ground',
    hint: 'Opens with what you have in common: your town, a school, your line of work or mutual friends. Never a group.',
    flow: 'chat',
    part: 'sharedGround',
    needs: null,
    bestOn: ['facebook', 'instagram'],
    fits: 'both',
  },
  problemCheck: {
    label: 'Problem check',
    hint: 'Points out a problem their page shows, like no booking link, and offers a quick idea to fix it.',
    flow: 'ask',
    part: 'problemCheck',
    needs: null,
    bestOn: ['linkedin'],
    fits: 'b2b',
  },
} as const satisfies Record<
  string,
  {
    readonly label: string;
    readonly hint: string;
    readonly flow: 'ask' | 'chat';
    readonly part: ScriptPart;
    readonly needs: 'proof' | 'useful' | 'video' | null;
    readonly bestOn: readonly ('facebook' | 'instagram' | 'linkedin')[];
    readonly fits: 'both' | 'b2b';
  }
>;
export type OpenWay = keyof typeof OPEN_WAYS;
export const OPEN_WAY_KEYS = Object.keys(OPEN_WAYS) as [OpenWay, ...OpenWay[]];
export const isOpenWay = (v: unknown): v is OpenWay =>
  typeof v === 'string' && (OPEN_WAY_KEYS as readonly string[]).includes(v);
/** The script parts the ways are written in. */
export type OpenWayPart = (typeof OPEN_WAYS)[OpenWay]['part'];
export type WayNeed = NonNullable<(typeof OPEN_WAYS)[OpenWay]['needs']>;

/** Whether a way starts a chat (an introduction's networking chat follows) rather than asking about the offer. */
export const startsAChat = (way: OpenWay): boolean => OPEN_WAYS[way].flow === 'chat';

/**
 * The ways a playbook may start a chat, in the list's order: its ticks, none for a new one not ticked yet (it starts no
 * chat till one is: the owner, 20 Nov 2026, "they all start unticked and have to choose which ones they want to move
 * forward"), or for one saved before them the way it chose then (decision 168: the first message's question, or an
 * introduction).
 */
export function waysOf(
  d: {
    readonly ways?: readonly OpenWay[] | null | undefined;
    readonly opens?: PlaybookOpens | null | undefined;
  } | null,
): OpenWay[] {
  if (Array.isArray(d?.ways)) {
    const ticked = d.ways.filter(isOpenWay);
    return OPEN_WAY_KEYS.filter((w) => ticked.includes(w));
  }
  return [d?.opens === 'intro' ? 'intro' : 'pitch'];
}

/** Whether a playbook has a way ticked to start a chat with: one with none sends no first messages. */
export const hasWays = (d: Parameters<typeof waysOf>[0]): boolean => waysOf(d).length > 0;

/** Whether a playbook may start a chat one of the ways that start a chat: its networking chat's parts apply. */
export const startsChats = (
  d: Parameters<typeof waysOf>[0],
): boolean => waysOf(d).some(startsAChat);

/**
 * Whether every way a playbook may start a chat starts one, so nobody is pitched: Say hi then takes everyone who
 * connects (decision 168's 3b), not only the people a check found fit.
 */
export const chatsOnly = (d: Parameters<typeof waysOf>[0]): boolean => {
  const ways = waysOf(d);
  return ways.length > 0 && ways.every(startsAChat);
};

/**
 * What the playbook's `opens` reads as for the ways ticked, for a phone built before them (decision 168): an
 * introduction when every way starts a chat, else the pitch.
 */
export const opensFor = (ways: readonly OpenWay[]): PlaybookOpens =>
  ways.length && ways.every(startsAChat) ? 'intro' : 'pitch';

/**
 * The first message's words for a way: the first message's versions for the pitch, the introduction, or the way's own
 * part.
 */
export function wayWords(says: FullScript, way: OpenWay): readonly string[] {
  const part = OPEN_WAYS[way].part;
  return part === 'first' ? says.first : [says[part]];
}

/**
 * The messages a playbook's first drafts can go with, way by way: the first message's versions for the pitch, the
 * introduction, and each other way's words.
 */
export function firstMessagesOf(d: {
  readonly goal: PlaybookGoal;
  readonly script?: PlaybookScript | undefined;
  readonly opens?: PlaybookOpens | null | undefined;
  readonly ways?: readonly OpenWay[] | null | undefined;
}): readonly { readonly way: OpenWay; readonly text: string }[] {
  const says = scriptOf(d);
  return waysOf(d).flatMap((way) => wayWords(says, way).map((text) => ({ way, text })));
}

/**
 * How many versions of the first message take turns while the pitch is ticked, for the Test console's picker; none
 * while it isn't.
 */
export const pitchVersionsOf = (d: Parameters<typeof firstMessagesOf>[0]): number =>
  firstMessagesOf(d).filter((f) => f.way === 'pitch').length;

/**
 * What a way needs that the business hasn't given (the owner's 6a): a real result, something free to send, or a video.
 * The AI never picks a way with something missing.
 */
export function wayMissing(
  way: OpenWay,
  has: { readonly proof: boolean; readonly useful: boolean; readonly video: boolean },
): WayNeed | null {
  const need = OPEN_WAYS[way].needs;
  return need && !has[need] ? need : null;
}

/**
 * What's wrong with the ways a playbook ticks (decision 183): none. A new playbook starts with none, and the editors
 * won't carry on until one is; saved like that (as it saves itself), it starts no chats.
 */
export const waysIssue = (ways: readonly OpenWay[] | null | undefined): string | null =>
  ways && ways.length === 0 ? WAYS_WORDS.none : null;

/** The ways' words on the web's and the phone's playbook editors. */
export const WAYS_WORDS = {
  title: 'Ways to start a chat',
  blurb:
    'Tick the ones the AI may use. For each person, it picks the one that fits their page, posts, network and business best.',
  none: 'Tick at least one way to start a chat.',
  flow: {
    ask: 'Asks about your offer. A yes gets your ask for a time, and quiet gets follow-ups.',
    chat: 'Starts a chat. Then one nudge if they’re quiet, and a short chat that leads to a call or a demo.',
  },
  b2b: 'Best for businesses',
  bestOn: (networks: readonly string[]) => `Works well on ${networks.join(' and ')}`,
  needs: {
    proof: 'Needs a real result. Add one under Proof for this niche, in the Niche step.',
    useful: 'Needs something free to send. Add it under Something useful to send, in the Offer step.',
    video: 'Needs a video. Add one in the Short video step, or in Settings → Videos.',
  } satisfies Record<WayNeed, string>,
  /** Beside the list: the warm-up switch, the playbook's Warm up step (decision 161, and the owner's 4b). */
  warmUp: 'Warm up first',
  warmUpHint:
    'Likes 1 or 2 of their posts and leaves one comment every few days while they decide on your request. Someone who accepts fast, or was already a friend, gets a few days of it before the first message.',
  picked: (n: number) => (n === 1 ? '1 way ticked' : `${n} ways ticked`),
} as const;

/**
 * How a playbook starts a chat, in a line for its card on the web and the phone (decision 183): the one way's words, or
 * the ways the AI picks from.
 */
export function waysLine(d: Parameters<typeof firstMessagesOf>[0]): string {
  const ways = waysOf(d);
  const firsts = firstMessagesOf(d);
  if (!ways.length) return 'No way to start a chat is ticked yet, so it starts none. Tick one under What it says.';
  if (ways.length > 1)
    return `Picks one of ${ways.length} ways to start a chat for each person: ${ways.map((w) => OPEN_WAYS[w].label).join(', ')}.`;
  const way = ways[0]!;
  const first = firsts[0]?.text.trim() ?? '';
  if (way === 'pitch')
    return firsts.length > 1
      ? `Starts with one of ${firsts.length} first messages, like “${first}”`
      : `Starts with “${first}”`;
  if (way === 'intro') return `Starts with an introduction: “${first}”`;
  return `Starts with ${OPEN_WAYS[way].label}: ${first}`;
}

/** What the business has given that some ways need (the owner's 6a): a real result, something free to send, a video. */
export interface WayHas {
  readonly proof: boolean;
  readonly useful: boolean;
  readonly video: boolean;
}

/** One row of the ways list on the web's and the phone's playbook editors. */
export interface WayRow {
  readonly way: OpenWay;
  readonly label: string;
  readonly hint: string;
  /** What follows it: the pitch's way or the networking chat's (the owner's 2a). */
  readonly flow: string;
  /** Short notes: whom it suits best, and the networks it tends to suit (the owner's 5a). */
  readonly tags: readonly string[];
  /** What it needs that isn't there yet, and where to add it: the AI skips it till then. */
  readonly missing: string | null;
  readonly on: boolean;
}

/** The ways list as the editors draw it, in its order, ticked or not. */
export function wayRows(ticked: readonly OpenWay[], has: WayHas): WayRow[] {
  return OPEN_WAY_KEYS.map((way) => {
    const w = OPEN_WAYS[way];
    const need = wayMissing(way, has);
    return {
      way,
      label: w.label,
      hint: w.hint,
      flow: WAYS_WORDS.flow[w.flow],
      tags: [
        ...(w.fits === 'b2b' ? [WAYS_WORDS.b2b] : []),
        ...(w.bestOn.length ? [WAYS_WORDS.bestOn(w.bestOn.map((n) => PLATFORMS[n]))] : []),
      ],
      missing: need ? WAYS_WORDS.needs[need] : null,
      on: ticked.includes(way),
    };
  });
}

/** The ways ticked once one is ticked or unticked, in the list's order. */
export const withWay = (ticked: readonly OpenWay[], way: OpenWay, on: boolean): OpenWay[] =>
  OPEN_WAY_KEYS.filter((w) => (w === way ? on : ticked.includes(w)));

/**
 * What the networking chat after an introduction may offer (decision 173, the owner: "these should be options in the
 * playbook and turn it on for me"): each once in a chat, only while its switch is on. All on to start, and for a
 * playbook saved before them. None of them does anything for a playbook that pitches.
 */
export const PLAYBOOK_NETWORKING = {
  demo: {
    label: 'Offer a demo',
    hint: 'Once, after a quick answer, when they ask about what you do or how it works. Or also when they name a problem you fix, under How the chat goes.',
  },
  call: {
    label: 'Offer a networking call',
    hint: 'Once, when it wraps up the chat, with a link to your own calendar, not your demo’s.',
  },
  sendPeople: {
    label: 'Offer to send people their way',
    hint: 'Once, in the same message that wraps up the chat.',
  },
} as const;
export type NetworkingSwitch = keyof typeof PLAYBOOK_NETWORKING;
export const NETWORKING_KEYS = Object.keys(PLAYBOOK_NETWORKING) as [
  NetworkingSwitch,
  ...NetworkingSwitch[],
];
export const PlaybookNetworking = z.object({
  demo: z.boolean().default(true),
  call: z.boolean().default(true),
  sendPeople: z.boolean().default(true),
});
export type PlaybookNetworking = z.output<typeof PlaybookNetworking>;
/** Every switch on: a new playbook's, and one saved before them. */
export const NETWORKING_ON: PlaybookNetworking = { demo: true, call: true, sendPeople: true };

/** What a playbook's networking chat may offer: nothing for one that pitches. */
export function networkingOf(
  d: {
    readonly opens?: PlaybookOpens | null | undefined;
    readonly ways?: readonly OpenWay[] | null | undefined;
    readonly networking?: Partial<PlaybookNetworking> | null | undefined;
  } | null,
): PlaybookNetworking {
  if (!startsChats(d)) return { demo: false, call: false, sendPeople: false };
  return { ...NETWORKING_ON, ...(d?.networking ?? {}) };
}

/**
 * How the networking chat after an introduction goes (decision 180, the owner, 18 Nov 2026: "make it more dynamic
 * based on the interest in the conversation of the person we are talking to but the intent is not to drag it out and
 * get to the point in the end which is the meeting or meetup. but all those options are good"): by which of their
 * replies it offers the call, how often it asks them something, how often it shares the owner's story, and when it
 * offers a demo. How keen they are decides the rest (./today.ts `networkingReplyTask`; the owner, 19 Nov 2026: "if the
 * lead is not reengaging the conversation by asking me questions ... then yeah 2 but if the person is having a
 * conversation that shows interest we don't need to necessarily wrap it up but try to lead it to a meeting"): only
 * answering, it wraps up by that reply, sooner when they're short with the owner; chatting back, it keeps going and
 * leads to the call by then. Each starts as the chat went before it (decision 176), and a playbook saved before it
 * reads so.
 */
export const CHAT_QUESTIONS = ['rarely', 'sometimes', 'often'] as const;
export type ChatQuestions = (typeof CHAT_QUESTIONS)[number];
export const CHAT_STORY = ['often', 'fits', 'never'] as const;
export type ChatStory = (typeof CHAT_STORY)[number];
export const CHAT_DEMO = ['asked', 'problem'] as const;
export type ChatDemo = (typeof CHAT_DEMO)[number];
/** By which of their replies it offers the call: their 1st, 2nd or 3rd. */
export const CHAT_WRAP_AFTER = { min: 1, max: 3 } as const;

/** Its words, on the web's and the phone's playbook editors. */
export const PLAYBOOK_CHAT = {
  title: 'How the chat goes',
  blurb:
    'It follows how keen they are and never drags it out. When they only answer your questions, it offers the call and wraps up. When they ask you things back, it keeps chatting and leads to the call.',
  wrapAfter: {
    label: 'Offer the call by',
    hint: 'When they only answer, it wraps up then too, or sooner if they go quiet. When they ask you things back, it keeps chatting.',
    option: (n: number) => `${n === 1 ? '1st' : n === 2 ? '2nd' : `${n}rd`} reply`,
  },
  questions: {
    label: 'Questions',
    hint: 'How often it asks them something. It never asks when it wraps up.',
    options: {
      rarely: { label: 'Rarely', hint: 'Only when the chat would stall' },
      sometimes: { label: 'Sometimes', hint: 'Every other reply at most' },
      often: { label: 'Often', hint: 'Most replies' },
    },
  },
  story: {
    label: 'Your story',
    hint: 'How often it shares a line from Your story, in Settings → Main offer → For your posts and messages.',
    options: {
      often: { label: 'Often', hint: 'Most replies' },
      fits: { label: 'When it fits', hint: 'When it connects to what they said' },
      never: { label: 'Never', hint: 'Keeps it about them' },
    },
  },
  demoWhen: {
    label: 'When to offer the demo',
    hint: 'While Offer a demo is on.',
    options: {
      asked: { label: 'When they ask', hint: 'About what you do or how it works' },
      problem: { label: 'Also on a problem', hint: 'When they name a problem you fix' },
    },
  },
} as const;

/**
 * As it's kept: each choice left out reads as how it starts (`chatOf`), so a save that gives one choice changes only
 * that one (./ops/playbooks.ts).
 */
export const PlaybookChat = z.object({
  wrapAfter: z
    .int()
    .min(CHAT_WRAP_AFTER.min, { error: 'Offer the call by their 1st, 2nd or 3rd reply.' })
    .max(CHAT_WRAP_AFTER.max, { error: 'Offer the call by their 1st, 2nd or 3rd reply.' })
    .optional(),
  questions: z.enum(CHAT_QUESTIONS).optional(),
  story: z.enum(CHAT_STORY).optional(),
  demoWhen: z.enum(CHAT_DEMO).optional(),
});
export type PlaybookChat = Required<z.output<typeof PlaybookChat>>;
/** How it starts, and how a playbook saved before it reads: as the chat went with decision 176. */
export const CHAT_START: PlaybookChat = {
  wrapAfter: 2,
  questions: 'rarely',
  story: 'fits',
  demoWhen: 'asked',
};

/** How a playbook's networking chat goes: its own, the starting way for the rest. */
export const chatOf = (
  d: { readonly chat?: Partial<PlaybookChat> | null | undefined } | null,
): PlaybookChat => {
  const own = d?.chat ?? {};
  return {
    wrapAfter: own.wrapAfter ?? CHAT_START.wrapAfter,
    questions: own.questions ?? CHAT_START.questions,
    story: own.story ?? CHAT_START.story,
    demoWhen: own.demoWhen ?? CHAT_START.demoWhen,
  };
};

/**
 * Referring people the owner has talked with on posts asking for a recommendation (decision 174, the owner's 6a to 9a):
 * Today offers the comment and the heads-up, both waiting for an OK, while this is on. On to start, and for a playbook
 * saved before it; the person's playbook is the one their first message was written from.
 */
export const PLAYBOOK_REFER = {
  label: 'Refer them on posts',
  hint: 'When someone asks for a recommendation of what a person you’ve talked with does, Today offers a comment naming them and a heads-up to them. Both wait for your OK.',
} as const;

/** Whether a playbook's people may be referred on posts: yes unless it's turned off. */
export const refersOf = (d: { readonly refer?: boolean | null | undefined } | null): boolean =>
  d?.refer !== false;

/** The networking chat's parts: a playbook has them only while a way it may start with starts a chat. */
export const CHAT_PARTS: readonly ScriptPart[] = [
  'nudge',
  'demoOffer',
  'callOffer',
  'sendPeople',
  'callYes',
];
/** The ways' own parts but the first message's, which Reconnect asks after its catch-up whatever is ticked. */
const WAY_PARTS: ReadonlyMap<ScriptPart, OpenWay> = new Map(
  OPEN_WAY_KEYS.filter((w) => OPEN_WAYS[w].part !== 'first').map((w) => [OPEN_WAYS[w].part, w]),
);
/**
 * Whether an editor shows a part for the ways ticked (decision 183): a way's own words only while it's ticked, the
 * networking chat's only while a way that starts a chat is, and every other part always.
 */
export function partShown(part: ScriptPart, ways: readonly OpenWay[]): boolean {
  const way = WAY_PARTS.get(part);
  if (way) return ways.includes(way);
  return !CHAT_PARTS.includes(part) || ways.some(startsAChat);
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
  '[open times] are the times under <times>, said the way a person texts them; with none given, leave out the words that offer them and keep the rest. [booking link] is the link you’re given, exactly as written; with none, leave its words out. [calendar link] is the owner’s own calendar link when the task gives one, exactly as written; with none, leave it and the words that give it out (“Here’s my calendar:”).',
  '[your first name] is the first word of the name under <owner_name>; with none given, leave it and the words that give it out (“I’m with …”). [your business name] is the business’s name under <business>, written the way people say it.',
  '[something you have in common] is one short line, right after the hello or the thanks, on one true thing the owner and they have in common, so they feel a connection before the owner says what the business does. It says it plainly, never as a question, and picks the truest: that they’re local to each other, when the facts say so (“Always great to meet another business owner here in the Austin area!”, with their area from the facts); the same line of work, only when the owner’s own business is in it; something About you says of the owner that their pages show of them too; and otherwise that they both run a business (“Always good to meet a fellow business owner!”). Never a group, or where the owner came across them, and never anything you’re not sure of. When they don’t run a business and nothing else is shared, leave it out.',
  '[a question about them] is one short, friendly question about them as a person, picked from something specific on their pages, in the facts or in the chat: a trip, a milestone, a hobby, a post, how long they’ve been at it, how they got started. People like talking about themselves, so make it about them and easy to answer, never a yes-or-no question, and never about what the offer does. Only when nothing specific stands out, ask how they got into their line of work.',
  '[what they do] is what they do, the way they’d say it (“roofing”, “real estate”). [their area] is the town or area they work in, from their pages or the chat; when they work nationwide or online, say “anywhere” in place of “in [their area]”.',
  '[their name] is their name exactly as it shows under <person>, so the owner can tag them. [what they need] is what the post asks for, in a few plain words (“a good roofer”), never where it was posted. [post link] stays exactly as it is, brackets and all: the link goes in after.',
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
 * `DRAFT_RULES` (the price, the guarantee, nothing invented, never AI), `ABOUT_OWNER_RULE` and `realComments`
 * (decision 165, ./about-owner.ts and ./comment-says.ts), `declinedLine` (decision 134), the post check's `asking`
 * (decision 163), the tasks' own limits (decisions 108, 114 and 161), `checkedDrafts` (words to avoid) and `isClient`
 * (decision 91).
 */
export const LOCKED_RULES: readonly string[] = [
  'Never names a group you’re both in, or says it found someone in one.',
  'Never messages anyone before they accept your request. On Instagram and Threads that’s their follow back. On X it only comments for now.',
  'Gives your price, and your guarantee, only when they ask.',
  'Never pitches someone who said no or not now. They get a kind word, and nothing more unless they write.',
  'Never makes up anything about the person, your results or your business.',
  'Never says or hints that you share someone’s heritage, culture, faith, family or life story unless About you, or Your story in your main offer, says so. Otherwise it stays warm and playful, as a friendly outsider.',
  'A comment says something real about the post, in the plain words people type. With nothing real to say, it leaves no comment.',
  'Never says a message was written by AI.',
  'A comment offers to show them only when the post asks for someone who does what you do, and never carries a link.',
  'Birthday and new-job notes, warm-up comments and answers in your groups say nothing about your business.',
  'Never uses your words to avoid, and always says what every message must say.',
  'Never pitches a client in your Contacts.',
  'Refers only someone who wrote back to you at least twice, never someone you marked not a fit or put on Don’t pitch, and never without your OK.',
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
  opensTitle: 'How the first message goes',
  opensBlurb: 'Pick what goes once someone connects with you.',
  /** The first message's label when Direct pitch isn't ticked: Reconnect still asks it. */
  pitchInIntro: 'Your pitch',
  pitchInIntroWhen:
    'Reconnect asks this after its catch-up. While Direct pitch isn’t ticked, nobody new gets it as a first message.',
  /** The networking chat's switches (decision 173), for the ways that start a chat. */
  networkingTitle: 'In the chat after it',
  networkingBlurb:
    'The chat stays about them. Pick what it may offer, each once, when it fits. Turn one off and it never comes up.',
} as const;
