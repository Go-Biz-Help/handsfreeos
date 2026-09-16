import type { SupabaseClient } from '@supabase/supabase-js';

import { signInWithPasskey, type PlatformPasskeys } from '../passkey';

function client(
  verify: { data: unknown; error: unknown } = { data: { session: {} }, error: null },
) {
  const passkey = {
    startAuthentication: jest.fn(async () => ({
      data: { challenge_id: 'challenge-1', options: { challenge: 'abc' }, expires_at: 0 },
      error: null,
    })),
    verifyAuthentication: jest.fn(async () => verify),
  };
  return { auth: { passkey } } as unknown as SupabaseClient & { auth: { passkey: typeof passkey } };
}

describe('signing in with a passkey', () => {
  it('asks Supabase for a challenge, has the phone sign it, and sends it back', async () => {
    const c = client();
    const phone: PlatformPasskeys = { get: jest.fn(async () => ({ id: 'credential-1' })) };
    await expect(signInWithPasskey(c, phone)).resolves.toEqual({ outcome: 'signedIn' });
    expect(phone.get).toHaveBeenCalledWith({ challenge: 'abc' });
    expect(c.auth.passkey.verifyAuthentication).toHaveBeenCalledWith({
      challengeId: 'challenge-1',
      credential: { id: 'credential-1' },
    });
  });

  it('treats closing the phone’s sheet as a cancel, not an error', async () => {
    const phone: PlatformPasskeys = {
      get: async () => {
        throw new Error('The operation was cancelled by the user');
      },
    };
    await expect(signInWithPasskey(client(), phone)).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('says so when the passkey isn’t accepted, or the phone has no passkey module', async () => {
    const phone: PlatformPasskeys = { get: async () => ({}) };
    const refused = client({ data: null, error: new Error('invalid') });
    await expect(signInWithPasskey(refused, phone)).resolves.toMatchObject({ outcome: 'failed' });
    await expect(signInWithPasskey(client(), null)).resolves.toMatchObject({ outcome: 'failed' });
  });
});
