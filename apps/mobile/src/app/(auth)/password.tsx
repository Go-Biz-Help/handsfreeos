import { isAuthError } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { AuthScreen } from '@/components/auth/auth-screen';
import { Eye, EyeOff } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { session } from '@/lib/auth';
import { passwordMessage, sendCodeMessage } from '@/lib/auth/messages';
import { config } from '@/lib/config';
import { supabase } from '@/lib/supabase';

/** "Enter your password": the same password as the web. Forgot password? opens the web's reset page. */
export default function Password() {
  const { email = '' } = useLocalSearchParams<{ email: string }>();
  const [password, setPassword] = React.useState('');
  const [shown, setShown] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const signIn = async () => {
    if (!password) return setError('Enter your password.');
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError && isAuthError(signInError) && signInError.code === 'email_not_confirmed') {
      // Only the right password gets this far: a code confirms the email and signs in. One sent a moment ago (by
      // signing up) still works, so being told to wait still goes to the code.
      const { error: sendError } = await supabase.auth.resend({ type: 'signup', email });
      setBusy(false);
      const waitABit = isAuthError(sendError) && /rate_limit/.test(sendError.code ?? '');
      if (sendError && !waitABit) return setError(sendCodeMessage(sendError));
      return router.replace({ pathname: '/code', params: { email, purpose: 'sign-up' } });
    }
    if (signInError) {
      setBusy(false);
      return setError(passwordMessage(signInError));
    }
    await session.refreshFromStorage();
  };

  return (
    <AuthScreen
      back
      testID="password-screen"
      footer={
        <Button
          variant="ghost"
          onPress={() => router.replace({ pathname: '/sign-in', params: { email } })}
          testID="email-me-a-code-instead"
        >
          Email me a code instead
        </Button>
      }
    >
      <View className="gap-1.5">
        <Text variant="title">Enter your password</Text>
        <Text variant="lead">For {email}</Text>
      </View>
      <View className="gap-1.5">
        <Label nativeID="password-label">Password</Label>
        <Input
          testID="password"
          aria-labelledby="password-label"
          accessibilityLabel="Password"
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            if (error) setError(null);
          }}
          secureTextEntry={!shown}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void signIn()}
          autoFocus
          invalid={Boolean(error)}
          trailing={
            <Pressable
              role="button"
              accessibilityLabel={shown ? 'Hide password' : 'Show password'}
              onPress={() => setShown((s) => !s)}
              className="w-12 self-stretch items-center justify-center"
              testID="show-password"
            >
              <Icon as={shown ? EyeOff : Eye} className="size-[18px] text-text-3" />
            </Pressable>
          }
        />
        <FieldError testID="password-error">{error}</FieldError>
        <Pressable
          role="link"
          hitSlop={12}
          className="self-start"
          onPress={() => void Linking.openURL(`${config.webUrl}/forgot-password`)}
          testID="forgot-password"
        >
          <Text className="text-[13px] font-medium text-accent-text">Forgot password?</Text>
        </Pressable>
      </View>
      <Button loading={busy} onPress={() => void signIn()} testID="sign-in-button">
        Sign in
      </Button>
    </AuthScreen>
  );
}
