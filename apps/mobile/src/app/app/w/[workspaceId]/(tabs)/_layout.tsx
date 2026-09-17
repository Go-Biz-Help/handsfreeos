import { Tabs } from 'expo-router/js-tabs';
import * as React from 'react';

import { BusinessCopyGate } from '@/components/copy/copy-gate';
import { TabBar } from '@/components/shell/tab-bar';
import { useLock } from '@/lib/lock';
import { pushRegistration } from '@/push/device';

/**
 * Home, Inbox, Pipeline, Calendar and More (§42), once the business's copy is on the phone. The first time they show
 * after signing in is when the phone asks to send notifications (on Android 13 and later, POST_NOTIFICATIONS).
 */
export default function TabsLayout() {
  return (
    <BusinessCopyGate>
      <AskForNotifications />
      <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
        <Tabs.Screen name="pipeline" options={{ title: 'Pipeline' }} />
        <Tabs.Screen name="calendar" options={{ title: 'Calendar' }} />
        <Tabs.Screen name="(more)" options={{ title: 'More' }} />
      </Tabs>
    </BusinessCopyGate>
  );
}

/** Asks once, when the business's screens first show and the app is unlocked (the phone remembers the answer). */
function AskForNotifications() {
  const { locked } = useLock();
  React.useEffect(() => {
    if (!locked) void pushRegistration.askOnce();
  }, [locked]);
  return null;
}
