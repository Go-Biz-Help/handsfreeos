/**
 * Withdrawing old invitations on LinkedIn (docs/outreach.md, decisions 12 and 17, LinkedIn's way:
 * HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "What maps to what"), asked from the Friends tab in HandsFreeOS
 * once the person ticks who: the invitations they sent that nobody answered in the business's wait
 * (packages/core/src/addons/outreach/tidy.ts, as LinkedIn's). LinkedIn caps how many can wait, so this matters more
 * there than Facebook's.
 *
 * It opens Sent invitations in a tab they can see (decision 17: what's pressed on their network is pressed where they
 * see it), finds each one's row by the link to their profile (never by a name alone), scrolling the list slowly for
 * it, presses Withdraw and then the box's own Withdraw (src/networks/linkedin/withdraw.ts), checks the row is gone,
 * and notes it in HandsFreeOS. Someone not on the list, read to its end, answered already or was withdrawn: noted as
 * done already, and not counted. It goes slowly, stops at today's limit, and stops on any LinkedIn warning. A step it
 * can't do, it hands to the person: Carry on once they've done it, or Skip that person. From 0.97.0 it also withdraws
 * on its own once a day (decision 98), the oldest HandsFreeOS picks, with nobody handed to the person.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import type { Tidy, TidyCandidate } from '../../hfos/messages';
import type { LinkedInRead } from '../../networks';
import type { ProfileRef } from '../../networks/linkedin/types';
import { sameMember } from '../../networks/linkedin/urls';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ownTidy } from '../own-tidy';
import { INVITATIONS_SENT, readLinkedIn, SCROLL_PACE_MS } from './read';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;
/** The most screens of the list it scrolls looking for one person. */
export const LOOK_SCROLLS = 30;

/** What became of someone ticked: done, done already, skipped, or the job's end (a warning, a stop). */
type Outcome = 'done' | 'already' | 'skipped' | 'stopped' | JobEnd;

const profileOf = (who: TidyCandidate): ProfileRef => ({
  id: who.platformId,
  username: who.username,
  url: who.url,
});

/** Whether the page lists an invitation the person sent to this member. */
const listed = (page: LinkedInRead, who: ProfileRef) =>
  (page.invitations ?? []).some((i) => i.direction === 'sent' && sameMember(i.profile, who));

/** Whether the page is Sent invitations: the only page the job reads and presses on. */
const onSent = (page: LinkedInRead) => page.kind === 'invitations';

/**
 * Finds their row on Sent invitations, scrolling for it: `found`; `gone` when the list ended without them; `lost` when
 * it scrolled as far as it goes without getting to the end, or read no invitation at all (a page it can't read is
 * never taken for one without them). A warning ends it.
 */
async function find(job: Job, who: ProfileRef): Promise<'found' | 'gone' | 'lost' | JobEnd> {
  let seen = false;
  for (let screen = 0; ; screen++) {
    const page = await readLinkedIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (!onSent(page)) return 'lost';
    if (listed(page, who)) return 'found';
    seen ||= (page.invitations ?? []).some((i) => i.direction === 'sent');
    if (screen >= LOOK_SCROLLS || job.stopped()) return 'lost';
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) return seen ? 'gone' : 'lost';
    await pause(paced(SCROLL_PACE_MS));
  }
}

/** Hands a step to the person, with what to press. */
function handOver(job: Job, name: string): Promise<'carry_on' | 'skip' | 'stop'> {
  if (!job.handOver) return Promise.resolve('skip');
  return job.handOver(
    `Couldn’t withdraw the invitation to ${name}. On Sent invitations, press Withdraw beside their name, then Withdraw in the box LinkedIn opens. Then press Carry on, or Skip.`,
  );
}

