import { forgetSignInProviders, loadSignInProviders } from '../providers';
import { AUTH_RETURN, nameFromApple, readAuthReturn } from '../oauth';
import { targetOfLink } from '@/links/route-map';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('expo-apple-authentication', () => ({ signInAsync: jest.fn() }));

describe('coming back from Continue with Google', () => {
  it('comes back to the app’s own address, which opens no screen', () => {
    expect(AUTH_RETURN).toBe('handsfreeos://auth/callback');
    expect(targetOfLink(`${AUTH_RETURN}?code=abc`, ['https://app.handsfreeos.com']).kind).toBe(
      'none',
    );
  });

  it('reads the one-time code', () => {
    expect(readAuthReturn(`${AUTH_RETURN}?code=4f1c-77aa`)).toEqual({ code: '4f1c-77aa' });
  });

  it('reads why it didn’t sign in, wherever Supabase put it', () => {
    expect(
      readAuthReturn(
        `${AUTH_RETURN}?error=access_denied&error_code=user_banned&error_description=User+is+banned`,
      ),
    ).toEqual({ refused: 'user_banned' });
    expect(
      readAuthReturn(`${AUTH_RETURN}#error=server_error&error_description=User%20is%20banned`),
    ).toEqual({ refused: 'user_banned' });
    expect(readAuthReturn(`${AUTH_RETURN}?error=access_denied`)).toEqual({
      refused: 'access_denied',
    });
    expect(readAuthReturn(AUTH_RETURN)).toEqual({ refused: null });
  });
});

describe('the name Apple shares', () => {
  it('joins the parts it gave', () => {
    expect(
      nameFromApple({
        givenName: 'Chris',
        familyName: 'Martinez',
        middleName: null,
        namePrefix: null,
        nameSuffix: null,
        nickname: null,
      }),
    ).toBe('Chris Martinez');
    expect(
      nameFromApple({
        givenName: ' Chris ',
        familyName: null,
        middleName: null,
        namePrefix: null,
        nameSuffix: null,
        nickname: null,
      }),
    ).toBe('Chris');
    expect(nameFromApple(null)).toBe('');
  });
});

describe('which buttons show', () => {
  beforeEach(() => forgetSignInProviders());

  const settings = (external: Record<string, boolean>) =>
    ({ ok: true, json: async () => ({ external }) }) as unknown as Response;

  it('asks Supabase Auth once while the app runs', async () => {
    const fetchImpl = jest.fn(async () => settings({ google: true, apple: true }));
    // The tests run as an iPhone (jest-expo's default platform).
    await expect(loadSignInProviders(fetchImpl)).resolves.toEqual({ google: true, apple: true });
    await loadSignInProviders(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('http://supabase.test/auth/v1/settings', {
      headers: { apikey: 'sb_publishable_test' },
    });
  });

  it('shows none without a signal, and asks again next time', async () => {
    const offline = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(loadSignInProviders(offline)).resolves.toEqual({ google: false, apple: false });
    const online = jest.fn(async () => settings({ google: true, apple: false }));
    // An iPhone shows Google only beside Apple.
    await expect(loadSignInProviders(online)).resolves.toEqual({ google: false, apple: false });
    expect(online).toHaveBeenCalledTimes(1);
  });
});
