/**
 * The person's own profile, read on its own on the 1st of each month (docs/outreach.md, decision 99, answer 17a): a
 * once-a-day job on every network (`profile`, last of the day's jobs) that does nothing till the latest read of that
 * network's profile is from before this month's 1st by the computer's clock, or there's none (`profileReadDue`). Then
 * it reads the profile as **Read my profile** does and has the AI check it, the check marked `own`: what the AI suggests
 * waits for the person's OK on Get ready, and Today says so. Nothing is put in, and nothing is handed over: a read it
 * can't do waits for the next day it works.
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { profileReadDue } from '@hfos/core/addons/outreach/profile-parts';
import type { HfosAsk } from '../hfos/messages';
import { valueOf, type Hfos, type Job, type JobEnd } from './job';

/** A job whose AI check of the profile is marked as read on its own. */
function readingOnItsOwn(job: Job): Job {
  const hfos: Hfos = (ask) =>
    job.hfos(
      (ask.type === 'hfos-profile-check'
        ? { ...ask, input: { ...ask.input, own: true } }
        : ask) as HfosAsk as typeof ask,
    );
  // Nothing's handed over on its own: a step it can't find ends the read.
  return { ...job, hfos, handOver: undefined };
}

/** Reads the network's profile when it's due this month (`read` is its Read my profile), else says when it's next. */
export async function readProfileOnItsOwn(
  job: Job,
  platform: Platform,
  read: (job: Job) => Promise<JobEnd>,
  now: Date = new Date(),
): Promise<JobEnd> {
  const profiles = valueOf(await job.hfos({ type: 'hfos-profiles', workspaceId: job.businessId }));
  const at = profiles.checks[platform]?.at ?? null;
  if (!profileReadDue(at, now))
    return { line: `Your ${NETWORKS[platform].name} profile was read this month.`, warned: false };
  const ended = await read(readingOnItsOwn(job));
  return ended.failed || ended.warned
    ? ended
    : {
        line: `Read your ${NETWORKS[platform].name} profile, as it does on the 1st. What the AI suggests waits for your OK in Get ready.`,
        warned: false,
      };
}
