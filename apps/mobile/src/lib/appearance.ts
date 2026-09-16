import { useSyncExternalStore } from 'react';
import { Uniwind } from 'uniwind';

import { deviceStore } from './device-store';

/** Light, dark, or the phone's own setting (Settings → Appearance). One choice for the phone, not per person. */
export type Appearance = 'system' | 'light' | 'dark';

const KEY = 'appearance';
const listeners = new Set<() => void>();

export function getAppearance(): Appearance {
  const value = deviceStore.get<string>(KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function applyAppearance(): void {
  Uniwind.setTheme(getAppearance());
}

export function setAppearance(value: Appearance): void {
  if (value === 'system') deviceStore.remove(KEY);
  else deviceStore.set(KEY, value);
  Uniwind.setTheme(value);
  for (const listener of listeners) listener();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAppearance,
    getAppearance,
  );
}

export const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
