import type { paths } from '@hfos/api-client';

import { api, unwrap } from '@/lib/api';

/**
 * Funnels from the phone (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "The phone app"): a customer's funnel
 * and stage, pausing, resuming and removing them, and saying yes or no to the teammate's suggestion. Making and
 * changing funnels is on the web. None of it is in the phone's copy, and none of the changes waits in the queue:
 * each is for where the funnel has them now.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type FunnelOfPersonOut = Ok<'/v1/queries/funnel.of_person'>;

export function funnelCalls(workspaceId: string) {
  return {
    ofPerson: async (personId: string): Promise<FunnelOfPersonOut> =>
      unwrap(await api.POST('/v1/queries/funnel.of_person', { body: { workspaceId, personId } })),
    pause: async (funnelPersonId: string, paused: boolean) =>
      unwrap(
        await api.POST('/v1/commands/funnel.pause_person', {
          body: { workspaceId, funnelPersonId, paused },
        }),
      ),
    remove: async (funnelPersonId: string) =>
      unwrap(
        await api.POST('/v1/commands/funnel.remove_person', {
          body: { workspaceId, funnelPersonId },
        }),
      ),
    decide: async (funnelPersonId: string, accept: boolean) =>
      unwrap(
        await api.POST('/v1/commands/funnel.decide_suggestion', {
          body: { workspaceId, funnelPersonId, accept },
        }),
      ),
  };
}
