import { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import {
  AssistantRoutineOut,
  cadenceWords,
  RoutineCadence,
  RoutineWatch,
  watchWords,
} from '../assistant/routines';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { uuid } from '../schemas/common';

export const AssistantRoutineListInput = z.object({ workspaceId: uuid });
export const AssistantRoutineListOutput = z.object({ items: z.array(AssistantRoutineOut) });

interface Row extends Record<string, unknown> {
  id: string;
  kind: 'question' | 'alert';
  question: string | null;
  cadence: unknown;
  watch: unknown;
  email: boolean;
  once: boolean;
  paused_at: Date | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_fired_at: Date | null;
  fired_count: number;
  thread_id: string | null;
  name: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** A person's own, oldest first: RLS shows nobody anyone else's. */
export const assistantRoutineList = defineQuery({
  name: 'assistant_routine.list',
  description:
    'What you asked the Assistant to do on its own here: questions it asks on a schedule, and alerts, with when each runs next.',
  input: AssistantRoutineListInput,
  output: AssistantRoutineListOutput,
  // Listing your own needs no more than being here, so someone who lost the Assistant can still stop theirs.
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const userId = requireHuman(ctx).userId;
    const found = await rows<Row>(
      ctx.tx,
      sql`select r.id, r.kind::text as kind, r.question, r.cadence, r.watch, r.email, r.once, r.paused_at,
            r.next_run_at, r.last_run_at, r.last_fired_at, r.fired_count, r.thread_id,
            nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as name
          from app.assistant_routines r
          left join app.people p on p.id = (r.watch ->> 'personId')::uuid and p.workspace_id = r.workspace_id
          where r.workspace_id = ${input.workspaceId} and r.user_id = ${userId}
          order by r.created_at, r.id`,
    );
    const items = found.flatMap((r) => {
      const cadence = r.kind === 'question' ? RoutineCadence.safeParse(r.cadence) : null;
      const watch = r.kind === 'alert' ? RoutineWatch.safeParse(r.watch) : null;
      // A shape this build doesn't know (written by a newer one) is left off rather than shown wrong.
      if ((cadence && !cadence.success) || (watch && !watch.success)) return [];
      return [
        {
          id: r.id,
          kind: r.kind,
          when: cadence?.success
            ? cadenceWords(cadence.data)
            : watch?.success
              ? watchWords(watch.data, r.name)
              : '',
          question: r.question,
          cadence: cadence?.success ? cadence.data : null,
          watch: watch?.success ? watch.data : null,
          email: r.email,
          once: r.once,
          paused: r.paused_at !== null,
          nextRunAt: iso(r.next_run_at),
          lastRunAt: iso(r.last_run_at),
          lastFiredAt: iso(r.last_fired_at),
          firedCount: Number(r.fired_count),
          threadId: r.thread_id,
        },
      ];
    });
    return { items };
  },
});
