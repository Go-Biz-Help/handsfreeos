/** The business email step's starting point (messaging/email-setup.ts): Home's card and its screens read it. */
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { startingEmailSetupAnswers } from '../messaging/email-setup';
import { loadEmailSetupState } from '../messaging/email-setup-load';
import { EmailSetupGetInput, EmailSetupGetOutput } from '../schemas/email-setup';

export const emailSetupGet = defineQuery({
  name: 'email_setup.get',
  description:
    'The business email step: the address booking emails go out from now, the business’s free address and own domains (with their DNS records, where each is managed and what happens once they check out), your own address, connected mailboxes, and the answers to start from.',
  input: EmailSetupGetInput,
  output: EmailSetupGetOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const state = await loadEmailSetupState(ctx.tx, input.workspaceId, requireHuman(ctx).userId);
    return { state, answers: startingEmailSetupAnswers(state) };
  },
});
