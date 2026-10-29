/**
 * Birthdays and new jobs, once a day (docs/outreach.md decision 108, the owner's pick 5a), from 0.100.0: Facebook's
 * Birthdays page, whose birthday it is today, and LinkedIn's Catch up, its birthdays and new jobs, a few screens of it.
 * What they show goes to HandsFreeOS (`outreach.occasions.save`), which keeps those among the people already kept;
 * Today then offers a short note to those the person has chatted with or who fit a playbook, and it waits for their
 * OK. Nothing is pressed or written here: it only opens and reads, and stops on any warning of the network's.
 */
import {
  OCCASION_WORDS,
  OCCASIONS_SAVE_MOST,
  type OccasionsSaveInput,
} from '@hfos/core/addons/outreach/occasions';
import { isToday } from '../networks/facebook/birthdays';
import type { ReadResult } from '../networks/facebook/types';
import { FACEBOOK } from '../networks/facebook/urls';
import { profileKey as linkedInKey } from '../networks/linkedin/urls';
import type { CatchUp } from '../networks/linkedin/types';
import { readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import { ended, gather, LINKEDIN } from './linkedin/read';

export const BIRTHDAYS_PAGE = `${FACEBOOK}/events/birthdays/`;
export const CATCH_UP_PAGE = `${LINKEDIN}/mynetwork/catch-up/all/`;
/** Screens of Catch up read: its newest news first, a person's look. */
const CATCH_UP_SCROLLS = 3;

type Seen = OccasionsSaveInput['occasions'][number];

/** Today's birthdays on Facebook's Birthdays page, as HandsFreeOS keeps them. */
export function birthdaysOn(page: Pick<ReadResult, 'people'>): Seen[] {
  return (page.people ?? []).flatMap((person) =>
    person.profile && isToday(person)
      ? [{ profile: person.profile, name: person.name, kind: 'birthday' as const, detail: null }]
      : [],
  );
}

/** Hands what a page showed to HandsFreeOS, and says how it went. */
async function save(job: Job, platform: 'facebook' | 'linkedin', seen: Seen[]): Promise<JobEnd> {
  if (!seen.length) return { line: OCCASION_WORDS.saved(0), warned: false };
  const saved = valueOf(
    await job.hfos({
      type: 'hfos-occasions-save',
      input: {
        workspaceId: job.businessId,
        platform,
        occasions: seen.slice(0, OCCASIONS_SAVE_MOST),
      },
    }),
  );
  return { line: OCCASION_WORDS.saved(saved.kept), warned: false };
}

/** Facebook's Birthdays page, read once. */
export async function facebookOccasions(job: Job): Promise<JobEnd> {
  job.progress('Reading your friends’ birthdays…');
  await job.tab.open(BIRTHDAYS_PAGE);
  const page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  return save(job, 'facebook', birthdaysOn(page));
}

/** LinkedIn's Catch up, a few screens of it. */
export async function linkedInOccasions(job: Job): Promise<JobEnd> {
  await job.tab.open(CATCH_UP_PAGE);
  const got = await gather<CatchUp>(
    job,
    CATCH_UP_SCROLLS,
    (page) => page.catchUp ?? [],
    (item) => `${item.kind}:${linkedInKey(item.profile)}`,
    (count) => `Reading Catch up for birthdays and new jobs… ${count} so far`,
  );
  if (ended(got)) return got;
  return save(
    job,
    'linkedin',
    got.items.map((item) => ({
      profile: item.profile,
      name: item.name,
      kind: item.kind,
      detail: item.detail,
    })),
  );
}
