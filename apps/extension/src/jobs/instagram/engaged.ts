/**
 * Warm leads from Instagram's own notifications (part 15; the Instagram and Alignable plan's "Where the people are", 1:
 * "People engaging with you: new followers, likes and comments on your posts"), once a day while it works on its own,
 * as Alignable's are (../alignable/engaged.ts). The extension opens the person's notifications, reads who started
 * following them and who liked or commented on their posts, and sends them to HandsFreeOS (`outreach.engaged.save`),
 * where each is a warm lead on Today: someone who followed them is followed back, and someone who liked or commented
 * gets a like of theirs back, then a follow. Someone the person follows already, by the notification's own button,
 * isn't sent as a follow. Nothing is pressed on Instagram, and what anyone wrote stays there. It stops on any
 * Instagram warning.
 */
import { ENGAGED_MOST } from '@hfos/core/addons/outreach/helpful';
import { counted } from '../../words';
import { valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { INSTAGRAM, readInstagramIn, signedOutEnd } from './read';

export const NOTIFICATIONS = `${INSTAGRAM}/notifications/`;

/** Reads who engaged with them lately, and sends them as warm leads. */
export async function readInstagramWarmLeads(job: Job): Promise<JobEnd> {
  job.progress('Reading your Instagram notifications for who engaged with you…');
  await job.tab.open(NOTIFICATIONS);
  const page = await readInstagramIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  // A follow from someone the person follows already wants nothing back.
  const engaged = page.found.engaged
    .filter(
      (e) => e.kind !== 'follow' || (e.following !== 'following' && e.following !== 'requested'),
    )
    .slice(0, ENGAGED_MOST);
  const added = engaged.length
    ? valueOf(
        await job.hfos({
          type: 'hfos-engaged-save',
          input: {
            workspaceId: job.businessId,
            platform: 'instagram',
            engaged: engaged.map((e) => ({
              profile: { id: null, username: e.username, url: e.url },
              name: e.username,
              kind: e.kind,
            })),
          },
        }),
      ).added
    : 0;
  return {
    line: added
      ? `Read your Instagram notifications: ${counted(added, 'new warm lead')} who followed you or liked or commented on your posts, on your list for today.`
      : 'Read your Instagram notifications: nobody new followed you or liked or commented on your posts.',
    warned: false,
  };
}
