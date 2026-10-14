/**
 * After a coached call (docs/salescoach.md): the write-up. The model reads the whole call and the playbook it used,
 * and writes the summary, the notes, what the rep promised, a follow-up text, the objections and the steps covered;
 * core checks it and works out the score (coach.ts), and `salescoach.call.finish` puts the notes on the customer's
 * timeline and each promise in the rep's tasks.
 *
 * A busy AI is tried again later (the job's retries); one that can't answer at all finishes the call without a
 * write-up, saying why, so it never sits at "writing".
 */
import {
  AFTER_CALL_SCHEMA,
  AFTER_CALL_SYSTEM,
  AfterCallAnswer,
  afterCallPrompt,
  checkedAfterCall,
  type CallLine,
  playbookText,
} from '@hfos/core/addons/salescoach/coach';
import { callFinish } from '@hfos/core/addons/salescoach/ops/calls';
import { PlaybookDetails } from '@hfos/core/addons/salescoach/playbooks';
import { executeCommand, localDateOf } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import type { AddonJobHandler } from '../types';

/** What a write-up that couldn't be made says to the rep. */
const NO_WRITE_UP =
  'The AI couldn’t write this call up. The call itself is on the customer’s timeline as usual.';

export const afterCall: AddonJobHandler = async (ctx) => {
  const coachedCallId = (ctx.job.payload as { coachedCallId?: unknown }).coachedCallId;
  if (typeof coachedCallId !== 'string') return;
  const [c] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      state: string;
      lines: CallLine[];
      playbook_name: string | null;
      details: unknown;
      timezone: string;
    }>(
      tx,
      sql`select c.state, c.lines, c.playbook_name, p.details, w.timezone
          from addon_salescoach.calls c
          join app.workspaces w on w.id = c.workspace_id
          left join addon_salescoach.playbooks p on p.id = c.playbook_id
          where c.id = ${coachedCallId} and c.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!c || c.state !== 'writing') return;
  const parsed = PlaybookDetails.safeParse(c.details ?? {});
  const details = parsed.success ? parsed.data : { steps: [], objections: [], points: [] };
  const finish = (input: { result: unknown; failure: string | null }) =>
    executeCommand(
      ctx.db,
      callFinish,
      { workspaceId: ctx.scope.workspaceId, coachedCallId, ...input },
      ctx.actor,
      ctx.meta,
    );
  let answer: AfterCallAnswer;
  try {
    const { value } = await askStructured(ctx, ctx.scope, {
      system: AFTER_CALL_SYSTEM,
      messages: [
        {
          role: 'user',
          content: afterCallPrompt({
            playbook: playbookText(c.playbook_name ?? 'No playbook', details),
            lines: c.lines,
            today: localDateOf(ctx.now, c.timezone),
          }),
        },
      ],
      schema: AFTER_CALL_SCHEMA,
      zod: AfterCallAnswer,
      maxTokens: 2000,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    answer = value;
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // Busy: the job tries again. Anything else won't be different next time.
    if (e.retryable && ctx.attempt < 4) throw e;
    await finish({
      result: null,
      failure: e.code === 'budget_reached' || e.code === 'wallet_empty' ? e.message : NO_WRITE_UP,
    });
    return;
  }
  await finish({ result: checkedAfterCall(answer, details, c.lines), failure: null });
};
