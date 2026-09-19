/** Where public reviews are read from: the real providers, or the stand-in locally and in tests. */
import type { WorkerEnv } from '../env';
import { createFacebookReviews } from './facebook';
import { createFakeReviews, type FakeReviews } from './fake';
import { createGoogleReviews } from './google';
import type { ReviewProvider, ReviewProviderName } from './provider';

export interface ReviewServices {
  readonly providers: Readonly<Record<ReviewProviderName, ReviewProvider>>;
  /** Local and tests: reviews in memory, and a sign-in page on the worker. Null with the real providers. */
  readonly fake: FakeReviews | null;
  /** How often a connected place is asked for new reviews. */
  readonly pollMs: number;
}

export function fakeReviewServices(
  publicUrl: string,
  pollMs: number,
): ReviewServices & { readonly fake: FakeReviews } {
  const fake = createFakeReviews({ publicUrl });
  return { providers: fake.providers, fake, pollMs };
}

export function createReviews(env: WorkerEnv): ReviewServices {
  if (env.reviewProvider === 'fake') return fakeReviewServices(env.publicUrl, env.reviewPollMs);
  return {
    providers: {
      google: createGoogleReviews({
        clientId: env.googleReviewClientId,
        clientSecret: env.googleReviewClientSecret,
      }),
      facebook: createFacebookReviews({
        appId: env.facebookAppId,
        appSecret: env.facebookAppSecret,
      }),
    },
    fake: null,
    pollMs: env.reviewPollMs,
  };
}
