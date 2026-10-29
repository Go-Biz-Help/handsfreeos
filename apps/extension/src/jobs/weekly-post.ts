/**
 * The week's helpful post on Instagram and Alignable (docs/outreach.md, decision 109): once a day their runners ask
 * HandsFreeOS for it (`outreach.helpful.ask`), which has the AI write one only when the week's is done with (one a
 * week there), and says so otherwise. Nothing is pressed on the network: on Instagram the person posts it from their
 * phone, and on Alignable their OK sends their computer a `post` ask (./alignable/helpful.ts).
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import type { Job, JobEnd } from './job';

export async function askWeeklyPost(
  job: Job,
  platform: Extract<Platform, 'instagram' | 'alignable'>,
): Promise<JobEnd> {
  const name = NETWORKS[platform].name;
  job.progress(`Asking for this week’s helpful post for ${name}…`);
  const asked = await job.hfos({
    type: 'hfos-helpful-ask',
    input: { workspaceId: job.businessId, platform },
  });
  return {
    line: asked.ok
      ? asked.value.fresh
        ? `The AI is writing this week’s helpful post for ${name}. It’s on Today for you.`
        : `This week’s helpful post for ${name} is asked for already: it’s on Today.`
      : asked.problem.message,
    warned: false,
  };
}
