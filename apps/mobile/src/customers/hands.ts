import type { paths } from '@hfos/api-client';

import { api, unwrap } from '@/lib/api';

/**
 * In your hands from the phone (core's messaging/hands.ts): whether someone on the team has a customer, the list of
 * everyone who's in someone's hands, Take over, and Give back to the AI. None of it is in the phone's copy, and none of
 * the changes waits in the queue: each is for who has them now, so they go with signal.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type InHandsOut = Ok<'/v1/queries/person.in_hands'>;
export type InHandsPerson = InHandsOut['people'][number];

export function handsCalls(workspaceId: string) {
  return {
    /** One customer (none or one row), or the list, newest first; `mine` for only the person's own. */
    list: async (
      opts: { personId?: string; mine?: boolean; limit?: number } = {},
    ): Promise<InHandsOut> =>
      unwrap(
        await api.POST('/v1/queries/person.in_hands', {
          body: {
            workspaceId,
            ...(opts.personId ? { personId: opts.personId } : {}),
            mine: opts.mine ?? false,
            limit: opts.limit ?? 100,
          },
        }),
      ),
    takeOver: async (personId: string) =>
      unwrap(await api.POST('/v1/commands/person.take_over', { body: { workspaceId, personId } })),
    giveBack: async (which: { personIds: string[] } | { all: true; mine: boolean }) =>
      unwrap(
        await api.POST('/v1/commands/person.hand_back', {
          body:
            'all' in which
              ? { workspaceId, personIds: [], all: true, mine: which.mine }
              : { workspaceId, personIds: which.personIds, all: false, mine: false },
        }),
      ),
  };
}
