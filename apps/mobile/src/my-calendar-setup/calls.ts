import type {
  MyCalendarProvider,
  MyCalendarSetupAnswers,
  MyCalendarSetupContext,
} from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { NotInThisBuild } from '@/lib/not-in-this-build';

export { NotInThisBuild };

/** The answers as they were left, and when. */
export interface MyCalendarGuidedDraft {
  readonly answers: Record<string, unknown> | null;
  readonly savedAt: string | null;
}

/**
 * The guided My calendar setup's calls from the phone (the owner, 24 Nov 2026, M4 a), as the web's page makes them:
 * your calendar as the setup reads it (my_calendar_setup.get), your answers as you left them, Check it over's save
 * (my_calendar_setup.save), and Google's, Microsoft's and Zoom's sign-ins through the worker. All of them need signal.
 */
export function myCalendarSetupCalls(workspaceId: string) {
  return {
    load: async (): Promise<MyCalendarSetupContext> =>
      unwrap(await api.POST('/v1/queries/my_calendar_setup.get', { body: { workspaceId } })),
    /**
     * The answers as they were left (guided_setup.get_draft, your own). Only a head start: a read that fails starts
     * from the first question.
     */
    draft: async (): Promise<MyCalendarGuidedDraft> => {
      try {
        const got = unwrap(
          await api.POST('/v1/queries/guided_setup.get_draft', {
            body: { workspaceId, setup: 'my_calendar' },
          }),
        );
        return { answers: got.answers ?? null, savedAt: got.savedAt ?? null };
      } catch {
        return { answers: null, savedAt: null };
      }
    },
    save: async (answers: MyCalendarSetupAnswers) =>
      unwrap(
        await api.POST('/v1/commands/my_calendar_setup.save', { body: { workspaceId, answers } }),
      ),
    /** Where Google's or Microsoft's own sign-in starts, through the worker, which keeps what it gives back. */
    signIn: async (provider: MyCalendarProvider): Promise<string> => {
      if (!config.workerUrl) throw new NotInThisBuild();
      const { state } = unwrap(
        await api.POST('/v1/commands/calendar_connection.connect', {
          body: { workspaceId, provider, meetTranscripts: false },
        }),
      );
      return `${config.workerUrl}/oauth/${provider}/start?state=${encodeURIComponent(state)}`;
    },
    /** Where Zoom's own sign-in starts. */
    zoomSignIn: async (): Promise<string> => {
      if (!config.workerUrl) throw new NotInThisBuild();
      const { state } = unwrap(
        await api.POST('/v1/commands/meeting_connection.connect', {
          body: { workspaceId, provider: 'zoom' },
        }),
      );
      return `${config.workerUrl}/oauth/zoom/start?state=${encodeURIComponent(state)}`;
    },
  };
}

export type MyCalendarSetupCalls = ReturnType<typeof myCalendarSetupCalls>;
