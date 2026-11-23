import type { paths } from '@hfos/api-client';
import { EmailSetupApplyOutput, EmailSetupGetOutput, type EmailGuidedAnswers } from '@hfos/core';

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
export type EmailSetupApplied = ReturnType<typeof EmailSetupApplyOutput.parse>;
/** The guided questions' answers as they were left, and when. */
export interface EmailGuidedDraft {
  readonly answers: Record<string, unknown> | null;
  readonly savedAt: string | null;
}

/**
 * The business email's calls from the phone (messaging/email-setup.ts), as the web's screens make them: where it
 * stands, asking for the domain's records to be checked, sending the steps to someone, and Outlook's sign-in (the
 * onboarding setup saves its email screens with its own). The guided setup (the owner, 22 Nov 2026) adds its own:
 * the answers as they were left, looking a website name up, "Set it up", and asking for the mail record to be
 * looked for. All of them need signal.
 */
export function emailSetupCalls(workspaceId: string) {
  return {
    get: async (): Promise<EmailSetupGot> =>
      EmailSetupGetOutput.parse(
        unwrap(await api.POST('/v1/queries/email_setup.get', { body: { workspaceId } })),
      ),
    /**
     * The guided questions' answers as they were left (guided_setup.get_draft). Only a head start: a read that
     * fails starts from the first question.
     */
    draft: async (): Promise<EmailGuidedDraft> => {
      try {
        const got = unwrap(
          await api.POST('/v1/queries/guided_setup.get_draft', {
            body: { workspaceId, setup: 'email' },
          }),
        );
        return { answers: got.answers ?? null, savedAt: got.savedAt ?? null };
      } catch {
        return { answers: null, savedAt: null };
      }
    },
    /** Asks where a website name's mail goes and where it's looked after; `get` has the answer a moment later. */
    lookUp: async (domain: string): Promise<void> => {
      unwrap(await api.POST('/v1/commands/email_setup.look_up', { body: { workspaceId, domain } }));
    },
    /** "Set it up": everything the answers ask for, at once. */
    apply: async (email: EmailGuidedAnswers): Promise<EmailSetupApplied> =>
      EmailSetupApplyOutput.parse(
        unwrap(
          await api.POST('/v1/commands/email_setup.apply', {
            body: {
              workspaceId,
              email: email as unknown as In<'/v1/commands/email_setup.apply'>['email'],
            },
          }),
        ),
      ),
    /** Looks for the website name's mail record now; the answer comes a moment later. */
    receive: async (emailDomainId: string): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/email_domain.receive', {
          body: { workspaceId, emailDomainId },
        }),
      );
    },
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
