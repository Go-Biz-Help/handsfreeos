import { sendCommand } from '../send';

/** One command to the API, as the app: the body as saved, and the app's headers read off the phone's own clock. */

const request = {
  name: 'message.send',
  commandId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
  input: '{"workspaceId":"w","personId":"p","body":"Hi"}',
  madeAt: '2026-09-16T15:12:00.000Z',
  confirmedAt: '2026-09-16T15:57:00.000Z',
};

function deps(fetchImpl: typeof fetch, token: string | null = 'token-1') {
  return {
    apiUrl: 'http://api.test',
    fetch: fetchImpl,
    token: async () => token,
    appVersion: () => '1.0.0',
    now: () => Date.parse('2026-09-16T15:58:30.000Z'),
    timeoutMs: 50,
  };
}

describe('sending one command', () => {
  it('posts the body as saved, with the app’s headers', async () => {
    const calls: [string, RequestInit][] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('{"messageId":"m"}', { status: 200 });
    }) as unknown as typeof fetch;
    const answer = await sendCommand(deps(fake), request);
    expect(answer).toEqual({ reached: true, status: 200, body: { messageId: 'm' } });
    const [url, init] = calls[0]!;
    expect(url).toBe('http://api.test/v1/commands/message.send');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(request.input);
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer token-1',
      'x-hfos-client': 'mobile',
      'x-hfos-app-version': '1.0.0',
      'x-hfos-command-id': request.commandId,
      'x-hfos-occurred-at': request.madeAt,
      'x-hfos-sent-at': '2026-09-16T15:58:30.000Z',
      'x-hfos-confirmed-at': request.confirmedAt,
    });
  });

  it('leaves out confirmed-at until the person said yes, and keeps a refusal’s body', async () => {
    let headers: Record<string, string> = {};
    const fake = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response('{"error":{"message":"No","disposition":"final"}}', { status: 409 });
    }) as unknown as typeof fetch;
    const answer = await sendCommand(deps(fake), { ...request, confirmedAt: null });
    expect(headers).not.toHaveProperty('x-hfos-confirmed-at');
    expect(answer).toEqual({
      reached: true,
      status: 409,
      body: { error: { message: 'No', disposition: 'final' } },
    });
  });

  it('reports no answer for no signal, a timeout, or no sign-in to send with', async () => {
    const offline = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await sendCommand(deps(offline), request)).toEqual({
      reached: false,
      message: 'Network request failed',
    });
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    expect(await sendCommand(deps(hangs), request)).toEqual({
      reached: false,
      message: 'HandsFreeOS took too long to answer.',
    });
    const never = jest.fn() as unknown as typeof fetch;
    expect(await sendCommand(deps(never, null), request)).toMatchObject({ reached: false });
    expect(never).not.toHaveBeenCalled();
  });
});
