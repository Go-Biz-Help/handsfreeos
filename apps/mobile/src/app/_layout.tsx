import '../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { View } from 'react-native';

import { LockGate } from '@/components/lock/lock-gate';
import { TestUnlockPrompt } from '@/components/lock/test-unlock-prompt';
import { Text } from '@/components/ui/text';
import { Toaster } from '@/components/ui/toast';
import { useScreenTracking } from '@/lib/analytics';
import { startApp } from '@/lib/app-start';
import { useSession } from '@/lib/auth';
import { config, isConfigured, testToolsEnabled } from '@/lib/config';
import { NAV_THEME, colors, useThemeName } from '@/theme';

void SplashScreen.preventAutoHideAsync();

/** Last resort: anything below the root that can't draw shows why instead of closing the app. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

export default function RootLayout() {
  const theme = useThemeName();
  const state = useSession();
  const [ready, setReady] = React.useState(false);
  useScreenTracking();

  React.useEffect(() => {
    void startApp().finally(() => setReady(true));
  }, []);

  React.useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!isConfigured()) return <NotConfigured />;
  if (!ready || state.status === 'starting') return null;
  const signedIn = state.status === 'signedIn';

  return (
    <ThemeProvider value={NAV_THEME[theme]}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <LockGate>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors[theme].bg },
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="app" />
          </Stack.Protected>
          <Stack.Protected guard={testToolsEnabled}>
            <Stack.Screen name="self-test" options={{ headerShown: true, title: 'Self-test' }} />
          </Stack.Protected>
        </Stack>
      </LockGate>
      <Toaster />
      <PortalHost />
      {config.e2e ? <TestUnlockPrompt /> : null}
    </ThemeProvider>
  );
}

/** A build made without EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, EXPO_PUBLIC_API_URL or EXPO_PUBLIC_SYNC_URL. */
function NotConfigured() {
  React.useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-bg px-8">
      <Text variant="heading">This build isn’t connected</Text>
      <Text className="text-center text-text-2">
        It was built without the addresses of HandsFreeOS’s servers. Build it again with its
        EXPO_PUBLIC_ settings.
      </Text>
    </View>
  );
}
