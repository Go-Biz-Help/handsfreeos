import { Tabs } from 'expo-router/js-tabs';

import { BusinessCopyGate } from '@/components/copy/copy-gate';
import { TabBar } from '@/components/shell/tab-bar';

/** Home, Inbox, Pipeline, Calendar and More (§42), once the business's copy is on the phone. */
export default function TabsLayout() {
  return (
    <BusinessCopyGate>
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
