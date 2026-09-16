jest.mock('../auth', () => ({ session: { accessToken: async () => 'token-1' } }));

import { APP_HEADERS, ApiError, createAppApi, errorMessage, unwrap } from '../api';

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
});
