/**
 * The AI helper for AI Social Media Content Creator's reading (docs/socialcontent.md, "When a read goes wrong"): the
 * reading computer asks when it couldn't read a page. `socialcontent.helper.look` is one look at the page's view
 * (everything a person wrote hidden) and the helper's verdict, what it says, and its one next move, checked against
 * the view (core's `checkedReadLook`). The extension takes the move and asks again, up to its last. Counted under
 * the add-on's AI use and charged to the business like any other. Without the AI (its limit, the balance, not set
 * up, busy) it says so, and the read is reported without it.
 *
 * Core holds what the model is asked and the checks (packages/core/src/addons/socialcontent/helper.ts).
 */
import {
  checkedReadLook,
  READ_LOOK_SCHEMA,
  ReadLookAnswer,
  ReadLookInput,
  readLookPrompt,
  readLookSystem,
} from '@hfos/core/addons/socialcontent/helper';
import {
  HELPER_NOT_ASKED,
  HELPER_SAID_MOST,
  type HelperLookOutput,
} from '@hfos/core/problem-report';
import { AiAskError, askStructured, notAskedWords } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';

export const READ_LOOK_ACTION = 'socialcontent.helper.look';

export const readLook: AddonWorkerAction<ReadLookInput> = {
  permission: 'socialcontent.use',
  input: ReadLookInput,
  async run(ctx, raw): Promise<HelperLookOutput> {
    const input = ReadLookInput.parse(raw);
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: readLookSystem(input.network),
        messages: [{ role: 'user', content: readLookPrompt(input) }],
        schema: READ_LOOK_SCHEMA,
        zod: ReadLookAnswer,
        maxTokens: 400,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return { ...checkedReadLook(value, input), asked: true };
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      return { ...HELPER_NOT_ASKED, said: notAskedWords(e).slice(0, HELPER_SAID_MOST) };
    }
  },
};
