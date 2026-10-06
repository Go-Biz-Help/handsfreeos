import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { AuthScreen } from '@/components/auth/auth-screen';
import { CODE_LENGTH, CodeBoxes } from '@/components/auth/code-boxes';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { session } from '@/lib/auth';
import { sendCodeMessage, verifyCodeMessage } from '@/lib/auth/messages';
import { supabase } from '@/lib/supabase';

/** How long before another code can be sent, as Supabase Auth allows by default. */
const RESEND_SECONDS = 60;

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * "Check your email": the 6-digit code, typed, pasted or filled in from the email. Signing in by code, and confirming
 * a new account's email (`purpose` sign-up, from Create account or a password sign-in that isn't confirmed yet), which
 * signs in too.
 */
export default function Code() {
  const { email = '', purpose } = useLocalSearchParams<{ email: string; purpose?: string }>();
  const signingUp = purpose === 'sign-up';
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [wait, setWait] = React.useState(RESEND_SECONDS);

  React.useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const verify = React.useCallback(
    async (token: string) => {
      setChecking(true);
      setError(null);
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token,
        type: signingUp ? 'signup' : 'email',
      });
      if (verifyError) {
        setChecking(false);
        setError(verifyCodeMessage(verifyError));
        return;
      }
      await session.refreshFromStorage();
    },
    [email, signingUp],
  );

  const resend = async () => {
    setError(null);
    const { error: sendError } = signingUp
      ? await supabase.auth.resend({ type: 'signup', email })
      : await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (sendError) return setError(sendCodeMessage(sendError));
    setCode('');
    setWait(RESEND_SECONDS);
  };

  return (
    <AuthScreen
      back
      testID="code-screen"
      footer={
        signingUp ? (
          <Button
            variant="ghost"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/sign-up'))}
            testID="use-a-different-email"
          >
            Use a different email
          </Button>
        ) : (
          <Button
            variant="ghost"
            onPress={() => router.replace({ pathname: '/password', params: { email } })}
            testID="use-my-password-instead"
          >
            Use my password instead
          </Button>
        )
      }
    >
      <View className="gap-1.5">
        <Text variant="title">Check your email</Text>
        <Text variant="lead">
          We sent a 6-digit code to <Text className="font-semibold text-text">{email}</Text>.
          {signingUp ? ' Type it here to finish creating your account.' : null}
        </Text>
      </View>
      <View className="mt-1.5 gap-2">
        <CodeBoxes
          value={code}
          invalid={Boolean(error)}
          editable={!checking}
          autoFocus
          onChange={(next) => {
            setCode(next);
            if (error) setError(null);
            if (next.length === CODE_LENGTH) void verify(next);
          }}
        />
        <FieldError testID="code-error">{error}</FieldError>
      </View>
      {wait > 0 ? (
        <Text className="text-[13px] text-text-2">
          Didn’t get it?{' '}
          <Text className="text-[13px] text-text-3">Send another code in {countdown(wait)}</Text>
        </Text>
      ) : (
        <View className="flex-row items-center">
          <Text className="text-[13px] text-text-2">Didn’t get it? </Text>
          <Pressable
            role="button"
            hitSlop={12}
            onPress={() => void resend()}
            testID="send-another-code"
          >
            <Text className="text-[13px] font-medium text-accent-text">Send another code</Text>
          </Pressable>
        </View>
      )}
      {checking ? <Text className="text-[13px] text-text-3">Checking the code…</Text> : null}
    </AuthScreen>
  );
}
