import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { AuthScreen } from '@/components/auth/auth-screen';
import { ProviderButtons } from '@/components/auth/provider-buttons';
import { KeyRound, Mail } from '@/components/icons';
import { Brand } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { session, useSession } from '@/lib/auth';
import { isValidEmail, sendCodeMessage } from '@/lib/auth/messages';
import { testToolsEnabled } from '@/lib/config';
import { isTestOffline, setTestOffline, useNetwork } from '@/lib/network';
import { passkeysAvailable, signInWithPasskey } from '@/lib/passkey';
import { supabase } from '@/lib/supabase';

/**
 * Signing in: Continue with Apple (iPhones) or Google once each is turned on in Supabase, or the email address, then
 * an emailed code (it works for everyone, including people who only ever used Google on the web), a password, or a
 * passkey once passkeys are set up. New to HandsFreeOS? Create an account, here as on the web.
 */
export default function SignIn() {
  const params = useLocalSearchParams<{ email?: string }>();
  const state = useSession();
  const [email, setEmail] = React.useState(params.email ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [passkeyBusy, setPasskeyBusy] = React.useState(false);
  const ended = state.status === 'signedOut' && state.ended;
  // Development and test builds: the "No signal" test switch lives in Settings, out of reach once signed out.
  useNetwork();
  const testOffline = testToolsEnabled && isTestOffline();

  const checkedEmail = (): string | null => {
    const value = email.trim();
    if (!value) {
      setError('Enter your email address.');
      return null;
    }
    if (!isValidEmail(value)) {
      setError('Check the email address.');
      return null;
    }
    setError(null);
    return value;
  };

  const emailCode = async () => {
    const value = checkedEmail();
    if (!value) return;
    setSending(true);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email: value,
      options: { shouldCreateUser: false },
    });
    setSending(false);
    if (sendError) return setError(sendCodeMessage(sendError));
    router.push({ pathname: '/code', params: { email: value } });
  };

  const usePassword = () => {
    const value = checkedEmail();
    if (value) router.push({ pathname: '/password', params: { email: value } });
  };

  const passkey = async () => {
    setPasskeyBusy(true);
    const result = await signInWithPasskey(supabase);
    setPasskeyBusy(false);
    if (result.outcome === 'failed') setError(result.message);
    if (result.outcome === 'signedIn') await session.refreshFromStorage();
  };

  return (
    <AuthScreen testID="sign-in">
      <Brand />
      <View className="mt-[18px] gap-1.5">
        <Text variant="title">Welcome back</Text>
        <Text variant="lead">Sign in to your workspaces.</Text>
      </View>
      {testOffline ? (
        <View className="flex-row items-center gap-3 rounded-menu bg-card-2 px-3.5 py-2.5">
          <Text className="flex-1 text-[13.5px] text-text-2">Test tools: No signal is on.</Text>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => setTestOffline(false)}
            testID="test-signal-off"
          >
            Turn it off
          </Button>
        </View>
      ) : null}
      {ended ? (
        <View className="rounded-menu bg-warning-soft px-3.5 py-3" testID="sign-in-ended">
          <Text className="text-[13.5px] leading-5 text-warning-text">
            Your sign-in on this phone ended. Sign in again to keep going.
          </Text>
        </View>
      ) : null}
      <ProviderButtons onError={setError} />
      <View className="gap-1.5">
        <Label nativeID="email-label">Email</Label>
        <Input
          testID="email"
          aria-labelledby="email-label"
          accessibilityLabel="Email"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            if (error) setError(null);
          }}
          placeholder="you@company.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          returnKeyType="go"
          onSubmitEditing={() => void emailCode()}
          invalid={Boolean(error)}
        />
        <FieldError testID="sign-in-error">{error}</FieldError>
      </View>
      <Button
        icon={Mail}
        loading={sending}
        onPress={() => void emailCode()}
        testID="email-me-a-code"
      >
        Email me a code
      </Button>
      {passkeysAvailable() ? (
        <Button
          variant="secondary"
          icon={KeyRound}
          loading={passkeyBusy}
          onPress={() => void passkey()}
          testID="passkey-sign-in"
        >
          Sign in with a passkey
        </Button>
      ) : null}
      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-[13px] text-text-3">or</Text>
        <View className="h-px flex-1 bg-border" />
      </View>
      <Button variant="ghost" onPress={usePassword} testID="use-my-password">
        Use my password
      </Button>
      <View className="flex-row flex-wrap items-center justify-center pt-1">
        <Text className="text-[13.5px] text-text-2">New to HandsFreeOS? </Text>
        <Pressable
          role="link"
          hitSlop={12}
          onPress={() =>
            router.push({
              pathname: '/sign-up',
              params: email.trim() ? { email: email.trim() } : {},
            })
          }
          testID="create-an-account"
        >
          <Text className="text-[13.5px] font-medium text-accent-text">Create an account</Text>
        </Pressable>
      </View>
    </AuthScreen>
  );
}
