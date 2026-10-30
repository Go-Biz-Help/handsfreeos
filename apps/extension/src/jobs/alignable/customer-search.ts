/**
 * **Search for businesses like your clients** on Alignable (docs/outreach.md decision 92; `search`, once a day while
 * the extension works on its own there). Alignable's members are businesses, so the businesses its search shows for
 * the kinds of business the ideal client runs are the people to find. HandsFreeOS says today's 3 searches, in turn by
 * the day from the customer playbooks' **Kinds of business to search for on Alignable**, each with whether its playbook
 * works with clients online (`outreach.finds.searches`). A local one searches with the person's own town's name added
 * ("roofing contractor Austin TX") and keeps the businesses whose address is in that town or one within 25 miles of it,
 * the closest first (decision 115); and once a day the first local search goes again in one of those towns, in turn
 * from the closest (`outreach.finds.towns`). Outside the US, where HandsFreeOS doesn't know the towns' places, it keeps
 * to the person's own town. One that works online searches with the words alone and keeps every business it shows.
 * Never the person's own business, which their own profile names. Each reads 3 screens of Alignable's search, and what it kept goes to HandsFreeOS as found (`searched`,
 * with the words and the town), for the AI's found check (../found-checks.ts): only a good check puts a business on
 * Today. Nothing is pressed but a list's own Show more, and it stops on any Alignable warning.
 */
import { inTowns, townOrder } from '@hfos/core/addons/outreach/towns';
import type { FindsTowns } from '../../hfos/messages';
import { findsSave, type FoundPerson } from '../../hfos/saves';
import type { Business } from '../../networks/alignable/read';
import { townOf } from '../../networks/alignable/site';
import { counted } from '../../words';
import { paced, pause, valueOf, type Job, type JobEnd } from '../job';
import { SEARCH_SCREENS } from './partner-search';
import {
  businessSearchUrl,
  ended,
  gather,
  mine,
  notMine,
  PAGE_PACE_MS,
  townPlace,
  townWords,
} from './read';

/** With no town known, a local search can't go: what the person does about it (decision 92's 4). */
export const NO_TOWN =
  'Alignable didn’t show your town. Check your business page’s address in Alignable, then start your day again.';

const keyOf = (b: Business) => (b.profile.id ?? b.profile.username ?? b.profile.url).toLowerCase();

/** A business its search showed, as found: its owner, its business, the lines under it, and its town. */
function foundOf(b: Business): FoundPerson {
  const town = townOf(b.profile.url);
  return {
    name: b.name,
    profile: b.profile,
    lines: [b.business, ...b.details].filter((line): line is string => !!line),
    place: town ? townPlace(town) : null,
  };
}

/** None near: a town outside the US, or a HandsFreeOS that can't say yet. */
const NONE_NEAR: FindsTowns = { near: [], today: null };

/** The towns within 25 miles of the person's own, the closest first, and today's to search in too (decision 115). */
async function townsNear(job: Job, town: string): Promise<FindsTowns> {
  const asked = await job.hfos({
    type: 'hfos-finds-towns',
    input: { workspaceId: job.businessId, town },
  });
  return asked.ok ? asked.value : NONE_NEAR;
}

/** One search to run: its words, whether it keeps businesses anywhere, and the town it's in when it doesn't. */
interface Run {
  readonly words: string;
  readonly anywhere: boolean;
  readonly town: string | null;
}

/** Today's searches of Alignable's businesses for the playbooks' kinds of business, and the businesses each found. */
export async function searchForCustomers(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which kinds of business to search for…');
  const { searches } = valueOf(
    await job.hfos({
      type: 'hfos-finds-searches',
      input: {
        workspaceId: job.businessId,
        platform: 'alignable',
        // Today's round of finding again (decision 126): the next kinds of business.
        ...(job.round ? { round: job.round } : {}),
      },
    }),
  );
  if (!searches.length)
    return {
      line: 'Nothing to search for today: your customer playbooks have no kinds of business for Alignable yet, or the businesses found already wait for their check.',
      warned: false,
    };
  // A local search needs the person's own town; and every search leaves out their own business.
  const own = await mine(job);
  if (ended(own)) return own;
  const town = own.town;
  const someoneElse = notMine(own.business);
  const local = searches.find((s) => !s.anywhere);
  const near = town && local ? await townsNear(job, town) : NONE_NEAR;
  // The person's own town and those near it, the closest first: the businesses a local search keeps.
  const towns = town ? [town, ...near.near] : [];
  const runs: Run[] = searches.map((s) => ({ ...s, town: s.anywhere ? null : town }));
  // And once a day, the first local search again in today's town near theirs.
  if (local && near.today) runs.push({ words: local.words, anywhere: false, town: near.today });
  let searched = 0;
  let shown = 0;
  let added = 0;
  let noTown = false;
  let nearby: string | null = null;
  for (const search of runs) {
    if (job.stopped()) break;
    if (!search.anywhere && !search.town) {
      noTown = true;
      continue;
    }
    if (searched > 0) await pause(paced(PAGE_PACE_MS));
    const words = search.anywhere ? search.words : `${search.words} ${townWords(search.town!)}`;
    job.progress(`Searching Alignable for “${words}”…`);
    await job.tab.open(businessSearchUrl(words));
    const got = await gather(
      job,
      SEARCH_SCREENS - 1,
      (page) => page.found.businesses,
      keyOf,
      (n) => `Searching Alignable for “${words}”… ${counted(n, 'business', 'businesses')} so far.`,
    );
    if (ended(got)) return got;
    if (search.town && search.town !== town) nearby = search.town;
    else searched++;
    // A local search keeps only the businesses whose address is in the person's own town or one near it, the closest
    // first; never theirs.
    const kept = got.items
      .filter(
        (b) => someoneElse(b.profile) && (search.anywhere || inTowns(towns, townOf(b.profile.url))),
      )
      .map((b) => ({ b, order: search.anywhere ? 0 : townOrder(towns, townOf(b.profile.url)) }))
      .sort((x, y) => x.order - y.order)
      .map(({ b }) => b);
    shown += kept.length;
    if (!kept.length) {
      await job.report?.({
        note: `Alignable’s search for a kind of business showed none${search.anywhere ? '' : ' in or near your town'}.`,
        outline: true,
      });
      continue;
    }
    const built = findsSave(kept.map(foundOf), 'searched', 'alignable', job.businessId, {
      words: search.words,
      place: search.anywhere ? null : townPlace(search.town!),
    });
    if (!built.ok) continue;
    for (const input of built.input)
      added += valueOf(await job.hfos({ type: 'hfos-finds-save', input })).added;
  }
  if (!searched && noTown) return { line: NO_TOWN, warned: false, failed: true };
  const again = nearby ? `, and again in ${townPlace(nearby)}` : '';
  const parts = [
    `${job.stopped() ? 'Stopped. ' : ''}Searched Alignable for ${counted(searched, 'kind of business', 'kinds of business')}${again}: ${counted(shown, 'business', 'businesses')} found, ${added.toLocaleString()} new to check.`,
    shown ? 'The good fits come onto Today once the AI has read their pages.' : null,
    noTown ? NO_TOWN : null,
  ];
  return { line: parts.filter(Boolean).join(' '), warned: false };
}
