import { useRouter, type Href } from 'expo-router';
import { useEffect } from 'react';
import { Uniwind } from 'uniwind';

import { SPIKE_SERVER } from './report';

/**
 * Development builds only: lets the spike server open a screen or switch the theme, so the checks run on the
 * simulator without taps. Step 8 replaces this with Maestro flows.
 */
export function SpikeDriver() {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    void (async () => {
      while (!stopped) {
        try {
          const res = await fetch(`${SPIKE_SERVER}/route`);
          if (res.status === 200) {
            const command = (await res.json()) as {
              route?: string;
              theme?: 'light' | 'dark' | 'system';
            };
            if (command.theme) Uniwind.setTheme(command.theme);
            if (command.route) router.push(command.route as Href);
          }
        } catch {
          // The spike server isn't running; try again shortly.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [router]);
  return null;
}
