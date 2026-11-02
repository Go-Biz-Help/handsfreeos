/**
 * The AI helper (docs/outreach.md, decision 142): the extension asks when one of its steps didn't go.
 *
 * - `outreach.helper.look`: one look at the page's view (everything a person wrote hidden), and the helper's verdict,
 *   what it says, and its one next move, checked against the view (core's `checkedHelperAnswer`). The extension takes
 *   the move and asks again, up to its last. Counted under the add-on's AI use and charged to the business like any
 *   other. Without the AI (its limit, the balance, not set up, busy) it says so, and the step is reported without it.
 * - `outreach.helper.ways`: the learned ways every computer tries on a network before asking: trusted (worked twice),
 *   never one set aside.
 * - `outreach.helper.way`: a way pressed on the person's computer, and whether the page showed the step went: kept
 *   across every business (`private.note_learned_way`), trusted once it has worked twice.
 *
 * Core holds what the model is asked and the checks (packages/core/src/addons/outreach/helper.ts).
 */
import {
  checkedHelperAnswer,
  HELPER_NOT_ASKED,
  HELPER_SAID_MOST,
  HELPER_SCHEMA,
  HELPER_WAYS_MOST,
  HelperAnswer,
  HelperLookInput,
  helperPrompt,
  helperSystem,
  HelperWayNoteInput,
  HelperWaysInput,
  wayFits,
  wayKey,
  type HelperLookOutput,
  type HelperWaysOutput,
} from '@hfos/core/addons/outreach/helper';
import { LearnedWayShape } from '@hfos/core/problem-report';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';

export const HELPER_LOOK_ACTION = 'outreach.helper.look';
export const HELPER_WAYS_ACTION = 'outreach.helper.ways';
export const HELPER_WAY_ACTION = 'outreach.helper.way';

export const helperLook: AddonWorkerAction<HelperLookInput> = {
  permission: 'outreach.use',
  input: HelperLookInput,
  async run(ctx, raw): Promise<HelperLookOutput> {
    const input = HelperLookInput.parse(raw);
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: helperSystem(input.platform, input.button),
        messages: [{ role: 'user', content: helperPrompt(input) }],
        schema: HELPER_SCHEMA,
        zod: HelperAnswer,
        maxTokens: 400,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return { ...checkedHelperAnswer(value, input), asked: true };
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // Why, in HandsFreeOS's own words (its limit, the balance, busy), for the step's report (decision 144).
      return { ...HELPER_NOT_ASKED, said: e.message.slice(0, HELPER_SAID_MOST) };
    }
  },
};

export const helperWays: AddonWorkerAction<HelperWaysInput> = {
  permission: 'outreach.use',
  input: HelperWaysInput,
  async run(ctx, raw): Promise<HelperWaysOutput> {
    const input = HelperWaysInput.parse(raw);
    const found = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ button: string; way: unknown }>(
        tx,
        sql`select w.button, w.way from platform.learned_ways w
            where w.addon_id = ${ctx.manifest.id} and w.area = ${input.platform}
              and w.trusted_at is not null and w.removed_at is null
            order by w.last_worked_at desc nulls last, w.id
            limit ${HELPER_WAYS_MOST}`,
      ),
    );
    return {
      ways: found.flatMap((w) => {
        const way = LearnedWayShape.safeParse(w.way);
        const button = HelperWayNoteInput.shape.button.safeParse(w.button);
        return way.success && button.success ? [{ button: button.data, way: way.data }] : [];
      }),
    };
  },
};

export const helperWay: AddonWorkerAction<HelperWayNoteInput> = {
  permission: 'outreach.use',
  input: HelperWayNoteInput,
  async run(ctx, raw): Promise<{ trusted: boolean; removed: boolean }> {
    const input = HelperWayNoteInput.parse(raw);
    // A way that holds nothing of the network's own, or doesn't press the step's own button, is never kept.
    if (!wayFits(input.way, input.button)) return { trusted: false, removed: false };
    const [kept] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ trusted: boolean; removed: boolean }>(
        tx,
        sql`select trusted, removed from private.note_learned_way(${ctx.scope.workspaceId!}::uuid,
              ${ctx.manifest.id}, ${input.platform}, ${input.button}, ${JSON.stringify(input.way)}::jsonb,
              ${wayKey(input.way)}, ${input.worked})`,
      ),
    );
    return { trusted: kept?.trusted ?? false, removed: kept?.removed ?? false };
  },
};
