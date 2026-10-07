/**
 * Facebook's own words: its buttons, tabs and labels, in English. The readers skip them when they look for a name or
 * a detail, and the page outline (./outline.ts) keeps them while it hides everything people wrote. Facebook shows
 * these in the language the person uses it in, so for now the readers expect English.
 */

/** Lower-case, exactly as Facebook shows them. */
export const UI_WORDS: ReadonlySet<string> = new Set([
  'about',
  'accept',
  'account',
  'active now',
  'add friend',
  'add to story',
  'admin',
  'admins',
  'admins and moderators',
  'all',
  'all friends',
  'all reactions:',
  'and',
  'attach a file',
  'actions for this post',
  'audio call',
  'back',
  'birthdays',
  'block',
  'cancel',
  'cancel request',
  'chat settings',
  'chats',
  'close',
  'comment',
  'comments',
  'conversation information',
  'confirm',
  'confirm request',
  'create',
  'create new group',
  'delete',
  'discover',
  'discussion',
  'edit',
  'edit bio',
  'edit details',
  'edit featured',
  'edit profile',
  'education',
  'emoji',
  'enter',
  'events',
  'facebook',
  'family members',
  'featured',
  'feed',
  'files',
  'filters',
  'follow',
  'followers',
  'following',
  'friend requests',
  'friends',
  'gif',
  'group expert',
  'groups',
  'groups you’ve joined',
  "groups you've joined",
  'hide',
  'hobbies',
  'home',
  'interests',
  'intro',
  'invite',
  'join',
  'join group',
  'joined',
  'leave a comment',
  'learn more',
  'like',
  'life events',
  'links',
  'loading...',
  'loading…',
  'manage posts',
  'mark as read',
  'media',
  'member',
  'members',
  'mentions',
  'menu',
  'message',
  'messages',
  'messenger',
  'moderator',
  'moderators',
  'more',
  'more actions',
  'most relevant',
  'mutual',
  'mutual friends',
  'new message',
  'new to the group',
  'newest',
  'notifications',
  'overview',
  'pending admin approval',
  'people',
  'people follow this',
  'people you may know',
  'person follows this',
  'personal details',
  'photos',
  'places lived',
  'posts',
  'private group',
  'profile',
  'public group',
  'react',
  'reels',
  'remove',
  'reply',
  'report',
  'request accepted',
  'request canceled',
  'request cancelled',
  'request declined',
  'request deleted',
  'request removed',
  'request sent',
  'respond',
  'search',
  'search messenger',
  'see all',
  'see all friends',
  'see less',
  'see more',
  'see options',
  'send',
  'sent requests',
  'settings',
  'share',
  'sponsored',
  'start a video call',
  'start a voice call',
  'sticker',
  'suggestions',
  'thumbs up',
  'top contributor',
  'unfollow',
  'unread',
  'unread message',
  'unread message:',
  'video call',
  'videos',
  'view group',
  'view profile',
  'view sent requests',
  'visit',
  'voice clip',
  'work',
  'write a comment…',
  'write a public comment…',
  'write something…',
  'you',
  'you replied',
  'you sent',
  'your groups',
]);

const WEEKDAY = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const CLOCK = '\\d{1,2}:\\d{2}(?:\\s?[ap]\\.?m\\.?)?';
const AT = `(?:,?\\s(?:at\\s)?${CLOCK})?`;

/**
 * How Facebook says when something happened, short or long: "3h", "Yesterday", "Today at 10:12 AM", "Mon 3:15 PM",
 * "Oct 3, 2026, 3:15 PM", "2 days ago".
 */
const WHEN_FORMS = [
  'just now',
  'now',
  'a few seconds ago',
  '\\d+\\s?(?:s|m|h|d|w|y|min|mins|hr|hrs|wk|wks)',
  '(?:about\\s)?(?:an?|\\d+)\\s(?:second|minute|hour|day|week|month|year)s?\\sago',
  `(?:today|yesterday|${WEEKDAY})${AT}`,
  `${MONTH}\\s\\d{1,2}(?:,?\\s\\d{4})?${AT}`,
  `\\d{1,2}\\s${MONTH}(?:\\s\\d{4})?${AT}`,
  `\\d{1,2}/\\d{1,2}/\\d{2,4}${AT}`,
  CLOCK,
];
const ANY_WHEN = `(?:${WHEN_FORMS.map((form) => `(?:${form})`).join('|')})`;
const WHEN = new RegExp(`^${ANY_WHEN}$`, 'i');