/** One person: find, check it's them, press, check again, note. */
async function one(job: Job, who: TidyCandidate): Promise<Outcome> {
  const profile = profileOf(who);
  const end = async (already: boolean) => {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-end',
        input: {
          workspaceId: job.businessId,
          platform: 'linkedin',
          kind: 'cancel_request',
          profile: { id: who.platformId, username: who.username, url: who.url },
          name: who.name,
          already,
        },
      }),
    );
  };
  const found = await find(job, profile);
  if (typeof found === 'object') return found;
  if (job.stopped()) return 'stopped';
  if (found === 'gone') {
    await end(true);
    return 'already';
  }
  if (found === 'lost') {
    job.progress(`Skipped ${who.name}: couldn’t find their invitation on Sent invitations.`);
    return 'skipped';
  }
  const pressed = await job.tab.ask({ type: 'hfos-withdraw', profile });
  if (!pressed.ok) throw new Error(pressed.error);
  if (job.stopped()) return 'stopped';
  await pause(1_500);
  let page = await readLinkedIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  // Their row went before anything was pressed (LinkedIn redrew the list): nothing to finish, so it's left as it is.
  if (pressed.result === 'not_found' && !listed(page, profile)) {
    job.progress(
      `Skipped ${who.name}: their invitation went from the list before it was withdrawn.`,
    );
    return 'skipped';
  }
  if (pressed.result !== 'done' || listed(page, profile)) {
    // Not withdrawn yet: the person finishes it, or skips them.
    const reply = await handOver(job, who.name);
    if (reply === 'stop' || job.stopped()) return 'stopped';
    if (reply === 'skip') return 'skipped';
    page = await readLinkedIn(job.tab);
    if (!onSent(page) || listed(page, profile)) return 'skipped';
  }
  await end(false);
  return 'done';
}

/** How it went, in words for the person. */
function summary(done: number, skipped: number, gone: number, already: number): string {
  const parts = [`Invitations withdrawn: ${counted(done, 'person', 'people')}.`];
  if (already) parts.push(`Answered or withdrawn already: ${already.toLocaleString()}.`);
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  if (gone) parts.push(`No longer on the list: ${gone.toLocaleString()}.`);
  return parts.join(' ');
}

/**
 * Withdraws the old invitations the person ticked: those still on HandsFreeOS's list for LinkedIn, a person at a
 * time, up to today's limit there.
 */
export async function withdrawInvitations(
  job: Job,
  profileIds: readonly string[],
): Promise<JobEnd> {
  job.progress('Getting the list from HandsFreeOS…');
  const lists = await listsOf(job);
  const byId = new Map(lists.cancel.map((c) => [c.profileId, c]));
  const picks = profileIds.map((id) => byId.get(id)).filter((c): c is TidyCandidate => !!c);
  return withdrawThese(job, picks, lists, profileIds.length - picks.length);
}

/**
 * Withdrawing on its own, once a day (decision 98): the oldest invitations HandsFreeOS picked for today, as the person
 * chose for LinkedIn. Nobody is handed to the person: one it can't withdraw, it passes over.
 */
export async function withdrawOnItsOwn(job: Job): Promise<JobEnd> {
  const lists = await listsOf(job);
  return ownTidy(job, lists, (which, picks) =>
    which === 'cancel_request'
      ? withdrawThese(job, picks, lists)
      : Promise.resolve({ line: '', warned: false }),
  );
}

const listsOf = async (job: Job): Promise<Tidy> =>
  valueOf(await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId, platform: 'linkedin' }));

/** Goes through those picked, a person at a time, up to today's limit on LinkedIn. */
async function withdrawThese(
  job: Job,
  picks: readonly TidyCandidate[],
  lists: Tidy,
  gone = 0,
): Promise<JobEnd> {
  const limit = lists.limits.cancel_request;
  let room = Math.max(0, limit.most - limit.done);
  let done = 0;
  let skipped = 0;
  let already = 0;
  const said = () => summary(done, skipped, gone, already);
  if (!picks.length) return { line: said(), warned: false };
  job.progress('Opening the invitations you’ve sent…');
  await job.tab.open(INVITATIONS_SENT);
  for (const [i, who] of picks.entries()) {
    if (job.stopped()) return { line: `Stopped. ${said()}`, warned: false };
    if (room <= 0)
      return {
        line: `That’s today’s limit of ${limit.most} on LinkedIn. ${said()} Ask again tomorrow for the rest.`,
        warned: false,
      };
    job.progress(`${i + 1} of ${picks.length}: withdrawing the invitation to ${who.name}…`);
    const outcome = await one(job, who);
    if (outcome === 'stopped') return { line: `Stopped. ${said()}`, warned: false };
    if (typeof outcome === 'object') return { ...outcome, line: `${outcome.line} ${said()}` };
    if (outcome === 'done') {
      done++;
      room--;
    } else if (outcome === 'already') already++;
    else skipped++;
    if (i < picks.length - 1 && !job.stopped() && outcome === 'done') {
      job.progress(
        `Invitations withdrawn: ${counted(done, 'person', 'people')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${said()}`, warned: false };
}
