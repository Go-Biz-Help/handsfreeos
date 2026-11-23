import type { ConnectableProvider, MoneySettings } from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { NotInThisBuild } from '@/lib/not-in-this-build';

export { NotInThisBuild };

/** The answers as they were left, and when. */
export interface PaymentsGuidedDraft {
  readonly answers: Record<string, unknown> | null;
  readonly savedAt: string | null;
}

/**
 * The guided payments setup's calls from the phone (the owner, 23 Nov 2026), as the web's page makes them: the
 * business (its kind and the address its setup asked for), the money settings with their next numbers, the accounts
 * money goes into, the answers as they were left, Save (money.save_settings, the whole settings), and the Stripe or
 * Square sign-in through the worker. All of them need signal.
 */
export function paymentsSetupCalls(workspaceId: string) {
  const body = { body: { workspaceId } };
  return {
    business: async () => {
      const { workspace } = unwrap(await api.POST('/v1/queries/workspace.get', body));
      return {
        industry: workspace.industry,
        settings: (workspace.settings ?? {}) as Record<string, unknown>,
      };
    },
    money: async () => unwrap(await api.POST('/v1/queries/money.settings', body)),
    connections: async () =>
      unwrap(await api.POST('/v1/queries/payment_connection.list', body)).connections,
    /**
     * The answers as they were left (guided_setup.get_draft). Only a head start: a read that fails starts from the
     * first question.
     */
    draft: async (): Promise<PaymentsGuidedDraft> => {
      try {
        const got = unwrap(
          await api.POST('/v1/queries/guided_setup.get_draft', {
            body: { workspaceId, setup: 'payments' },
          }),
        );
        return { answers: got.answers ?? null, savedAt: got.savedAt ?? null };
      } catch {
        return { answers: null, savedAt: null };
      }
    },
    save: async (settings: MoneySettings) =>
      unwrap(
        await api.POST('/v1/commands/money.save_settings', { body: { workspaceId, settings } }),
      ),
    /** Where Stripe's or Square's own sign-in starts, through the worker, which keeps what it gives back. */
    signIn: async (provider: ConnectableProvider): Promise<string> => {
      if (!config.workerUrl) throw new NotInThisBuild();
      const { state } = unwrap(
        await api.POST('/v1/commands/payment_connection.connect', {
          body: { workspaceId, provider },
        }),
      );
      return `${config.workerUrl}/oauth/${provider}/start?state=${encodeURIComponent(state)}`;
    },
  };
}

export type PaymentsSetupCalls = ReturnType<typeof paymentsSetupCalls>;
export type PaymentConnections = Awaited<ReturnType<PaymentsSetupCalls['connections']>>;
export type MoneySettingsNow = Awaited<ReturnType<PaymentsSetupCalls['money']>>;
