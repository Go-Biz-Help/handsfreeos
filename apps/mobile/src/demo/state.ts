import * as React from 'react';

import { session } from '@/lib/auth';
import { deviceStore } from '@/lib/device-store';

/**
 * The scene playing on this phone (src/demo), kept on the phone like a teammate view (view-as/state.ts) so it outlasts
 * the app going to the background or being woken just for a notification's button: Approve pressed on the lock screen
 * plays its step even when the phone put the app to sleep. Nothing in it is ever sent: the made-up rows it adds to the
 * screens are worked out from it each time (`demoWorld`).
 */
export interface PhoneDemo {
  /** Who started it: anyone else signed in on the phone doesn't see it. */
  readonly viewerId: string;
  readonly workspaceId: string;
  readonly scene: string;
  /** When each step played, in milliseconds after the scene started, as the web's player keeps them. */
  readonly steps: readonly number[];
  readonly startedAt: number;
  readonly business: string;
  /** The business's AI teammate's name, which its made-up messages sign off with. */
  readonly teammate: string;
  /** The presenter's first name, for what they write. */
  readonly me: string;
  /** Their full name, as a thread names who sent or approved something. */
  readonly myName: string;
  readonly timeZone: string;
  /** Made-up conversations opened (read) while it plays. */
  readonly read: readonly string[];
  /** Replies the presenter typed into a made-up conversation: they show as sent, and go nowhere. */
  readonly typed: readonly DemoTyped[];
}

export interface DemoTyped {
  readonly id: string;
  readonly conversationId: string;
  readonly body: string;
  readonly at: number;
}

const KEY = 'demoPlayer';

const readKept = (): PhoneDemo | null => deviceStore.get<PhoneDemo>(KEY) ?? null;

/** The scene playing for whoever is signed in, or null. */
export function currentDemo(): PhoneDemo | null {
  const demo = readKept();
  if (!demo) return null;
  const state = session.getState();
  return state.status === 'signedIn' && state.person.userId === demo.viewerId ? demo : null;
}

export function keepDemo(demo: PhoneDemo): void {
  deviceStore.set(KEY, demo);
}

export function dropDemo(): void {
  deviceStore.remove(KEY);
}

/** The scene playing in this business for this person, or null; follows every step. */
export function useDemo(viewerId: string, workspaceId: string): PhoneDemo | null {
  const demo = React.useSyncExternalStore(deviceStore.subscribe, readKept, readKept);
  return demo && demo.viewerId === viewerId && demo.workspaceId === workspaceId ? demo : null;
}
