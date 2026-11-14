/**
 * What the AI knows of the person it writes as (docs/outreach.md, decision 165; the owner, 14 Nov 2026, on a comment
 * waiting under someone's Hispanic Heritage Month post that read "Five days in and still waiting, same 😂": "i love
 * this comment and the playfulness definitely keep the personality, but im not hispanic lol", then "now for someone
 * who is this is great").
 *
 * Every message and comment is written as the owner, in the first person. The AI was told the business, the offer and
 * how the owner writes, and nothing of the owner as a person, and no rule kept it from filling that in. So it wrote
 * the owner into the other person's own group ("same"). Now what's true of the owner is only what they said of
 * themselves (`<about_owner>`), and with nothing said the AI keeps the warmth and the humor and reacts from the
 * outside. The rule is one of the playbook's locked ones (./script.ts `LOCKED_RULES`).
 *
 * Browser-safe: the prompts, the playbook's locked rules and the Test console read it.
 */
import { quoteData } from '../../knowledge/prompt';

/** What `<about_owner>` holds when the owner said nothing of themselves. */
export const ABOUT_OWNER_NONE = 'The owner has said nothing about themselves.';

/**
 * The rule every prompt that writes as the owner carries. It names the words that claim a place in someone's group
 * ("same", "me too") because those are how the claim is made in a short comment, and it gives the outsider's version
 * of the owner's own example so the humor stays.
 */
export const ABOUT_OWNER_RULE = [
  'You write as the owner, and of the owner as a person you know only what <about_owner> says, in their own words. With no <about_owner>, or when it says nothing of something, you know nothing of it.',
  'Never make up anything about the owner’s own life. Never say or hint that the owner shares the other person’s heritage, culture, language, faith, family life, age, health, hometown, past, hobby, team or experience unless <about_owner> says so: no “same”, “same here”, “me too”, “us too”, “as a fellow …”, “I’ve been there” or “I can relate”.',
  'When it doesn’t say so, keep the warmth and the humor and react as a friendly outsider would: enjoy it, cheer them on, joke along with them or ask about it, without making it the owner’s own (“Five days in and no gifts yet? Somebody fix that 😂”, never “Still waiting, same 😂”).',
  'When it does say so, the owner may speak as one of them where the post or the message itself brings it up. Never bring up the owner’s own life first.',
  'The owner’s business, its work and its customers are theirs to speak of, as you’re given them.',
].join(' ');

/**
 * For a prompt that isn't told what the owner said of themselves (a helpful post, sample messages, a video script, a
 * like's short comment): nothing personal of the owner, ever. Core's, so every writer can carry it.
 */
export { OWNER_LIFE_UNKNOWN } from '../../writing';

/** What the owner said of themselves, as a prompt is told it: always there, so "nothing said" is said plainly. */
export const aboutOwnerBlock = (about?: string | null): string => {
  const said = about?.trim();
  return `<about_owner>\n${said ? quoteData(said) : ABOUT_OWNER_NONE}\n</about_owner>`;
};
