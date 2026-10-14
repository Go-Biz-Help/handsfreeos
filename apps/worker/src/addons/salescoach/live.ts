/**
 * Sales Coach on a call as it happens (docs/salescoach.md): the hooks the worker calls with each line it hears
 * (telephony/live.ts).
 *
 * - **Start**: the coached call begins with the business's usual playbook, and what the business knows is read once.
 * - **Each line**: when the customer has just finished saying something worth answering (coach.ts `cardMoment`), and
 *   the coach isn't still thinking about the last one, the fast model reads the playbook, the business and the last
 *   few minutes of the call, and says where the call is in the script and whether there's a card to show. A card goes
 *   to the rep's screen at once (the live update), and an objection's also to their phone, for a rep on their cell.
 * - **End**: what was said is kept, and the write-up is queued (./after-call.ts).
 *
 * A call's state lives here, on the machine hearing it, for as long as the call: nothing else needs it.
 */
import {
  cardMoment,
  checkedCard,
  CoachAnswer,
  COACH_SCHEMA,
  COACH_SYSTEM,
  coachPrompt,
  playbookText,
} from '@hfos/core/addons/salescoach/coach';
import { callBegin, callEnd, cardAdd } from '@hfos/core/addons/salescoach/ops/calls';
import type { PlaybookDetails } from '@hfos/core/addons/salescoach/playbooks';
import { executeCommand } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonLiveCalls, AddonScopeContext, LiveCall } from '../types';
import { businessText } from './business';

export const AFTER_CALL_JOB = 'salescoach.after_call';
/** Where a push about a call opens: the live call, on the phone or the web. */
export const LIVE_HREF = '/a/salescoach?view=live';

interface CallState {
  readonly coachedCallId: string;
  readonly playbook: { readonly name: string; readonly details: PlaybookDetails } | null;
  readonly business: string;
  lastAskedAtMs: number | null;
  asking: boolean;
}

const calls = new Map<string, CallState>();

/** The fast model the AI teammate thinks on calls with, else the usual one. */
const fast = (ctx: AddonScopeContext) => ({
  ...ctx,
  ai: { ...ctx.ai, provider: ctx.voiceAi ?? ctx.ai.provider },
});

export const salescoachLiveCalls: AddonLiveCalls = {
  async onStart(ctx, call) {
    const { output } = await executeCommand(
      ctx.db,
      callBegin,
      {
        workspaceId: ctx.scope.workspaceId,
        callId: call.callId,
        userId: call.teamUserId,
        personId: call.personId,
      },
      ctx.actor,
      ctx.meta,
    );
    calls.set(call.callId, {
      coachedCallId: output.coachedCallId,
      playbook: output.playbook,
      business: await businessText(ctx),
      lastAskedAtMs: null,
      asking: false,
    });
  },

  async onLine(ctx, call, line, lines) {
    const state = calls.get(call.callId);
    if (!state || state.asking || !cardMoment(line, state.lastAskedAtMs)) return;
    state.asking = true;
    state.lastAskedAtMs = line.atMs;
    try {
      await coach(ctx, call, state, lines);
    } finally {
      state.asking = false;
    }
  },

  async onEnd(ctx, call, lines) {
    const state = calls.get(call.callId);
    calls.delete(call.callId);
    if (!state) return;
    const { output } = await executeCommand(
      ctx.db,
      callEnd,
      { workspaceId: ctx.scope.workspaceId, coachedCallId: state.coachedCallId, lines },
      ctx.actor,
      ctx.meta,
    );
    if (output.state !== 'writing') return;
    await asWorker(ctx.db, ctx.scope, (tx) =>
      scheduleAddonJob(
        tx,
        { id: ctx.manifest.id, generation: ctx.generation },
        {
          kind: AFTER_CALL_JOB,
          dedupeKey: `${AFTER_CALL_JOB}:${state.coachedCallId}`,
          runAt: new Date(),
          payload: { coachedCallId: state.coachedCallId },
          workspaceId: ctx.scope.workspaceId,
          organizationId: ctx.scope.organizationId,
        },
      ),
    );
  },
};

async function coach(
  ctx: AddonScopeContext,
  call: LiveCall,
  state: CallState,
  lines: Parameters<AddonLiveCalls['onLine']>[3],
): Promise<void> {
  const details = state.playbook?.details ?? { steps: [], objections: [], points: [] };
  let answer: CoachAnswer;
  try {
    const { value } = await askStructured(fast(ctx), ctx.scope, {
      system: COACH_SYSTEM,
      context: [
        playbookText(state.playbook?.name ?? 'No playbook yet', details),
        state.business,
      ].join('\n\n'),
      messages: [{ role: 'user', content: coachPrompt(lines) }],
      schema: COACH_SCHEMA,
      zod: CoachAnswer,
      maxTokens: 400,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    answer = value;
  } catch (e) {
    // A card that doesn't come is a quiet moment on the call: the next line asks again.
    if (e instanceof AiAskError) {
      ctx.log.info({ code: e.code }, 'the coach had nothing this time');
      return;
    }
    throw e;
  }
  const checked = checkedCard(answer, details);
  if (!checked.card && !checked.step) return;
  const { output } = await executeCommand(
    ctx.db,
    cardAdd,
    {
      workspaceId: ctx.scope.workspaceId,
      coachedCallId: state.coachedCallId,
      step: checked.step,
      card: checked.card,
    },
    ctx.actor,
    ctx.meta,
  );
  const cardId = output.cardId;
  // An objection is the moment that matters: a rep on their cell sees it on their phone too.
  if (cardId && checked.card?.kind === 'objection')
    await asWorker(ctx.db, ctx.scope, (tx) =>
      pushAddonNotice(ctx, tx, {
        key: `objection:${cardId}`,
        userIds: [call.teamUserId],
        permission: 'salescoach.use',
        title: checked.card!.title,
        body: checked.card!.say,
        href: LIVE_HREF,
        collapseKey: `salescoach-call-${state.coachedCallId}`,
      }),
    );
}
