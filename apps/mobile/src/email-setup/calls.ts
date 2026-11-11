import type { paths } from '@hfos/api-client';
import {
  EmailSetupGetOutput,
  EmailSetupSaveOutput,
  type EmailSetupAnswers,
  type EmailSetupPart,
} from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { NotInThisBuild } from '@/lib/not-in-this-build';

/** What a command takes, from the API's own description of it. */
type In<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

export type EmailSetupGot = ReturnType<typeof EmailSetupGetOutput.parse>;
export type EmailSetupSaved = ReturnType<typeof EmailSetupSaveOutput.parse>;

/**
 * The business email step's calls from the phone (messaging/email-setup.ts), as the web's screens make them: where it
 * stands, saving a part (`email_setup.save`, on its own page from Home's card; the onboarding setup saves it with its
 * own screens), asking for the domain's records to be checked, sending the steps to someone, and Outlook's sign-in.
 * All of them need signal.
 */
export function emailSetupCalls(workspaceId: string) {
  return {
    get: async (): Promise<EmailSetupGot> =>
      EmailSetupGetOutput.parse(
        unwrap(await api.POST('/v1/queries/email_setup.get', { body: { workspaceId } })),
      ),
    save: async (part: EmailSetupPart, email: EmailSetupAnswers): Promise<EmailSetupSaved> =>
      EmailSetupSaveOutput.parse(
        unwrap(
          await api.POST('/v1/commands/email_setup.save', {
            body: {
              workspaceId,
              part,
              email: email as unknown as In<'/v1/commands/email_setup.save'>['email'],
            },
          }),
        ),
      ),
    /** Looks for the domain's records now; the answer comes a moment later. */
    verify: async (emailDomainId: string): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/email_domain.verify', {
          body: { workspaceId, emailDomainId },
        }),
      );
    },
    /** Emails the domain's records and where to add them. */
    sendSteps: async (emailDomainId: string, to: string): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/email_domain.send_steps', {
          body: { workspaceId, emailDomainId, to },
        }),
      );
    },
    /** Where Outlook's (or Gmail's) own sign-in starts, through the worker, which keeps what it gives back. */
    mailboxSignIn: async (provider: 'microsoft' | 'google'): Promise<string> => {
      if (!config.workerUrl) throw new NotInThisBuild();
      const { state } = unwrap(
        await api.POST('/v1/commands/mailbox.connect', { body: { workspaceId, provider } }),
      );
      return `${config.workerUrl}/oauth/${provider}/start?state=${encodeURIComponent(state)}`;
    },
  };
}

export type EmailSetupCalls = ReturnType<typeof emailSetupCalls>;
