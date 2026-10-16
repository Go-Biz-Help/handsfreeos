/**
 * Needs you is in HandsFreeOS, never in the extension (docs/outreach.md, decision 72): the panel says how many things
 * wait there, with a link, and a step an ask hands the person says to press Carry on there; a pop-up opens it. Its
 * address and those words, for the panel and the background alike.
 */
import type { AskReply } from '@hfos/core/addons/outreach/asks';
import { outreachPath } from '@hfos/core/addons/outreach/setup';

/** Needs you's heading on HandsFreeOS's Today (apps/web/src/addons/outreach/waiting-view.tsx): the link goes to it. */
export const NEEDS_YOU_ANCHOR = 'needs-you';

/** The link to it, under a step handed over. */
export const NEEDS_YOU_LINK = 'Open Needs you';

/** Needs you on the web for a business: Today, which `?view=waiting` opens, at its Needs you. */
export function needsYouUrl(webUrl: string, businessId: string): string {
  return `${webUrl}${outreachPath(businessId, 'waiting')}#${NEEDS_YOU_ANCHOR}`;
}

/** The panel's line under Next up: "3 things need you in HandsFreeOS". Null when nothing waits. */
export function needsYouWords(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 thing needs you in HandsFreeOS'
    : `${count.toLocaleString('en-US')} things need you in HandsFreeOS`;
}

/**
 * Under a step an ask handed the person, after what to do: where to say it's done. Null when the step takes no answer
 * (it carries on by itself, as once a password is typed).
 */
export function carryOnWords(replies: readonly AskReply[]): string | null {
  if (!replies.includes('carry_on')) return null;
  return replies.includes('skip')
    ? 'When you’ve done it, press Carry on in HandsFreeOS → Needs you, or Skip to leave this person.'
    : 'When you’ve done it, press Carry on in HandsFreeOS → Needs you.';
}
