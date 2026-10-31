/**
 * The script the AI teammate follows on a call it placed to a lead (docs/salescoach.md, "The AI teammate's calls"):
 * the business's script for that kind of call, the one the coach would pick for a rep making it (method.ts
 * `callKindFor`), cut to the questions up to how much it matters (coach.ts `callerScript`). The AI then books someone
 * on the team to show how it works and ask for a yes. A business with no script leaves the call to go on without one.
 */
import { callerScript } from '@hfos/core/addons/salescoach/coach';
import { callKindFor } from '@hfos/core/addons/salescoach/method';
import { callStart, playbookForKind } from '@hfos/core/addons/salescoach/ops/calls';
import { PlaybookDetails } from '@hfos/core/addons/salescoach/playbooks';
import { asWorker } from '@hfos/db/client';
import type { AddonWorkerModule } from '../types';

export const salescoachCallScript: NonNullable<AddonWorkerModule['callScript']> = async (
  ctx,
  call,
) => {
  const pb = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const start = await callStart(
      tx,
      { callId: null, liveMeetingId: null, personId: call.personId },
      new Date(),
    );
    // It placed the call, as a rep would: a new or older lead's script, or a booked call's at an appointment's time.
    return playbookForKind(
      tx,
      ctx.scope.workspaceId,
      callKindFor({ ...start, direction: 'outbound' }),
    );
  });
  if (!pb) return null;
  const details = PlaybookDetails.safeParse(pb.details);
  if (!details.success) {
    ctx.log.warn(
      { playbookId: pb.id },
      'a script that doesn’t read as one; the call goes on without it',
    );
    return null;
  }
  return callerScript(pb.name, pb.kind, details.data);
};
