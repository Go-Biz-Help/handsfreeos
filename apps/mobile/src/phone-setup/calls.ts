import type { PhoneSetupSaveBody } from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { NotInThisBuild } from '@/lib/not-in-this-build';
import { workerPost } from '@/lib/worker';
import type { AvailableNumber, NumberType } from '@/onboarding-setup/calls';

export { NotInThisBuild };
export type { AvailableNumber, NumberType };

/** The answers as they were left, and when. */
export interface PhoneGuidedDraft {
  readonly answers: Record<string, unknown> | null;
  readonly savedAt: string | null;
}

/**
 * The guided phone number setup's calls from the phone (the owner, 22 Nov 2026), as the web's page makes them: where
 * the business's number stands (phone.setup_status), the answers as they were left, the numbers free at the carrier
 * (the worker's search), whether one picked earlier is still free, and Get my number (phone_setup.save), which buys
 * it and sets everything at once. All of them need signal.
 */
export function phoneSetupCalls(workspaceId: string) {
  const searchNumbers = async (input: {
    numberType: NumberType;
    areaCode?: string;
    contains?: string;
    city?: string;
    state?: string;
    withinMiles?: number;
  }): Promise<readonly AvailableNumber[]> => {
    if (!config.workerUrl) throw new NotInThisBuild();
    const { numbers } = await workerPost<{ numbers: AvailableNumber[] }>(
      '/v1/telephony/available-numbers',
      { workspaceId, ...input },
    );
    return numbers;
  };
  return {
    status: async () =>
      unwrap(await api.POST('/v1/queries/phone.setup_status', { body: { workspaceId } })),
    /**
     * The answers as they were left (guided_setup.get_draft). Only a head start: a read that fails starts from the
     * first question.
     */
    draft: async (): Promise<PhoneGuidedDraft> => {
      try {
        const got = unwrap(
          await api.POST('/v1/queries/guided_setup.get_draft', {
            body: { workspaceId, setup: 'phone' },
          }),
        );
        return { answers: got.answers ?? null, savedAt: got.savedAt ?? null };
      } catch {
        return { answers: null, savedAt: null };
      }
    },
    /** Numbers the carrier has free right now. A city needs its state; `withinMiles` widens it. */
    searchNumbers,
    /**
     * Whether one number is still free: asked when someone comes back to a number they picked earlier, and again
     * just before buying it. Null when the carrier couldn't be asked: buying it is then what tells.
     */
    stillFree: async (e164: string, numberType: NumberType): Promise<boolean | null> => {
      const national = e164.replace(/^\+1/, '');
      if (!/^[0-9]{10}$/.test(national)) return null;
      try {
        const found = await searchNumbers({ numberType, contains: national });
        return found.some((n) => n.e164 === e164);
      } catch {
        return null;
      }
    },
    /** Get my number, or Save my answers: buys the number picked and sets it up the way they said. */
    save: async (body: PhoneSetupSaveBody): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/phone_setup.save', {
          body: { workspaceId, ...body },
        }),
      );
    },
  };
}

export type PhoneSetupCalls = ReturnType<typeof phoneSetupCalls>;
export type PhoneSetupStatus = Awaited<ReturnType<PhoneSetupCalls['status']>>;
export type PhoneNumberInfo = NonNullable<PhoneSetupStatus['number']>;
