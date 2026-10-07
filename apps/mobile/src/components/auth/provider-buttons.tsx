import * as AppleAuthentication from 'expo-apple-authentication';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '@/lib/api';
import { session } from '@/lib/auth';
import { continueWithApple, continueWithGoogle, type ProviderOutcome } from '@/lib/auth/oauth';
import { useSignInProviders } from '@/lib/auth/providers';
import { supabase } from '@/lib/supabase';
import { useThemeName } from '@/theme';

/** Google's mark, in its own colours as Google asks, drawn as the web draws it. */
function GoogleG() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48" accessible={false}>
      <Path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"
      />
      <Path
        fill="#FBBC05"
        d="M10.4 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.7-4.1-13.6-9.9l-7.8 6C6.5 42.6 14.6 48 24 48z"
      />
    </Svg>
  );
}

/**
 * The name Apple shares the first time, kept on the sign-in and on the person's profile, which the businesses they
 * join show. Supabase can't keep it itself: Apple's signed answer carries no name. Best effort: without it the name
 * stays empty until they type it in Settings.
 */
async function keepName(name: string): Promise<void> {
  try {
    await supabase.auth.updateUser({ data: { full_name: name } });
    await api.POST('/v1/commands/user.update_profile', { body: { fullName: name } });
  } catch {
    // Settings → Account still has the name to type.
  }
}

/**
 * Continue with Apple (iPhones) and Continue with Google, above the email on the sign-in and sign-up screens, once
 * each is turned on in Supabase; nothing when neither is. On an iPhone, Google shows only beside Apple. Signing in
 * either way also makes the account the first time.
 */
export function ProviderButtons({ onError }: { onError: (message: string | null) => void }) {
  const providers = useSignInProviders();
  const theme = useThemeName();
  const [appleHere, setAppleHere] = React.useState(false);
  const [busy, setBusy] = React.useState<'google' | 'apple' | null>(null);

  React.useEffect(() => {
    if (Platform.OS !== 'ios' || !providers.apple) return;
    let live = true;
    AppleAuthentication.isAvailableAsync()
      .then((here) => live && setAppleHere(here))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [providers.apple]);

  const apple = providers.apple && appleHere;
  const google = providers.google && (Platform.OS !== 'ios' || apple);
  if (!apple && !google) return null;

  const go = async (which: 'google' | 'apple') => {
    onError(null);
    setBusy(which);
    const result: ProviderOutcome =
      which === 'google' ? await continueWithGoogle(supabase) : await continueWithApple(supabase);
    if (result.outcome !== 'signedIn') {
      setBusy(null);
      if (result.outcome === 'failed') onError(result.message);
      return;
    }
    await session.refreshFromStorage();
    if (result.name) void keepName(result.name);
  };

  return (
    <View className="gap-2.5" testID="provider-buttons">
      {apple ? (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={
            theme === 'dark'
              ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
              : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={10}
          style={{ height: 48, opacity: busy ? 0.5 : 1 }}
          onPress={() => {
            if (!busy) void go('apple');
          }}
          testID="apple-sign-in"
        />
      ) : null}
      {google ? (
        <Button
          variant="secondary"
          loading={busy === 'google'}
          disabled={busy === 'apple'}
          onPress={() => void go('google')}
          testID="google-sign-in"
        >
          {busy === 'google' ? null : <GoogleG />}
          <Text numberOfLines={1}>Continue with Google</Text>
        </Button>
      ) : null}
      <View className="mt-1.5 flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-[13px] text-text-3">or with email</Text>
        <View className="h-px flex-1 bg-border" />
      </View>
    </View>
  );
}
