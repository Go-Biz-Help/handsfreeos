import type { ApiClient } from '@hfos/api-client';
import { demoResponse } from './respond';
import type { DemoState } from './state';

type Middleware = Parameters<ApiClient['use']>[0];

/**
 * Server Components' side of the demo player: while a scene plays on this business's pages (the cookie is scoped to
 * them), requests for its made-up records get its made-up answers. Everything else goes to the API as it is.
 */
export function demoMiddleware(state: DemoState): Middleware {
  return {
    async onRequest({ request }) {
      const body = request.method === 'POST' ? await request.clone().text() : '';
      const made = await demoResponse(
        state,
        new URL(request.url).pathname,
        body,
        () => fetch(request.clone(), { cache: 'no-store' }),
        request.signal,
      );
      return made ?? request;
    },
  };
}
