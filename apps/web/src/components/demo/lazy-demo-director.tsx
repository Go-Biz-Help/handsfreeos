'use client';
import dynamic from 'next/dynamic';
import type { ComponentProps } from 'react';
import { installDemoFetch } from '@/lib/demo/browser';
import type { DemoDirector } from './demo-director';

// Before any screen fetches, so a page reloaded mid-scene gets the scene's answers from its first request.
installDemoFetch();

const Director = dynamic(() => import('./demo-director').then((m) => m.DemoDirector), {
  ssr: false,
});

/**
 * The demo player, fetched when it's shown. The business's layout shows it to HandsFreeOS staff only, but a layout's
 * scripts go to everyone it's for: imported there directly, the player's panel and every scene's steps (130 KB of
 * script) were downloaded on every signed-in page by people who can never open it.
 */
export function LazyDemoDirector(props: ComponentProps<typeof DemoDirector>) {
  return <Director {...props} />;
}
