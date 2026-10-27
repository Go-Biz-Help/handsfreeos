/**
 * **Search for businesses like your clients** on Alignable (docs/outreach.md decision 92; `search`, once a day while
 * the extension works on its own there). Alignable's members are businesses, so the businesses its search shows for
 * the kinds of business the ideal client runs are the people to find. HandsFreeOS says today's 3 searches, in turn by
 * the day from the customer playbooks' **Kinds of business to search for on Alignable**, each with whether its playbook
 * works with clients online (`outreach.finds.searches`). A local one searches with the person's own town's name added
 * ("roofing contractor Austin TX") and keeps only the businesses whose address is in that town; one that works online
 * searches with the words alone and keeps every business it shows. Never the person's own business, which their own
 * profile names. Each reads 3 screens of Alignable's search, and what it kept goes to HandsFreeOS as found (`searched`,
 * with the words and the town), for the AI's found check (../found-checks.ts): only a good check puts a business on
 * Today. Nothing is pressed but a list's own Show more, and it stops on any Alignable warning.
 */
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

/** Today's searches of Alignable's businesses for the playbooks' kinds of business, and the businesses each found. */
export async function searchForCustomers(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which kinds of business to search for…');
  const { searches } = valueOf(
    await job.hfos({
      type: 'hfos-finds-searches',
      input: { workspaceId: job.businessId, platform: 'alignable' },
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
  let searched = 0;
  let shown = 0;
  let added = 0;
  let noTown = false;
  for (const search of searches) {
    if (job.stopped()) break;
    if (!search.anywhere && !town) {
      noTown = true;
      continue;
    }
    if (searched > 0) await pause(paced(PAGE_PACE_MS));
    const words = search.anywhere ? search.words : `${search.words} ${townWords(town!)}`;
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
    searched++;
    // A local search keeps only the businesses whose address is in the person's own town; never theirs.
    const kept = got.items.filter(
      (b) => someoneElse(b.profile) && (search.anywhere || townOf(b.profile.url) === town),
    );
    shown += kept.length;
    if (!kept.length) {
      await job.report?.({
        note: `Alignable’s search for a kind of business showed none${search.anywhere ? '' : ' in your town'}.`,
        outline: true,
      });
      continue;
    }
    const built = findsSave(kept.map(foundOf), 'searched', 'alignable', job.businessId, {
      words: search.words,
      place: search.anywhere ? null : townPlace(town!),
    });
    if (!built.ok) continue;
    for (const input of built.input)
      added += valueOf(await job.hfos({ type: 'hfos-finds-save', input })).added;
  }
  if (!searched && noTown) return { line: NO_TOWN, warned: false, failed: true };
  const parts = [
    `${job.stopped() ? 'Stopped. ' : ''}Searched Alignable for ${counted(searched, 'kind of business', 'kinds of business')}: ${counted(shown, 'business', 'businesses')} found, ${added.toLocaleString()} new to check.`,
    shown ? 'The good fits come onto Today once the AI has read their pages.' : null,
    noTown ? NO_TOWN : null,
  ];
  return { line: parts.filter(Boolean).join(' '), warned: false };
}
