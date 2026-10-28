/**
 * LinkedIn's Catch up (/mynetwork/catch-up/all/, docs/outreach.md decision 108): the person's connections' news, a card
 * each. Each card is found by the link to the connection's profile, the one thing every card has, and read from the
 * box around it (`collectLinked`): a birthday ("Celebrating a birthday today", "Wish Dana a happy birthday") or a new
 * job ("Started a new position as Owner at Brooks Roofing"), the new job in LinkedIn's words. Work anniversaries,
 * schooling and the rest are left.
 */
import { collectLinked, inTopBar, namesOn, shownLines } from './dom';
import { bestName } from './people';
import type { CatchUp } from './types';
import { profileFromUrl, profileKey } from './urls';

/** A card about their birthday. */
const BIRTHDAY =
  /\b(celebrating (a|their|his|her) birthday|birthday today|happy birthday|birthday is today)\b/i;
/** A card about their new job, in any of LinkedIn's wordings. */
const NEW_JOB = /\bnew (position|job|role)\b/i;
/** The line that says what the new job is, best first: "Started a new position as Owner at Brooks Roofing". */
const SAYS_JOB = /^(started|starting|celebrating|began|joined)\b/i;
const DETAIL_MOST = 300;

/** The birthdays and new jobs on the page, in page order, each person once. */
export function readCatchUp(root: Element, base: string): CatchUp[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const profile = profileFromUrl(url);
      return profile ? { key: profileKey(profile), value: profile } : null;
    },
    inTopBar,
  );
  const found: CatchUp[] = [];
  for (const entry of linked) {
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    const lines = shownLines(entry.card, { max: 20 }).filter((line) => line !== name);
    if (lines.some((line) => BIRTHDAY.test(line))) {
      found.push({ name, profile: entry.value, kind: 'birthday', detail: null });
      continue;
    }
    const job = lines.filter((line) => NEW_JOB.test(line));
    if (!job.length) continue;
    const detail = (job.find((line) => SAYS_JOB.test(line)) ?? job[0]!).slice(0, DETAIL_MOST);
    found.push({ name, profile: entry.value, kind: 'new_job', detail });
  }
  return found;
}
