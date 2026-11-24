import { useLocalSearchParams } from 'expo-router';

import { OutreachPage } from '@/addons/outreach/page';
import { RouteInView } from '@/lib/in-view';

/**
 * Social Outreach's page, whichever tab its address names (`?view=waiting`, `live`, `today`, `groups`, `chats`,
 * `playbooks` or `settings`), with the web's other settings: whose (`?for=`), which (`?show=`), a tag (`?tag=`), a
 * name searched for (`?q=`), the network whose day the live screen opens on (`?net=`), the part of Settings
 * (`?part=`: General or a network's; none is the menu), the ask whose code is asked for (`?view=code&ask=`) and a
 * group's own page (`?view=groups&group=`). With none, its own first screen. What a page asks again every so often
 * (the counters, the live answers, the asks) waits while the page is under another or on a tab that isn't picked.
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
    group?: string;
  }>();
  return (
    <RouteInView>
      <OutreachPage {...params} />
    </RouteInView>
  );
}
