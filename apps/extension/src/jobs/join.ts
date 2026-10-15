/**
 * Asking to join good groups (docs/outreach.md, decisions 31 and 48), asked from the Groups tab in HandsFreeOS (**Find
 * and join more groups**, or **Ask to join** on one) and done once a day while the extension works on its own, when
 * the person lets it and the groups have fewer people left to reach than a week of friend requests (src/auto/daily.ts).
 *
 * HandsFreeOS says which groups (the ones the AI says the business's people are in, or that fit well by name while it
 * hasn't read them), no more than today has room for (3 a day). With none, it searches Facebook for groups with the
 * playbook's words, checks the best of them, and asks again. For each, it opens the group, presses **Join group**,
 * and when the group asks questions first, the AI answers them from the playbook (the worker's
 * `outreach.join.answer`) and the extension writes them in, ticks that the person agrees to the rules, and submits.
 * Each ask is noted, with the answers given. It stops for the day on any Facebook warning.
 */
import { JOIN_QUESTION_MOST, type JoinAnswered } from '@hfos/core/addons/outreach/group-checks';
import type { JoinStep } from '../networks/facebook/join';
import { line } from '../networks/facebook/lookup';
import type { JoinsNext } from '../hfos/messages';
import { counted } from '../words';
import { saveGroups } from './groups';
import { checkGroups } from './groups-check';
import { paced, pause, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** Between groups, a person's pace; and how many groups found by a search are checked before joining. */
const PACE_MS = [20_000, 40_000] as const;
const SETTLE_MS = 2_000;
const FOUND_CHECKED = 3;

/** How one ask went, with the AI's answers to the group's questions. */
interface Went {
  readonly state: 'asked' | 'pending' | 'joined' | 'failed';
  readonly why: string | null;
  readonly answers?: readonly JoinAnswered[];
}

async function next(job: Job, groupIds: readonly string[] | null): Promise<JoinsNext> {
  return valueOf(
    await job.hfos({
      type: 'hfos-joins-next',
      input: { workspaceId: job.businessId, ...(groupIds ? { groupIds: [...groupIds] } : {}) },
    }),
  );
}

/** Asks to join one group: Join group, its questions answered by the AI, and how the page says it went. */
async function joinOne(
  job: Job,
  group: { groupId: string; name: string | null; url: string },
): Promise<Went | JobEnd> {
  await job.tab.open(group.url);
  const page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.group?.joined === true) return { state: 'joined', why: null };
  if (page.group?.asked) return { state: 'pending', why: null };
  const pressed = await job.tab.ask({ type: 'hfos-join' });
  if (!pressed.ok) return { state: 'failed', why: pressed.error };
  const step = (pressed as { step: JoinStep }).step;
  let answers: JoinAnswered[] = [];
  switch (step.result) {
    case 'none':
      return { state: 'failed', why: 'Facebook didn’t show Join group.' };
    case 'choices':
      return {
        state: 'failed',
        why: 'It asks questions to pick from a list. Join it yourself on Facebook.',
      };
    case 'already':
      return { state: step.joined ? 'joined' : 'pending', why: null };
    case 'questions': {
      job.progress(`Answering ${group.name ?? 'the group'}’s questions…`);
      const questions = step.questions.map((q) => line(q, JOIN_QUESTION_MOST));
      const answered = valueOf(
        await job.hfos({
          type: 'hfos-join-answers',
          workspaceId: job.businessId,
          input: { groupId: group.groupId, questions },
        }),
      );
      answers = questions.map((question, i) => ({ question, answer: answered.answers[i] ?? '' }));
      const sent = await job.tab.ask({
        type: 'hfos-join-answer',
        answers: answered.answers,
      });
      if (!sent.ok) return { state: 'failed', why: sent.error };
      if ((sent as { result: string }).result !== 'done')
        return { state: 'failed', why: 'Facebook didn’t take the answers. Join it yourself.' };
      break;
    }
    case 'asked':
      break;
  }
  await pause(SETTLE_MS);
  const after = await readIn(job.tab);
  const warnedAfter = await warnedOn(job, after);
  if (warnedAfter) return warnedAfter;
  const state = after.group?.joined === true ? 'joined' : after.group?.asked ? 'pending' : 'asked';
  return { state, why: null, answers: answers.filter((a) => a.answer) };
}

/**
 * Asks to join the groups named, or the best not joined yet; `daily` only when the person lets it join on its own
 * and people left to reach are low. With none to join, it searches for groups with the playbook's words first.
 */
export async function joinGroups(
  job: Job,
  groupIds: readonly string[] | null,
  daily = false,
): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which groups to join…');
  let got = await next(job, groupIds);
  if (daily && !got.onItsOwn)
    return { line: 'Joining groups on its own is off in your settings.', warned: false };
  if (daily && !got.prospects.low)
    return {
      line: `Your groups have ${counted(got.prospects.left, 'person', 'people')} left to reach: no need to join more yet.`,
      warned: false,
    };
  if (got.today >= got.perDay)
    return {
      line: `That’s today’s ${got.perDay.toLocaleString()} groups asked. It carries on tomorrow.`,
      warned: false,
    };
  if (!got.groups.length && !groupIds && got.words) {
    // None good to join: find some with the playbook's words, check the best, and look again.
    const found = await saveGroups(job, got.words);
    if (found.warned) return found;
    if (job.stopped()) return { line: 'Stopped.', warned: false };
    const checked = await checkGroups(job, FOUND_CHECKED);
    if (checked.warned) return checked;
    got = await next(job, null);
  }
  if (!got.groups.length)
    return {
      line: groupIds
        ? 'That group can’t be joined from here now: you’re in it or asked already.'
        : 'No good groups to join yet. Find groups on the Groups tab, then check them.',
      warned: false,
    };
  const done: Record<Went['state'], number> = { asked: 0, pending: 0, joined: 0, failed: 0 };
  const why: string[] = [];
  for (const [i, group] of got.groups.entries()) {
    if (job.stopped()) break;
    job.progress(`${i + 1} of ${got.groups.length}: asking to join ${group.name ?? 'a group'}…`);
    let went: Went | JobEnd;
    try {
      went = await joinOne(job, group);
    } catch (error) {
      went = { state: 'failed', why: error instanceof Error ? error.message : String(error) };
    }
    if ('line' in went) return went;
    valueOf(
      await job.hfos({
        type: 'hfos-join-note',
        input: {
          workspaceId: job.businessId,
          groupId: group.groupId,
          state: went.state,
          answers: [...(went.answers ?? [])],
          why: went.state === 'failed' ? (went.why ?? 'Facebook didn’t take it.') : null,
        },
      }),
    );
    if (went.state === 'failed' && went.why) why.push(`${group.name ?? 'A group'}: ${went.why}`);
    done[went.state]++;
    if (i < got.groups.length - 1 && !job.stopped()) await pause(paced(PACE_MS));
  }
  const parts = [
    done.joined ? `Joined ${counted(done.joined, 'group')}.` : null,
    done.pending || done.asked
      ? `Asked to join ${counted(done.pending + done.asked, 'group')}; the admins say yes or no.`
      : null,
    done.failed ? `Couldn’t join ${counted(done.failed, 'group')}. ${why.join(' ')}` : null,
  ].filter(Boolean);
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}${parts.join(' ') || 'Nothing joined.'}`,
    warned: false,
    failed: done.joined + done.pending + done.asked === 0,
  };
}