export function isWhen(text: string): boolean {
  return WHEN.test(text.trim());
}

/** A day on the calendar with no time of day: "June 14", "14 June 2026", "6/14/2026". A birthday looks like this. */
const DATE = new RegExp(
  `^(?:${MONTH}\\s\\d{1,2}(?:,?\\s\\d{4})?|\\d{1,2}\\s${MONTH}(?:\\s\\d{4})?|\\d{1,2}/\\d{1,2}/\\d{2,4})$`,
  'i',
);

export function isDate(text: string): boolean {
  return DATE.test(text.trim());
}

/** Facebook's counts and times, which carry nothing private: "12K members", "3h", "Public group · 1.2K members". */
const COUNTS_AND_TIMES: readonly RegExp[] = [
  /^[\d.,]+\s*[km]?\s+(members?|comments?|shares?|mutual( friends?)?|friends?|(friend |sent )?requests?|followers?|following|reactions?|posts?( (a|per) (day|week))?|new posts?( today)?)$/i,
  /^followed by [\d.,]+\s*[km]?$/i,
  /^(public|private) group(\s*·\s*[\d.,]+\s*[km]?\s+members)?$/i,
  /^all reactions:?\s*[\d.,]*\s*[km]?$/i,
  /^[\d.,]+\s*[km]?\s+(people|person)\s+follows?\s+this$/i,
  /^[\d.,]+\s*[km]?\s+mutual friends?\s+including$/i,
  /^[·•|]$/,
  WHEN,
  new RegExp(`^joined\\s${ANY_WHEN}$`, 'i'),
];

/** Whether a piece of text is Facebook's own words rather than something a person wrote. */
export function isFacebookText(text: string): boolean {
  const t = text.trim().toLowerCase();
  return UI_WORDS.has(t) || COUNTS_AND_TIMES.some((pattern) => pattern.test(t));
}

/** Whether every part of a line is Facebook's own words: "349 friends • 21 mutual", "Public group · 34.7K members". */
export function isFacebookLine(line: string): boolean {
  const parts = line.split(/\s*[·•|]\s*/).filter(Boolean);
  return parts.length > 0 && parts.every(isFacebookText);
}

/** The labels Facebook puts on people in a group. Each one alone, as its own piece of text. */
export const BADGE =
  /^(admin|moderator|group expert|top contributor|rising contributor|all-star contributor|new member|conversation starter|visual storyteller|founding member|link curator|greeter)$/i;

/** Whether someone runs the group: the people you asked to leave alone. */
export const RUNS_GROUP = /\b(admins?|moderators?)\b/i;

/**
 * The titles of the parts of a list, with Facebook's count after them sometimes ("Admins and moderators · 4"). The
 * title comes back without the count.
 */
const SECTION =
  /^(admins?\s*(?:and|&)\s*moderators?|moderators?|admins?|group experts?|members|new to the group|friends|friend requests|members with things in common|members near you|people you may know|top contributors?|group contributors|contributors|people|groups)(?:\s*[·•]\s*[\d.,]+\s*[km]?)?$/i;

/** A title without the count Facebook puts after it: "Members near you · 4" is "Members near you". */
export function withoutCount(text: string): string {
  return text.replace(/\s*[·•]\s*[\d.,]+\s*[km]?$/i, '').trim();
}

export function sectionTitleOf(text: string): string | null {
  const match = SECTION.exec(text.trim());
  return match?.[1] ?? null;
}

/** "12K" → 12000, "1,234" → 1234, "2.5M" → 2500000. */
export function parseCount(text: string): number | null {
  const match = /^([\d.,]+)\s*([km])?$/i.exec(text.trim());
  if (!match?.[1]) return null;
  const suffix = match[2]?.toLowerCase();
  const number = Number(
    suffix ? match[1].replace(/,/g, '') : match[1].replace(/[.,](?=\d{3}\b)/g, ''),
  );
  if (!Number.isFinite(number)) return null;
  return Math.round(number * (suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1));
}
