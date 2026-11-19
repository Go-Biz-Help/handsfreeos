/**
 * In your hands in the worker (docs/outreach.md, decision 181; core's ./in-hands.ts):
 *
 * - **The ask's push** (`outreach.hands_ask`, one job a profile): someone taken into a person's hands, kept with Keep
 *   it mine (`outreach.hands.taken`), or who wrote back (`outreach.reply.seen`) has their ask looked at. Whether it's
 *   due, an hour of the person's working hours after they wrote back or when the AI would have followed up, is
 *   core's (`outreach.hands.asked`): the job pushes what it says, once, to whoever has them in their hands, and runs
 *   again when it says. It opens Needs you, where Let the AI take it and Keep it mine wait.
 * - **Given back in Contacts** (`person.handed_back`): every profile of that customer here is out of anyone's hands
 *   too (`outreach.hands.release`).
 */
import { handsAsked, handsRelease } from '@hfos/core/addons/outreach/ops/in-hands';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { refusedForGood, WAITING_HREF } from './waiting';

export const HANDS_ASK_JOB = 'outreach.hands_ask';

/** Looks at someone's ask now, or sooner than already planned. */
export async function armHandsAsk(
  ctx: AddonScopeContext,
  profileIds: readonly string[],
  now = Date.now(),
): Promise<void> {
  if (!profileIds.length) return;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    for (const profileId of profileIds)
      await scheduleAddonJob(
        tx,
        { id: ctx.manifest.id, generation: ctx.generation },
        {
          kind: HANDS_ASK_JOB,
          dedupeKey: `${HANDS_ASK_JOB}:${profileId}`,
          runAt: new Date(now),
          payload: { profileId },
          workspaceId: ctx.scope.workspaceId,
          organizationId: ctx.scope.organizationId,
        },
        { pullEarlier: true },
      );
  });
}

/** `outreach.hands.taken`: someone just went into a person's hands, or they pressed Keep it mine. */
export async function handsTaken(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { profileId?: string };
  if (typeof p.profileId === 'string') await armHandsAsk(ctx, [p.profileId]);
}

/** `outreach.reply.seen`: of those who wrote back, the ones in someone's hands have their ask looked at. */
export async function handsReplySeen(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { profileIds?: string[] };
  if (!p.profileIds?.length) return;
  const held = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`select p.id from addon_outreach.profiles p
          where p.workspace_id = ${ctx.scope.workspaceId}
            and p.id = any (${`{${p.profileIds!.join(',')}}`}::uuid[])
            and (exists (select 1 from addon_outreach.hands h where h.profile_id = p.id and h.back_at is null)
              or exists (select 1 from app.people_in_hands ph
                          where ph.person_id = p.person_id and ph.workspace_id = p.workspace_id))`,
    ),
  );
  await armHandsAsk(
    ctx,
    held.map((r) => r.id),
  );
}

/** `person.handed_back`: a customer given back to the AI in Contacts is given back here too. */
export async function handedBack(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { personId?: string };
  if (typeof p.personId !== 'string') return;
  await executeCommand(
    ctx.db,
    handsRelease,
    { workspaceId: ctx.scope.workspaceId, personId: p.personId },
    ctx.actor,
    ctx.meta,
  );
}

/** `outreach.hands_ask`: pushes the ask to whoever has them in their hands once it's due, and comes back when it will be. */
export async function handsAskJob(ctx: AddonJobContext): Promise<JobResult> {
  const profileId = ctx.job.payload['profileId'];
  if (typeof profileId !== 'string') return;
  const [holder] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ user_id: string | null; person_id: string | null }>(
      tx,
      sql`select coalesce(h.user_id, ph.user_id) as user_id, p.person_id
            from addon_outreach.profiles p
            left join addon_outreach.hands h on h.profile_id = p.id and h.back_at is null
            left join app.people_in_hands ph on ph.person_id = p.person_id and ph.workspace_id = p.workspace_id
           where p.workspace_id = ${ctx.scope.workspaceId} and p.id = ${profileId}
             and (h.profile_id is not null or ph.person_id is not null)`,
    ),
  );
  // Given back, gone, or in the hands of nobody in particular: nothing to ask.
  if (!holder?.user_id) return;
  const userId = holder.user_id;
  let out;
  try {
    ({ output: out } = await executeCommand(
      ctx.db,
      handsAsked,
      { workspaceId: ctx.scope.workspaceId, profileId, userId },
      ctx.actor,
      ctx.meta,
    ));
  } catch (e) {
    if (!refusedForGood(e)) throw e;
    ctx.log.warn({ err: e.message, rule: e.rule, profileId }, 'no ask for someone in hands');
    return;
  }
  if (out.push) {
    const push = out.push;
    await asWorker(ctx.db, ctx.scope, (tx) =>
      pushAddonNotice(ctx, tx, {
        key: `hands:${profileId}:${ctx.job.id}`,
        userIds: [userId],
        permission: 'outreach.use',
        title: push.title,
        body: push.body,
        href: WAITING_HREF,
        collapseKey: `hands-${profileId}`,
        personId: holder.person_id,
      }),
    );
  }
  return out.again ? { rescheduleAt: new Date(out.again) } : undefined;
}
