/**
 * AI help on a playbook's parts, from the builder (`outreach.playbook.assist`, docs/outreach.md): better words for a
 * part, or more to add, from the rest of the playbook as it stands. Core holds what the model is asked and checks
 * what it answers (playbook-assist.ts); nothing is saved here, the person picks what to use. It counts against the
 * business's daily AI limit like any other use.
 */
import {
  checkedAssist,
  PLAYBOOK_ASSIST_SCHEMA,
  PLAYBOOK_ASSIST_SYSTEM,
  PlaybookAssistAnswer,
  PlaybookAssistInput,
  playbookAssistPrompt,
  type PlaybookAssistOutput,
} from '@hfos/core/addons/outreach/playbook-assist';
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../../ai/ask';
import type { AddonWorkerAction } from '../types';

export const PLAYBOOK_ASSIST_ACTION = 'outreach.playbook.assist';

export const playbookAssist: AddonWorkerAction<PlaybookAssistInput> = {
  permission: 'outreach.manage',
  input: PlaybookAssistInput,
  async run(ctx, raw): Promise<PlaybookAssistOutput> {
    const input = PlaybookAssistInput.parse(raw);
    const [ws] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${ctx.scope.workspaceId}`,
      ),
    );
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: PLAYBOOK_ASSIST_SYSTEM,
        messages: [
          { role: 'user', content: playbookAssistPrompt(input, ws?.name ?? 'the business') },
        ],
        schema: PLAYBOOK_ASSIST_SCHEMA,
        zod: PlaybookAssistAnswer,
        maxTokens: 1500,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return checkedAssist(value, input);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        throw HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
      if (e.code === 'ai_unavailable')
        throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
      if (e.retryable) throw HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE);
      throw HfosError.rule(
        'ai_failed',
        502,
        'The AI couldn’t help with that just now. Try again, or write it yourself.',
      );
    }
  },
};
