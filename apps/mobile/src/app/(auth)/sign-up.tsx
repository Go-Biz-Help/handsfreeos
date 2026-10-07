import { EXISTING_ACCOUNT_MESSAGE, isExistingAccount } from '@hfos/core';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { AuthScreen } from '@/components/auth/auth-screen';
import { ProviderButtons } from '@/components/auth/provider-buttons';
import { Eye, EyeOff } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { session } from '@/lib/auth';
import { isValidEmail, signUpErrorMessage } from '@/lib/auth/messages';
import { supabase } from '@/lib/supabase';

/** HandsFreeOS's own terms and privacy policy, on the website, as the web's sign-up links them. */
const TERMS_URL = 'https://handsfreeos.com/terms';
const PRIVACY_URL = 'https://handsfreeos.com/privacy';

type Problems = { name?: string; email?: string; password?: string; form?: string };

/**
 * Creating an account on the phone, as on the web: Continue with Apple or Google once they're on, or a name, an
 * email and a password of at least 12 characters. The email is confirmed with a 6-digit code on the next screen.
 */
export default function SignUp() {
  const params = useLocalSearchParams<{ email?: string }>();
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState(params.email ?? '');
  const [password, setPassword] = React.useState('');
  const [shown, setShown] = React.useState(false);
  const [problems, setProblems] = React.useState<Problems>({});
  const [hasAccount, setHasAccount] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const create = async () => {
    const found: Problems = {};
    if (name.trim().length < 2) found.name = 'Enter your name so teammates recognize you.';
    if (!isValidEmail(email)) found.email = 'Check the email address.';
    if (password.length < 12)
      found.password = 'Use at least 12 characters. A short sentence works well.';
    setProblems(found);
    setHasAccount(false);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    const address = email.trim();
    const { data, error } = await supabase.auth.signUp({
      email: address,
      password,
      options: { data: { full_name: name.trim() } },
    });
    setBusy(false);
    if (error) {
      const message = signUpErrorMessage(error);
      setHasAccount(message === EXISTING_ACCOUNT_MESSAGE);
      return setProblems({ form: message });
    }
    if (isExistingAccount(data.user)) {
      setHasAccount(true);
      return setProblems({ form: EXISTING_ACCOUNT_MESSAGE });
    }
    // Only where email confirmation is off (never on the hosted project) does signing up sign in straight away.
    if (data.session) return void session.refreshFromStorage();
    router.push({ pathname: '/code', params: { email: address, purpose: 'sign-up' } });
  };

  const clear = (key: keyof Problems) => {
    if (problems[key] || problems.form)
      setProblems((p) => ({ ...p, [key]: undefined, form: undefined }));
  };

  return (
    <AuthScreen back testID="sign-up">
      <View className="gap-1.5">
        <Text variant="title">Create your account</Text>
        <Text variant="lead">Then you’ll set up your business.</Text>
      </View>
      <ProviderButtons onError={(message) => setProblems(message ? { form: message } : {})} />
      <View className="gap-1.5">
        <Label nativeID="name-label">Full name</Label>
        <Input
          testID="full-name"
          aria-labelledby="name-label"
          accessibilityLabel="Full name"
          value={name}
          onChangeText={(text) => {
            setName(text);
            clear('name');
          }}
          placeholder="Chris Martinez"
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          invalid={Boolean(problems.name)}
        />
        <FieldError testID="name-error">{problems.name}</FieldError>
      </View>
      <View className="gap-1.5">
        <Label nativeID="email-label">Work email</Label>
        <Input
          testID="email"
          aria-labelledby="email-label"
          accessibilityLabel="Work email"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            clear('email');
          }}
          placeholder="you@company.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
          invalid={Boolean(problems.email)}
        />
        <FieldError testID="email-error">{problems.email}</FieldError>
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
            clear('password');
          }}
          placeholder="At least 12 characters"
          secureTextEntry={!shown}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={() => void create()}
          invalid={Boolean(problems.password)}
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
        {problems.password ? (
          <FieldError testID="password-error">{problems.password}</FieldError>
        ) : (
          <Text className="text-[12.5px] text-text-3">
            A short sentence you’ll remember works best.
          </Text>
        )}
      </View>
      {problems.form ? <FieldError testID="sign-up-error">{problems.form}</FieldError> : null}
      {hasAccount ? (
        <Button
          variant="secondary"
          onPress={() => router.replace({ pathname: '/sign-in', params: { email: email.trim() } })}
          testID="sign-in-instead"
        >
          Sign in instead
        </Button>
      ) : null}
      <Button loading={busy} onPress={() => void create()} testID="create-account">
        Create account
      </Button>
      <Text className="text-center text-[12px] leading-[18px] text-text-3">
        By continuing you agree to the{' '}
        <Text
          className="text-[12px] text-accent-text"
          role="link"
          onPress={() => void Linking.openURL(TERMS_URL)}
          testID="sign-up-terms"
        >
          Terms
        </Text>{' '}
        and{' '}
        <Text
          className="text-[12px] text-accent-text"
          role="link"
          onPress={() => void Linking.openURL(PRIVACY_URL)}
          testID="sign-up-privacy"
        >
          Privacy Policy
        </Text>
        .
      </Text>
    </AuthScreen>
  );
}
