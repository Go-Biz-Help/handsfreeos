import { useLocalSearchParams } from 'expo-router';

import { OutreachPage } from '@/addons/outreach/page';

/**
 * Social Outreach's page, whichever tab its address names (`?view=waiting`, `live`, `today`, `groups`, `chats`,
 * `playbooks` or `settings`), with the web's other settings: whose (`?for=`), which (`?show=`), a tag (`?tag=`), a
 * name searched for (`?q=`), the network whose day the live screen opens on (`?net=`), the part of Settings
 * (`?part=`: General or a network's; none is the menu) and the ask whose code is asked for (`?view=code&ask=`). With
 * none, its own first screen.
 */
export default function OutreachRoute() {
  const params = useLocalSearchParams<{
    view?: string;
    for?: string;
    show?: string;
    tag?: string;
    q?: string;
    net?: string;
    part?: string;
    ask?: string;
  }>();
  return <OutreachPage {...params} />;
}
