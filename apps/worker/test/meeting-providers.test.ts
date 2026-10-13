/**
 * The real Zoom provider against recorded responses: no network, no accounts. What it sends (URLs, auth,
 * bodies) and how it reads what comes back is what's checked.
 */
import { describe, expect, it } from 'vitest';
import { MeetingAuthError, MeetingError } from '../src/meetings/provider';
import { createZoom } from '../src/meetings/zoom';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function zoom(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init.body ? String(init.body) : '',
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, p: createZoom({ clientId: 'zid', clientSecret: 'zsecret', fetch: f }) };
}

describe('Zoom', () => {
  it('signs in with PKCE on Zoom’s own page, sending no scopes (the app sets them)', () => {
    const { p } = zoom(() => json({}));
    const url = new URL(
      p.authorizeUrl({
        state: 's1',
        codeChallenge: 'c1',
        redirectUri: 'https://hooks.example/oauth/zoom/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'zid',
      redirect_uri: 'https://hooks.example/oauth/zoom/callback',
      state: 's1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    });
  });

  it('trades the code with Basic auth and the verifier, and reads the scopes back', async () => {
    const { p, calls } = zoom(() =>
      json({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope: 'meeting:write:meeting user:read:user',
      }),
    );
    const t = await p.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://r' });
    expect(t).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      scopes: ['meeting:write:meeting', 'user:read:user'],
    });
    expect(calls[0]).toMatchObject({ url: 'https://zoom.us/oauth/token', method: 'POST' });
    expect(calls[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from('zid:zsecret').toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://r',
      code_verifier: 'v',
    });
    expect(p.missingScopes(t.scopes)).toEqual([]);
    expect(p.missingScopes(['meeting:write'])).toEqual(['user:read']);
  });

  it('a refused refresh token means reconnect; Zoom’s new refresh token replaces the old one', async () => {
    const refused = zoom(() => json({ error: 'invalid_grant' }, 400));
    await expect(
      refused.p.refresh({ accessToken: 'a', refreshToken: 'r', expiresAt: '', scopes: [] }),
    ).rejects.toBeInstanceOf(MeetingAuthError);
    const ok = zoom(() => json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }));
    expect(
      await ok.p.refresh({ accessToken: 'a', refreshToken: 'r', expiresAt: '', scopes: [] }),
    ).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('reads which account signed in', async () => {
    const { p, calls } = zoom(() =>
      json({ id: 'KDcuGIm1QgePTO8WbOqwIQ', email: 'Dale@Example.com' }),
    );
    expect(await p.account('at')).toEqual({
      email: 'dale@example.com',
      id: 'KDcuGIm1QgePTO8WbOqwIQ',
    });
    expect(calls[0]).toMatchObject({ url: 'https://api.zoom.us/v2/users/me' });
    expect(calls[0]!.headers['authorization']).toBe('Bearer at');
    const nobody = zoom(() => json({}));
    await expect(nobody.p.account('at')).rejects.toBeInstanceOf(MeetingError);
  });

  it('makes a scheduled meeting in UTC with a waiting room, moves it, and treats a gone one as gone', async () => {
    const m = {
      appointmentId: 'a1',
      topic: 'Video consult',
      start: new Date('2026-10-06T15:00:00Z'),
      end: new Date('2026-10-06T15:45:00Z'),
    };
    const made = zoom(() =>
      json({ id: 85746065432, join_url: 'https://zoom.us/j/85746065432?pwd=x' }, 201),
    );
    expect(await made.p.createMeeting('at', m)).toEqual({
      id: '85746065432',
      joinUrl: 'https://zoom.us/j/85746065432?pwd=x',
    });
    expect(made.calls[0]).toMatchObject({
      url: 'https://api.zoom.us/v2/users/me/meetings',
      method: 'POST',
    });
    expect(JSON.parse(made.calls[0]!.body)).toMatchObject({
      topic: 'Video consult',
      type: 2,
      start_time: '2026-10-06T15:00:00Z',
      duration: 45,
      timezone: 'UTC',
      settings: { waiting_room: true },
    });

    const moved = zoom(() => new Response(null, { status: 204 }));
    expect(await moved.p.updateMeeting('at', '857', m)).toBe('updated');
    expect(moved.calls[0]).toMatchObject({
      url: 'https://api.zoom.us/v2/meetings/857',
      method: 'PATCH',
    });

    const gone = zoom(() => json({ code: 3001, message: 'Meeting does not exist' }, 404));
    expect(await gone.p.updateMeeting('at', '857', m)).toBeNull();
    await expect(gone.p.deleteMeeting('at', '857')).resolves.toBeUndefined();
    const down = zoom(() => json({}, 500));
    await expect(down.p.deleteMeeting('at', '857')).rejects.toBeInstanceOf(MeetingError);
  });
});
