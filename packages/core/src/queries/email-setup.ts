/** The business email step's starting point (messaging/email-setup.ts): Home's card and its screens read it. */
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { startingEmailGuidedAnswers } from '../messaging/email-guided';
import { startingEmailSetupAnswers } from '../messaging/email-setup';
import { loadEmailSetupState } from '../messaging/email-setup-load';
import { EmailSetupGetInput, EmailSetupGetOutput } from '../schemas/email-setup';

export const emailSetupGet = defineQuery({
  name: 'email_setup.get',
  description:
    'The business email step and the guided email setup: the address booking emails go out from now, every address the business has and who reads each, its free address and own domains (with their DNS records, their mail records as last seen, where each is managed and what happens once they check out), the website name last looked up, your own address, connected mailboxes, and the answers to start from (answers for the older step, guided for the guided setup).',
  input: EmailSetupGetInput,
  output: EmailSetupGetOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const state = await loadEmailSetupState(ctx.tx, input.workspaceId, requireHuman(ctx).userId);
    return {
      state,
      answers: startingEmailSetupAnswers(state),
      guided: startingEmailGuidedAnswers(state),
    };
  },
});
