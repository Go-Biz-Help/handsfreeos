import type { paths } from '@hfos/api-client';
import {
  OnboardingSetupFinishOutput,
  OnboardingSetupGetOutput,
  OnboardingSetupSaveOutput,
  type IndustryId,
  type onboardingSetupBusinessOf,
  type OnboardingSetupAnswers,
  type OnboardingSetupScreen,
} from '@hfos/core';

import { aiSetupCalls } from '@/ai-setup/calls';
import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { workerPost } from '@/lib/worker';

/**
 * The onboarding setup's calls from the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8), as the
 * web's lib/onboarding-setup/actions.ts makes them: where it stands, keeping the answers as each screen is finished
 * (with what can't wait), and "Stay in the loop", which saves the rest. Beside them, what a stop does in place: a
 * business number found near the address and bought, and the payment provider's sign-in. All of them need signal:
 * none goes into the queue of changes, because each answer depends on what the server says next.
 */

/** What a command takes, from the API's own description of it. */
type In<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

export type OnboardingSetupGot = ReturnType<typeof OnboardingSetupGetOutput.parse>;
export type OnboardingSetupSaved = ReturnType<typeof OnboardingSetupSaveOutput.parse>;
export type OnboardingSetupFinished = ReturnType<typeof OnboardingSetupFinishOutput.parse>;

/** The first screen's answers, as `onboarding_setup.save` takes them. */
export type OnboardingSetupBusiness = ReturnType<typeof onboardingSetupBusinessOf>;

/** A number the carrier has free right now, as the worker lists them. */
export interface AvailableNumber {
  readonly e164: string;
  /** "(512) 555-0148". */
  readonly display: string;
  readonly locality: string | null;
  readonly region: string | null;
}

export type NumberType = 'local' | 'toll_free';

/**
 * Makes the business straight after signing up (`organization.create`), with the first screen's name, kind and time
 * zone; the rest of that screen is then saved to it (`onboarding_setup.save`). Someone who runs an agency names it.
 */
export async function createBusiness(input: {
  business: OnboardingSetupBusiness;
  agencyName?: string | null;
}): Promise<string> {
  const agency = input.agencyName?.trim();
  return unwrap(
    await api.POST('/v1/commands/organization.create', {
      body: {
        businessName: input.business.name,
        ...(agency ? { organizationName: agency } : {}),
        timezone: input.business.timezone,
        industry: input.business.industry as IndustryId,
      },
    }),
  ).workspaceId;
}

export function onboardingSetupCalls(workspaceId: string) {
  const ai = aiSetupCalls(workspaceId);
  return {
    /** Read through core's schema, so every default is filled in and core's functions take it as it is. */
    get: async (): Promise<OnboardingSetupGot> =>
      OnboardingSetupGetOutput.parse(
        unwrap(await api.POST('/v1/queries/onboarding_setup.get', { body: { workspaceId } })),
      ),
    save: async (input: {
      screen: OnboardingSetupScreen;
      answers: OnboardingSetupAnswers;
      /** The first screen's answers, saved to the business straight away. */
      business?: OnboardingSetupBusiness;
      /** "Invite them now", on the goal. */
      invite?: readonly string[];
      /** Start from: saved answers picked on the first screen, or null for our picks. */
      templateId?: string | null;
    }): Promise<OnboardingSetupSaved> =>
      OnboardingSetupSaveOutput.parse(
        unwrap(
          await api.POST('/v1/commands/onboarding_setup.save', {
            body: {
              workspaceId,
              screen: input.screen,
              answers:
                input.answers as unknown as In<'/v1/commands/onboarding_setup.save'>['answers'],
              ...(input.business
                ? {
                    business:
                      input.business as In<'/v1/commands/onboarding_setup.save'>['business'],
                  }
                : {}),
              ...(input.invite?.length ? { invite: [...input.invite] } : {}),
              ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
            },
          }),
        ),
      ),
    finish: async (input: {
      answers: OnboardingSetupAnswers;
      baseRevision: number | null;
      /** The simple page's address (`publicOrigin`), for its chat when the business has no website. */
      pageOrigin?: string;
      /** An agency handing the business over: the owner's email, or null to invite them later. */
      owner?: { email: string | null };
    }): Promise<OnboardingSetupFinished> =>
      OnboardingSetupFinishOutput.parse(
        unwrap(
          await api.POST('/v1/commands/onboarding_setup.finish', {
            body: {
              workspaceId,
              answers:
                input.answers as unknown as In<'/v1/commands/onboarding_setup.finish'>['answers'],
              baseRevision: input.baseRevision,
              ...(input.pageOrigin ? { pageOrigin: input.pageOrigin } : {}),
              ...(input.owner ? { owner: input.owner } : {}),
            },
          }),
        ),
      ),
    /** The AI quick setup's own calls: what the website scan found, and the test chat's. */
    ai,
    /** Where customers' pages open: the business's own domain once it's serving, else HandsFreeOS's address. */
    publicOrigin: (): Promise<string> => ai.chatOrigin(),
    /**
     * Numbers the carrier has free right now (owners and admins; the worker checks). A city needs its state, and
     * only local numbers have one; `withinMiles` widens the city to everything that near it.
     */
    searchNumbers: async (input: {
      numberType: NumberType;
      areaCode?: string;
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
    },
    /** Buys the number picked: calls ring as soon as the carrier has it. */
    buyNumber: async (e164: string, numberType: NumberType): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/phone_number.buy', {
          body: { workspaceId, e164, numberType },
        }),
      );
    },
    /** Where Stripe's or Square's own sign-in starts, through the worker, which keeps what it gives back. */
    paymentsSignIn: async (provider: 'stripe' | 'square'): Promise<string> => {
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

export type OnboardingSetupCalls = ReturnType<typeof onboardingSetupCalls>;

/** This build doesn't know where the worker is (`EXPO_PUBLIC_WORKER_URL`): the web does that part. */
export class NotInThisBuild extends Error {
  constructor() {
    super('This part of setup isn’t in this build of the app.');
  }
}
