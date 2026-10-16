/**
 * What the background asks a LinkedIn tab besides reading it, answered in the tab (../../content.ts): only for what
 * the person asked of the extension from HandsFreeOS (src/jobs/linkedin/; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "LinkedIn, part by part", 4). Each step goes only on the page it's for, and says so anywhere else:
 *
 * - Their connections, their invitations, a search's results and messaging's list scrolled for more, and a
 *   conversation opened from that list (./browse.ts).
 * - Their own profile read for the AI's check, and the headline they picked put in (./own-profile.ts).
 * - On Sent invitations, the one to a member they ticked withdrawn (./withdraw.ts).
 *
 * Nothing else: LinkedIn's tab connects, likes, comments and sends nothing on its own (that's part 5, the person's
 * choice). Runs in the tab, on the page in front of it: it uses the tab's own document and address.
 */
import type {
  BrowseAnswer,
  BrowseAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  WithdrawAnswer,
  WithdrawAsk,
} from '../../messages';
import { openChat, scrollChats, scrollList } from './browse';
import { readOwnProfile, writeHeadline } from './own-profile';
import { classifyUrl } from './urls';
import { sentPage, withdraw } from './withdraw';

/** The kinds of ask a LinkedIn tab answers besides reading. */
export const WORK_ASKS: ReadonlySet<string> = new Set([
  'hfos-open-chat',
  'hfos-scroll-chats',
  'hfos-scroll-list',
  'hfos-own-profile',
  'hfos-write-bio',
  'hfos-withdraw',
]);

type WorkAsk =
  | Extract<BrowseAsk, { type: 'hfos-open-chat' | 'hfos-scroll-chats' | 'hfos-scroll-list' }>
  | OwnProfileAsk
  | WithdrawAsk;

/** Whether the tab shows a profile: the person's own, after linkedin.com/in/me/ took it there. */
const onProfile = (href: string) => {
  const kind = classifyUrl(href).kind;
  return kind === 'profile' || kind === 'own-profile';
};

/** The person's own profile: read it for the AI's check, or put the headline in. */
async function ownProfileStep(ask: OwnProfileAsk): Promise<OwnProfileAnswer> {
  if (!onProfile(location.href)) return { ok: false, error: 'LinkedIn didn’t open your profile.' };
  if (ask.type === 'hfos-own-profile')
    return { ok: true, read: readOwnProfile(document, location.href) };
  return { ok: true, result: await writeHeadline(document, location.href, ask.bio) };
}

/** Withdrawing an invitation, on Sent invitations alone. */
async function withdrawStep(ask: WithdrawAsk): Promise<WithdrawAnswer> {
  if (!sentPage(location.href))
    return { ok: false, error: 'LinkedIn didn’t open the invitations you’ve sent.' };
  return { ok: true, result: await withdraw(document, location.href, ask.profile) };
}

/** Does one of the background's asks in this tab, and answers how it went; null for one that isn't LinkedIn's work. */
export function work(ask: { readonly type: string }): Promise<unknown> | null {
  if (!WORK_ASKS.has(ask.type)) return null;
  const known = ask as WorkAsk;
  switch (known.type) {
    case 'hfos-open-chat':
      return Promise.resolve<BrowseAnswer>({
        ok: openChat(document, location.href, known.threadId),
      });
    case 'hfos-scroll-chats':
      return Promise.resolve<BrowseAnswer>({ ok: scrollChats(document, location.href) });
    case 'hfos-scroll-list':
      return Promise.resolve<BrowseAnswer>({ ok: scrollList(document, location.href) });
    case 'hfos-own-profile':
    case 'hfos-write-bio':
      return ownProfileStep(known);
    case 'hfos-withdraw':
      return withdrawStep(known);
  }
}
