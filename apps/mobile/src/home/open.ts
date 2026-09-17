import { router, type Href } from 'expo-router';

import { toast } from '@/components/ui/toast';
import { config } from '@/lib/config';
import { openWeb } from '@/lib/open-web';
import { targetOfLink } from '@/links/route-map';

/**
 * Opens a web page's address where the phone keeps it: the screen the route map names (the conversation, Approvals,
 * Tasks…), or the web for what the phone leaves to it. Home's cards and sheets open their records through here, so a
 * record a later step gives the phone opens there without changing Home.
 */
export function openWebPath(path: string): void {
  const target = targetOfLink(path, [config.webUrl]);
  if (target.kind === 'screen') {
    router.push(target.href as Href);
    return;
  }
  void openWeb(path).then((opened) => {
    if (!opened) toast.error('This phone has no web browser to open that page in.');
  });
}
