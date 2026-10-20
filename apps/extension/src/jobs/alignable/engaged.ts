/**
 * Warm leads from Alignable's own notifications (the Instagram and Alignable plan's "Where the people are", 5: whoever
 * likes, comments on or recommends you). The extension opens Notifications, reads who liked or commented on the
 * person's posts and answers and who recommended them, and sends them to HandsFreeOS (`outreach.engaged.save`), where
 * each is a warm lead on Today: a like of theirs back, then a connection request. Nothing is pressed on Alignable, and
 * what anyone wrote stays there. It stops on any Alignable warning.
 */
import { counted } from '../../words';
import { valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ALIGNABLE, readAlignableIn, signedOutEnd } from './read';

export const NOTIFICATIONS = `${ALIGNABLE}/biz/notifications`;

/** Reads who engaged with them lately, and sends them as warm leads. */
export async function readWarmLeads(job: Job): Promise<JobEnd> {
  job.progress('Reading your Alignable notifications for who engaged with you…');
  await job.tab.open(NOTIFICATIONS);
  const page = await readAlignableIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  const engaged = page.found.engaged;
  const added = engaged.length
    ? valueOf(
        await job.hfos({
          type: 'hfos-engaged-save',
          input: {
            workspaceId: job.businessId,
            platform: 'alignable',
            engaged: engaged.map((e) => ({ profile: e.profile, name: e.name, kind: e.kind })),
          },
        }),
      ).added
    : 0;
  return {
    line: added
      ? `Read your Alignable notifications: ${counted(added, 'new warm lead')} who liked, commented on or recommended you, on your list for today.`
      : 'Read your Alignable notifications: nobody new liked, commented on or recommended you.',
    warned: false,
  };
}
