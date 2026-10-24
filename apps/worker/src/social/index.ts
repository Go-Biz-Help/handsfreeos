/**
 * Facebook Messenger and Instagram direct messages (20261025000200): the Meta app the worker talks through, or the
 * stand-in locally and in tests.
 *
 * One Meta app does both, and it's the same app Facebook reviews sign in with (FACEBOOK_APP_ID, FACEBOOK_APP_SECRET):
 * its secret signs the webhooks, and its verify token is what Meta's webhook setup checks this server with.
 */
import type { WorkerEnv } from '../env';
import { createSafeFetch } from '../http/safe-fetch';
import { createFakeMeta, type FakeMeta } from './fake';
import { createMetaGraph, type MetaGraph } from './graph';

export interface MetaServices {
  readonly graph: MetaGraph;
  /** Locally and in tests: the stand-in's people, Pages and sent replies. Null with the real Meta. */
  readonly fake: FakeMeta | null;
  /** What signs Meta's webhooks and its deauthorize and data deletion callbacks: the app's secret. */
  readonly appSecret: string | null;
  /** What Meta's webhook setup checks this server with (META_WEBHOOK_VERIFY_TOKEN). */
  readonly verifyToken: string | null;
  /** Meta approved the Human Agent permission for the app: a person may answer for seven days, not one. */
  readonly humanAgent: boolean;
}

export function fakeMetaServices(
  publicUrl: string,
  opts: { humanAgent?: boolean } = {},
): MetaServices & { readonly fake: FakeMeta } {
  const fake = createFakeMeta({ publicUrl });
  return {
    graph: fake.graph,
    fake,
    appSecret: fake.appSecret,
    verifyToken: fake.verifyToken,
    humanAgent: opts.humanAgent ?? true,
  };
}

export function createMeta(env: WorkerEnv): MetaServices {
  if (env.metaProvider === 'fake') return fakeMetaServices(env.publicUrl);
  return {
    graph: createMetaGraph({
      appId: env.facebookAppId,
      appSecret: env.facebookAppSecret,
      version: env.metaGraphVersion,
      loginConfigId: env.metaLoginConfigId,
      leadAds: env.metaLeadAds,
      // Files people send come from Meta's own addresses; fetched like any address from outside, all the same.
      fetchUrl: createSafeFetch(),
    }),
    fake: null,
    appSecret: env.facebookAppSecret,
    verifyToken: env.metaVerifyToken,
    humanAgent: env.metaHumanAgent,
  };
}
