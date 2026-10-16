import { useLocalSearchParams } from 'expo-router';

import { OutreachPage } from '@/addons/outreach/page';

/**
 * Social Outreach's page, whichever tab its address names (`?view=waiting`, `live`, `today`, `groups`, `chats`,
 * `playbooks` or `settings`), with the web's other settings: whose (`?for=`), which (`?show=`), a tag (`?tag=`), a
 * name searched for (`?q=`) and the network whose day the live screen opens on (`?net=`). With none, its own first
 * screen.
 */
export default function OutreachRoute() {
  const params = useLocalSearchParams<{
    view?: string;
    for?: string;
    show?: string;
    tag?: string;
    q?: string;
    net?: string;
  }>();
  return <OutreachPage {...params} />;
}
