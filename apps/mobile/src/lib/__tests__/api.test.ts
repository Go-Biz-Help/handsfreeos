jest.mock('../auth', () => ({ session: { accessToken: async () => 'token-1' } }));

import {
  ASSISTANT_CONSENT_VERSION,
  AssistantConsentInput,
  AssistantThreadRenameInput,
} from '@hfos/core';

import { APP_HEADERS, ApiError, createAppApi, errorMessage, unwrap } from '../api';

/** Captures what the app actually puts on the wire, rather than that a call was made. */
function capturing(): { seen: Request[]; fetch: typeof fetch } {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seen.push(input as Request);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetch: fetchImpl };
}

describe('the API client', () => {
  it('sends the bearer token and says it’s the app, which build', async () => {
    const seen: Request[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      seen.push(input as Request);
      return new Response(JSON.stringify({ user: {}, organizations: [], workspaces: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const api = createAppApi(async () => 'token-1', fakeFetch);
    await api.POST('/v1/queries/account.me', { body: {} });
    const headers = seen[0]!.headers;
    expect(headers.get('authorization')).toBe('Bearer token-1');
    expect(headers.get(APP_HEADERS.client)).toBe('mobile');
    expect(headers.get(APP_HEADERS.appVersion)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * The Assistant was unreachable on both phones for a release because `assistant.consent` — the one command the
   * consent step sends, and the door to every Assistant screen — went out without the app's command id and moment.
   * The API refuses that before the handler (`assertAppRequest`, packages/core/src/kernel/app-request.ts), so the
   * OK could never be given. Every test around it mocked the client and so saw a call, not a request; this one
   * reads the request the app really built, and checks both halves the API checks: the headers a command from the
   * app must carry, and a body its own schema accepts.
   */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it.each([
    [
      '/v1/commands/assistant.consent' as const,
      { version: ASSISTANT_CONSENT_VERSION },
      AssistantConsentInput,
    ],
    [
      '/v1/commands/assistant_thread.rename' as const,
      {
        workspaceId: '11111111-1111-4111-8111-111111111111',
        threadId: '22222222-2222-4222-8222-222222222222',
        title: 'Thursday',
      },
      AssistantThreadRenameInput,
    ],
  ])(
    'sends %s saying which command it is, when, and a body its schema takes',
    async (path, body, schema) => {
      const { seen, fetch: fetchImpl } = capturing();
      const api = createAppApi(async () => 'token-1', fetchImpl);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one call, two paths, two body shapes
      await (api.POST as any)(path, { body });

      const request = seen[0]!;
      expect(request.headers.get(APP_HEADERS.commandId)).toMatch(UUID);
      const occurredAt = request.headers.get(APP_HEADERS.occurredAt);
      const sentAt = request.headers.get(APP_HEADERS.sentAt);
      expect(occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(Number.isNaN(Date.parse(occurredAt!))).toBe(false);
      expect(Number.isNaN(Date.parse(sentAt!))).toBe(false);
      // What the API parses, parsed by the API's own schema: a body that would be refused fails here instead.
      expect(schema.safeParse(JSON.parse(await request.text())).success).toBe(true);
    },
  );

  it('leaves a query alone: only commands carry a command id', async () => {
    const { seen, fetch: fetchImpl } = capturing();
    const api = createAppApi(async () => 'token-1', fetchImpl);
    await api.POST('/v1/queries/account.me', { body: {} });
    expect(seen[0]!.headers.get(APP_HEADERS.commandId)).toBeNull();
    expect(seen[0]!.headers.get(APP_HEADERS.occurredAt)).toBeNull();
  });

  it('uses the API’s own words, and says when there’s no signal or the app is too old', () => {
    const refused = () =>
      unwrap({
        error: {
          error: { code: 'forbidden', message: 'You can’t see that.', disposition: 'final' },
        },
        response: new Response(null, { status: 403 }),
      });
    expect(refused).toThrow(ApiError);
    try {
      refused();
    } catch (error) {
      expect(errorMessage(error)).toBe('You can’t see that.');
      expect((error as ApiError).disposition).toBe('final');
    }
    expect(errorMessage(new ApiError('Please update', 426, 'upgrade_required', 'final'))).toMatch(
      /too old/,
    );
    expect(errorMessage(new TypeError('Network request failed'))).toBe(
      'No signal. Try again when you’re back online.',
    );
  });

  it('keeps the rule and what a refusal carries, for a screen that can answer it', () => {
    let caught: unknown = null;
    try {
      unwrap({
        error: {
          error: {
            code: 'rule_violation',
            message: 'Rent Collection needs Property Management. Turn it on too?',
            rule: 'addon_needs',
            details: { addons: ['fxprop'] },
            disposition: 'ask',
          },
        },
        response: new Response(null, { status: 409 }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 409,
      rule: 'addon_needs',
      details: { addons: ['fxprop'] },
      disposition: 'ask',
    });
    // A refusal with no rule says so, rather than leaving it undefined.
    expect(new ApiError('No.', 403, 'forbidden', 'final').rule).toBeNull();
  });
});
