/** The business email step's commands and query (messaging/email-setup.ts), and the guided setup's (email-guided.ts). */
import { z } from 'zod';
import { EmailGuidedAnswers } from '../messaging/email-guided';
import { EMAIL_SETUP_PARTS, EmailSetupAnswers, EmailSetupStateOut } from '../messaging/email-setup';
import { email, uuid } from './common';
import { EMAIL_MX_RECORDS_MAX, EmailMxRecord } from './email';

export const EmailSetupGetInput = z.object({ workspaceId: uuid });
export const EmailSetupGetOutput = z.object({
  state: EmailSetupStateOut,
  /** Where the step starts: how the business's email is set up now, else our picks. */
  answers: EmailSetupAnswers,
  /** Where the guided setup starts, the same way. */
  guided: EmailGuidedAnswers,
});

/** The guided setup's "Set it up": every answer at once, checked again here. */
export const EmailSetupApplyInput = z.object({
  workspaceId: uuid,
  email: EmailGuidedAnswers,
});
export const EmailSetupApplyOutput = z.object({
  workspaceId: uuid,
  /** What changed, one line each. */
  changes: z.array(z.string()),
  /** The address mail goes out from now. */
  sender: z.string(),
  /** The website name being set up, when it's the business's own. */
  emailDomainId: uuid.nullable(),
  /** What's left: its sending records to add, its mail record to change, or nothing. */
  left: z.enum(['records', 'mail', 'done']),
});

/** The guided setup's first question: look a website name up before anything is added. */
export const EmailSetupLookUpInput = z.object({
  workspaceId: uuid,
  /** As typed: "burroughs.digital". */
  domain: z.string().max(300),
});
export const EmailSetupLookUpOutput = z.object({
  /** The name as it's looked up. */
  domain: z.string(),
  askedAt: z.iso.datetime(),
});

/** Worker: what DNS said about a name a business looked up. Each part absent when DNS didn't answer. */
export const EmailSetupRecordLookupInput = z.object({
  workspaceId: uuid,
  domain: z.string().min(1).max(253),
  mailHost: z.string().trim().min(1).max(40).optional(),
  dnsHost: z.string().trim().min(1).max(40).optional(),
  mxRecords: z.array(EmailMxRecord).max(EMAIL_MX_RECORDS_MAX).optional(),
});
export const EmailSetupRecordLookupOutput = z.object({ domain: z.string() });

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
