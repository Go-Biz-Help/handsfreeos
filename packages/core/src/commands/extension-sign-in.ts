/**
 * Answering an extension sign-in from the phone or the web (20261027002910, account/extension-sign-in.ts): the
 * person picks the number the extension shows. The right one approves it; a wrong one, or "That wasn't me" (no
 * pick), refuses it, and either way it is answered once. Only the person the email belongs to can answer, as
 * themselves (`private.answer_extension_sign_in` reads `auth.uid()`). Starting a request and collecting its answer
 * are the worker's public doors (apps/worker/src/http/extension-sign-in.ts), since nobody is signed in yet.
 */
import { rows, sql } from '@hfos/db/client';
import {
  EXTENSION_SIGN_IN_WORDS,
  ExtensionSignInAnswerInput,
  ExtensionSignInAnswerOutput,
} from '../account/extension-sign-in';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';

export const extensionSignInAnswer = defineCommand({
  name: 'extension_sign_in.answer',
  description:
    'Answer a sign-in to the browser extension with your email: pick the number it shows to let it in, or say it wasn’t you. A wrong number stops it.',
  risk: 2,
  input: ExtensionSignInAnswerInput,
  output: ExtensionSignInAnswerOutput,
  permission: null,
  scope: () => ({ kind: 'account' as const }),
  emits: ['extension_sign_in.approved', 'extension_sign_in.refused'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [row] = await rows<{ outcome: string }>(
      ctx.tx,
      sql`select private.answer_extension_sign_in(${input.requestId}::uuid, ${input.pick}::smallint) as outcome`,
    );
    const said = row?.outcome;
    if (said !== 'approved' && said !== 'refused')
      throw HfosError.rule('sign_in_request_gone', 409, EXTENSION_SIGN_IN_WORDS.gone);
    const outcome: 'approved' | 'refused' = said;
    await ctx.emit({
      type: outcome === 'approved' ? 'extension_sign_in.approved' : 'extension_sign_in.refused',
      entityType: 'extension_sign_in',
      entityId: input.requestId,
      organizationId: null,
      workspaceId: null,
      // Never the number: only whether it matched, and whether a number was picked at all.
      payload: { requestId: input.requestId, userId: me, picked: input.pick !== null },
      after: { outcome },
    });
    return { outcome };
  },
});
