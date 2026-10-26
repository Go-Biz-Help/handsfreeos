/**
 * The rest of the person's own profile (docs/outreach.md, decision 84), beside its bio and About: its name, username
 * and links, and usernames checked before one is picked.
 *
 * - **Put in, or opened for the person.** Where the network wants the person to change a part themselves (core's
 *   `PART_HOW_ON`: LinkedIn's address and links), the page where it's changed is opened and the step handed over, with
 *   what to put in (`partStepsWords`); Carry on once it's in. Instagram's links are only in its phone app, so that step
 *   says so. LinkedIn's name goes in by itself, in its intro's box (./linkedin/profile.ts), and from 0.93.0 Facebook's
 *   name, username and links do too (./profile.ts), and Instagram's username and name (./looking.ts), on Accounts
 *   Center (./accounts-center.ts, decision 89): those jobs pass the parts they put in as `done`. A part core says goes
 *   in by itself that isn't in `done` is still handed over in words, with no page opened. Pictures are never touched
 *   (decision 64).
 * - **Usernames checked.** Each one's address is opened in turn and the page read for whether anyone's there
 *   (../networks/there.ts): nobody, it's free; a profile, it's taken; neither, it isn't known. What it found is kept on
 *   the person's check. It presses nothing.
 */
import type { AskTask } from '@hfos/core/addons/outreach/asks';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { shownUsername } from '@hfos/core/addons/outreach/profile-check';
import {
  PART_PAGE_ON,
  partHowOn,
  partStepsWords,
  USERNAME_WORDS,
} from '@hfos/core/addons/outreach/profile-parts';
import { valueOf, type Job, type JobEnd } from './job';

type EditTask = Extract<AskTask, { kind: 'profile_edit' }>;
export type ByHandPart = 'name' | 'username' | 'links';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Each part of the edit the person puts in themselves, in turn: its page opened, and the step handed over with what to
 * put in. Null once they're all in; how it ended when they stopped. `done` names the parts put in already.
 */
export async function putInByHand(
  job: Job,
  platform: Platform,
  task: EditTask,
  done: ReadonlySet<ByHandPart> = new Set(),
): Promise<JobEnd | null> {
  const parts: [ByHandPart, string | readonly string[]][] = [];
  if (task.name) parts.push(['name', task.name]);
  if (task.username) parts.push(['username', task.username]);
  if (task.links.length) parts.push(['links', task.links]);
  for (const [part, value] of parts) {
    if (done.has(part)) continue;
    const how = partHowOn(platform, part);
    if (how === 'tip') continue;
    if (job.stopped()) return { line: 'Stopped.', warned: false };
    if (!job.handOver)
      return {
        line: `${PLATFORMS[platform]} wants you to change your ${part} yourself.`,
        warned: false,
        failed: true,
      };
    const page = how === 'steps' ? PART_PAGE_ON[platform]?.[part] : undefined;
    if (page) {
      job.progress(`Opening where your ${part} is changed…`);
      await job.tab.open(page);
    }
    const reply = await job.handOver(
      `${partStepsWords(platform, part, value)} Then press Carry on.`,
      {
        note: `The ${part} was handed to the person to put in.`,
      },
    );
    if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
  }
  return null;
}

/** Where a username's profile would be on each network that has one. */
const USERNAME_ADDRESS_ON: Readonly<Partial<Record<Platform, (username: string) => string>>> = {
  facebook: (u) => `https://www.facebook.com/${encodeURIComponent(u)}`,
  instagram: (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`,
  linkedin: (u) => `https://www.linkedin.com/in/${encodeURIComponent(u)}/`,
};
/** How many times a page is read for whether anyone's there, while it draws, and how long apart. */
const LOOKS = 3;
const LOOK_MS = 1_500;

/** Checks usernames are free: each one's address opened, read, and what it found kept on the person's check. */
export async function checkUsernames(
  job: Job,
  platform: Platform,
  usernames: readonly string[],
): Promise<JobEnd> {
  const address = USERNAME_ADDRESS_ON[platform];
  if (!address)
    return {
      line: `${PLATFORMS[platform]} has no username to check.`,
      warned: false,
      failed: true,
    };
  const found: { value: string; free: boolean | null }[] = [];
  for (const value of usernames) {
    if (job.stopped()) break;
    job.progress(USERNAME_WORDS.looking(shownUsername(platform, value)));
    await job.tab.open(address(value));
    let there: boolean | null = null;
    for (let look = 0; look < LOOKS && there === null; look++) {
      await pause(LOOK_MS);
      const answer = await job.tab.ask({ type: 'hfos-page-there' });
      there = answer.ok ? answer.there : null;
    }
    found.push({ value, free: there === null ? null : !there });
  }
  if (!found.length) return { line: 'Stopped.', warned: false };
  valueOf(
    await job.hfos({
      type: 'hfos-usernames',
      input: { workspaceId: job.businessId, platform, found },
    }),
  );
  return {
    line: USERNAME_WORDS.checked(found.filter((f) => f.free).length, found.length),
    warned: false,
  };
}
