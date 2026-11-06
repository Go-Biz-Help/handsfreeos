/**
 * Groups stay out of what the AI writes to people (docs/outreach.md, decision 157). Groups remove members who reach
 * out to other members, so a message, a comment or a reply never names a group, says "the group", or says the owner
 * and they are both in one or that the owner found them in one:
 *
 * - **The AI isn't told.** A draft's facts and their pages lose every line that names one of their groups or says
 *   they're in one (`withoutGroupLines`), and a comment's post no longer says which group it's in.
 * - **The AI is told not to** (`NO_GROUPS`), in every customer draft's rules. A partner's messages to someone who runs
 *   a group still speak of it (answer 2a): their group is why the owner writes.
 * - **A draft that does anyway is thrown out** (`namesAGroup`), and the AI writes again once, told what to leave out
 *   (`noGroupsAgain`).
 *
 * Browser-safe.
 */

/** The rule every customer draft follows. */
export const NO_GROUPS =
  'Never mention a group: never name one, never say “the group”, “our group” or “a group we’re both in”, and never say the owner found, saw or met them in one, even when the facts, their pages, their post or the chat do. Say nothing of where the owner came across them.';

/** What the AI is told when every draft it wrote mentioned a group: the names it used, to leave out. */
export function noGroupsAgain(names: readonly string[]): string {
  const said = names.length ? ` Leave out ${names.map((n) => `“${n}”`).join(', ')}.` : '';
  return `Your last drafts mentioned a group. Write them again with no group in them: no group’s name, no “the group”, and nothing of where the owner came across them.${said}`;
}

/** Words for what someone does that come after "group" and aren't a group someone's in: group fitness, a group rate. */
const NOT_A_GROUP =
  '(?:fitness|coaching|class|classes|program|programs|session|sessions|lesson|lessons|rate|rates|plan|plans|discount|discounts|home|homes|practice|travel|tour|tours|trip|trips|event|events|booking|bookings|chat|chats|text|texts|call|calls|project|projects|insurance|health|benefits|therapy|setting|settings|of|buy|buying|sales|deal|deals|policy|policies|ride|rides|training|workout|workouts)';

/** A few words of a name between a word and "group": "the Austin Realtors group". */
const SOME_WORDS = "(?:[\\p{L}\\p{N}'&]+ ){0,6}?";

/** What says they share a group, or that the owner found them in one, once the text is plain (`plain`). */
const SHARED: readonly RegExp[] = [
  // "our group", "the same Facebook group", "same group".
  new RegExp(`\\b(?:our|same) ${SOME_WORDS}groups?\\b(?! ${NOT_A_GROUP}\\b)`, 'u'),
  // "a fellow member", "fellow group members".
  /\bfellow (?:group )?members?\b/u,
  // "both in the realtors group", "both members of that group".
  new RegExp(
    `\\bboth (?:in|members of|part of) ${SOME_WORDS}groups?\\b(?! ${NOT_A_GROUP}\\b)`,
    'u',
  ),
  // "saw you in the Austin Realtors group", "found your post in a group".
  new RegExp(
    `\\b(?:saw|seen|found|noticed|spotted|met|came across|come across) (?:you|your [\\p{L}']+) (?:in|on|through|from) (?:the|a|that|this|our|one of) ${SOME_WORDS}groups?\\b(?! ${NOT_A_GROUP}\\b)`,
    'u',
  ),
  // "in the group", "from that Facebook group", "through a group".
  new RegExp(
    `\\b(?:in|from|through) (?:the|that|this|a) ${SOME_WORDS}groups?\\b(?! ${NOT_A_GROUP}\\b)`,
    'u',
  ),
  // "we share a group", "sharing the same Facebook group".
  new RegExp(
    `\\b(?:share|sharing|shared) (?:a|the|this|that|some) ${SOME_WORDS}groups?\\b(?! ${NOT_A_GROUP}\\b)`,
    'u',
  ),
  // "the group we share", "a group we're both in", "groups in common".
  /\bgroups? (?:that )?(?:we|you and i) (?:share|shared|are both|are in|both)\b/u,
  /\bgroups? (?:that )?we're (?:both|in|all)\b/u,
  /\bgroups? in common\b/u,
  // "group member", "a member of the group".
  /\bgroup members?\b/u,
  new RegExp(
    `\\bmembers? of (?:the|that|this|our|a) ${SOME_WORDS}groups?\\b(?! ${NOT_A_GROUP}\\b)`,
    'u',
  ),
];

/** What a fact or a line of their pages says of a group they're in, beyond `SHARED`: "one of the owner's groups". */
const IN_A_GROUP: readonly RegExp[] = [
  new RegExp(`\\b(?:owner's|owners') ${SOME_WORDS}groups?\\b`, 'u'),
  // "Mention the realtors group you share": a first step the check wrote.
  new RegExp(
    `\\b(?:mention|share|shared|sharing|both)\\b(?: [\\p{L}\\p{N}'&]+){0,6} groups?\\b(?! ${NOT_A_GROUP}\\b)`,
    'u',
  ),
  new RegExp(
    `\\b(?:found in|member of|members of|joined|active in|posts in|posted in|admin of|moderator of) ${SOME_WORDS}groups?\\b(?! ${NOT_A_GROUP}\\b)`,
    'u',
  ),
];

/** Text as it's matched: lower case, straight apostrophes, and nothing but words between single spaces. */
function plain(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}'&]+/gu, ' ')
    .trim();
}

/**
 * The parts of a group's name worth matching: its name and each part between separators ("Austin Realtors | Buyers
 * and Sellers"), each with three words or more, or two and 15 characters, so a name as plain as a line of work ("Real
 * Estate", "Small Business") never throws out a message that says what someone does.
 */
export function groupNameParts(name: string): string[] {
  const parts = [name, ...name.split(/[|•·:;/()[\]{}–—-]+/)].map(plain).filter(Boolean);
  return [
    ...new Set(
      parts.filter((p) => {
        const words = p.split(' ').length;
        return words >= 3 || (words === 2 && p.length >= 15);
      }),
    ),
  ];
}

/** The names of their groups a text says, as the group calls itself; none when it says none. */
export function groupNamesIn(text: string, names: readonly string[]): string[] {
  const said = ` ${plain(text)} `;
  return names.filter((name) => groupNameParts(name).some((part) => said.includes(` ${part} `)));
}

/**
 * Whether a draft mentions a group (decision 157): one of their groups by name (`groupNameParts`), or words that say
 * they share one or that the owner found them in one. Group fitness, a group rate and the like aren't groups.
 */
export function namesAGroup(text: string, names: readonly string[] = []): boolean {
  const said = plain(text);
  return groupNamesIn(text, names).length > 0 || SHARED.some((re) => re.test(said));
}

/**
 * A draft's facts or lines of their pages, without those that name one of their groups or say they're in one: what the
 * AI isn't told, it can't say.
 */
export function withoutGroupLines(lines: readonly string[], names: readonly string[]): string[] {
  return lines.filter((line) => {
    const said = plain(line);
    return !(namesAGroup(line, names) || IN_A_GROUP.some((re) => re.test(said)));
  });
}
