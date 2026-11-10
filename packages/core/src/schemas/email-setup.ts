/** The business email step's commands and query (messaging/email-setup.ts). */
import { z } from 'zod';
import { EMAIL_SETUP_PARTS, EmailSetupAnswers, EmailSetupStateOut } from '../messaging/email-setup';
import { email, uuid } from './common';

export const EmailSetupGetInput = z.object({ workspaceId: uuid });
export const EmailSetupGetOutput = z.object({
  state: EmailSetupStateOut,
  /** Where the step starts: how the business's email is set up now, else our picks. */
  answers: EmailSetupAnswers,
});

export const EmailSetupSaveInput = z.object({
  workspaceId: uuid,
  /** The screen being left: the address (sender), the domain's records, or the person's own address. */
  part: z.enum(EMAIL_SETUP_PARTS),
  email: EmailSetupAnswers,
});
export const EmailSetupSaveOutput = z.object({
  workspaceId: uuid,
  /** What changed, one line each. */
  changes: z.array(z.string()),
  /** The address mail goes out from now. */
  sender: z.string(),
  /** The domain being set up, when it's on the business's own. */
  emailDomainId: uuid.nullable(),
});

export const EmailDomainSendStepsInput = z.object({
  workspaceId: uuid,
  emailDomainId: uuid,
  /** You, or whoever looks after the domain. */
  to: email,
});
export const EmailDomainSendStepsOutput = z.object({
  emailDomainId: uuid,
  to: z.string(),
});
