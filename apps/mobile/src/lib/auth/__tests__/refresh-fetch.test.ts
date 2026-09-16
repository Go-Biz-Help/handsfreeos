import { isRealRefusal, isRefreshRequest, withRefreshGuard } from '../refresh-fetch';

describe('which answers to a refresh are a refusal', () => {
  it('finds the refresh request', () => {
    expect(isRefreshRequest('https://x.supabase.co/auth/v1/token?grant_type=refresh_token')).toBe(
      true,
    );
    expect(
      isRefreshRequest('http://10.0.2.2:54421/auth/v1/token?foo=1&grant_type=refresh_token'),
    ).toBe(true);
    expect(isRefreshRequest('https://x.supabase.co/auth/v1/token?grant_type=password')).toBe(false);
    expect(isRefreshRequest('https://x.supabase.co/auth/v1/otp')).toBe(false);
  });

  it('counts Supabase Auth saying no', () => {
    expect(isRealRefusal(400, { code: 'refresh_token_not_found', message: 'x' })).toBe(true);
    expect(
      isRealRefusal(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'x' }),
    ).toBe(true);
    expect(isRealRefusal(403, { code: 'user_banned' })).toBe(true);
    expect(isRealRefusal(401, { error: 'invalid_grant', error_description: 'x' })).toBe(true);
  });

  it('never counts signal problems, limits, pages that aren’t Supabase Auth, or server errors', () => {
    expect(isRealRefusal(429, { code: 'over_request_rate_limit' })).toBe(false);
    expect(isRealRefusal(408, { code: 'request_timeout' })).toBe(false);
    expect(isRealRefusal(400, { code: 'hook_timeout' })).toBe(false);
    expect(isRealRefusal(403, null)).toBe(false);
    expect(isRealRefusal(404, { message: 'Not found' })).toBe(false);
    expect(isRealRefusal(511, { code: 'x' })).toBe(false);
    expect(isRealRefusal(502, { code: 'x' })).toBe(false);
    expect(isRealRefusal(200, { code: 'x' })).toBe(false);
  });
});

describe('the guard', () => {
  const url = 'http://auth.test/auth/v1/token?grant_type=refresh_token';
  const respond = (response: Response) =>
    withRefreshGuard((async () => response) as unknown as typeof fetch);

  it('turns a login page into "unreachable"', async () => {
    const res = await respond(new Response('<html>Wi-Fi</html>', { status: 511 }))(url);
    expect(res.status).toBe(503);
  });

  it('passes a refusal through', async () => {
    const body = JSON.stringify({ code: 'refresh_token_not_found', message: 'gone' });
    const res = await respond(new Response(body, { status: 400 }))(url);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'refresh_token_not_found' });
  });

  it('leaves other requests alone', async () => {
    const res = await respond(new Response('{"code":"invalid_credentials"}', { status: 400 }))(
      'http://auth.test/auth/v1/token?grant_type=password',
    );
    expect(res.status).toBe(400);
  });

  it('lets a failed request fail as no signal', async () => {
    const guarded = withRefreshGuard((() =>
      Promise.reject(new TypeError('Network request failed'))) as typeof fetch);
    await expect(guarded(url)).rejects.toThrow('Network request failed');
  });
});
