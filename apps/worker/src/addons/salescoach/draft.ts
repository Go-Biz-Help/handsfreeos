/**
 * A playbook to start from (`salescoach.playbook.draft`, docs/salescoach.md): the model writes one the question-led
 * way from what the business says about itself and the owner's answers to the builder's questions, or tidies the
 * business's own script, pasted or read from one of its files. Before that, `salescoach.playbook.brief` answers what
 * it can of those questions, for the owner to fill in. Core holds what it's asked and checks the answer (coach.ts);
 * nothing is saved here, the owner edits it and saves. Each counts against the business's daily AI limit like any
 * other use.
 */
import {
  BRIEF_GUESS_SCHEMA,
  BRIEF_GUESS_SYSTEM,
  BriefGuessAnswer,
  briefGuessPrompt,
  checkedBrief,
  checkedDraft,
  PLAYBOOK_DRAFT_SCHEMA,
  PLAYBOOK_DRAFT_SYSTEM,
  PlaybookDraftAnswer,
  playbookDraftPrompt,
} from '@hfos/core/addons/salescoach/coach';
import {
  PLAYBOOK_LIMITS,
  PlaybookDraftInput,
  SalesBriefGuessInput,
  type PlaybookDraftOutput,
  type SalesBriefGuessOutput,
} from '@hfos/core/addons/salescoach/playbooks';
import { HfosError } from '@hfos/core/server';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../../ai/ask';
import { documentText } from '../../files/document-text';
import { readFileBytes } from '../../files/read';
import type { AddonScopeContext, AddonWorkerAction } from '../types';
import { businessText } from './business';

/** The largest file read as a script. */
const SCRIPT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** The script in one of the business's files, as text. */
async function scriptFromFile(ctx: AddonScopeContext, fileId: string): Promise<string> {
  const file = await readFileBytes(ctx, ctx.scope, fileId, SCRIPT_FILE_MAX_BYTES);
  if (!file.ok)
    throw file.why === 'too_large'
      ? HfosError.rule(
          'salescoach_script_too_large',
          413,
          'That file is too big to read as a script. Use one under 10 MB, or paste the script instead.',
        )
      : HfosError.notFound('That file isn’t there anymore. Upload it again, or paste the script.');
  const pdf = file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name);
  const text = /^text\//.test(file.mimeType ?? '') || /\.(txt|md)$/i.test(file.name);
  if (!pdf && !text)
    throw HfosError.rule(
      'salescoach_script_unreadable',
      422,
      `“${file.name}” isn’t a PDF or a text file, so its words can’t be read. Save it as a PDF, or paste the script.`,
    );
  const read = await documentText(file.bytes, pdf ? 'pdf' : 'text', PLAYBOOK_LIMITS.pastedScript);
  if (!read.text.trim())
    throw HfosError.rule(
      'salescoach_script_unreadable',
      422,
      `There are no words to read in “${file.name}” (it may be a scan). Paste the script instead.`,
    );
  return read.text;
}

export const playbookDraft: AddonWorkerAction<PlaybookDraftInput> = {
  permission: 'salescoach.manage',
  ai: {
    tool: 'salescoach_draft_playbook',
    description:
      "A Sales Coach playbook to start from: the AI writes one from what the business says about itself, or tidies the business's own call script, pasted (script) or read from one of its files (fileId). Nothing is saved: the owner edits it and saves.",
    autonomy: 'auto',
    keywords: ['draft a playbook', 'call script', 'sales playbook'],
  },
  input: PlaybookDraftInput,
  async run(ctx, raw): Promise<PlaybookDraftOutput> {
    const input = PlaybookDraftInput.parse(raw);
    const script = input.fileId ? await scriptFromFile(ctx, input.fileId) : (input.script ?? null);
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: PLAYBOOK_DRAFT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: playbookDraftPrompt({
              kind: input.kind,
              business: await businessText(ctx),
              script: script?.trim() || null,
              brief: input.brief ?? null,
            }),
          },
        ],
        schema: PLAYBOOK_DRAFT_SCHEMA,
        zod: PlaybookDraftAnswer,
        maxTokens: 6000,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return checkedDraft(value, input.kind);
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
        'The AI couldn’t write a playbook this time. Try again, or start from a blank one.',
      );
    }
  },
};

export const salesBriefGuess: AddonWorkerAction<Record<string, never>> = {
  permission: 'salescoach.manage',
  ai: {
    tool: 'salescoach_guess_sales_answers',
    description:
      "What HandsFreeOS can already answer of the script builder's questions (what the business sells, who buys, their usual problems, the result they want, why people pick it, the next step), from its profile and knowledge. Blank where it doesn't say. Nothing is saved.",
    autonomy: 'auto',
    keywords: ['build my scripts', 'sales script questions'],
  },
  input: SalesBriefGuessInput,
  async run(ctx, raw): Promise<SalesBriefGuessOutput> {
    SalesBriefGuessInput.parse(raw);
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: BRIEF_GUESS_SYSTEM,
        messages: [{ role: 'user', content: briefGuessPrompt(await businessText(ctx)) }],
        schema: BRIEF_GUESS_SCHEMA,
        zod: BriefGuessAnswer,
        maxTokens: 1200,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return { brief: checkedBrief(value) };
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
        'The AI couldn’t read what HandsFreeOS knows this time. Answer the questions yourself, or try again.',
      );
    }
  },
};
