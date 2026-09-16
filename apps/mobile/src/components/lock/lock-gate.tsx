import * as React from 'react';
import { AppState, View, type AppStateStatus } from 'react-native';

import { useSession } from '@/lib/auth';
import { lock, lockEnabledFor, lockOnReturn, useLock } from '@/lib/lock';

import { lockIfEnabled } from '@/lib/app-start';

import { LockScreen } from './lock-screen';
import { PrivacyCover } from './privacy-cover';

function useAppState(): AppStateStatus {
  const [state, setState] = React.useState(AppState.currentState);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', setState);
    return () => sub.remove();
  }, []);
  return state;
}

/**
 * Puts the lock over the app. The screens underneath stay where they were (and hidden from screen readers), so
 * unlocking returns to the same place. Locks again after a few minutes away.
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const state = useSession();
  const { locked } = useLock();
  const appState = useAppState();
  const person = state.status === 'signedIn' ? state.person : null;
  const backgroundAt = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!person) lock.unlock();
  }, [person]);

  React.useEffect(() => {
    if (appState === 'background') backgroundAt.current ??= Date.now();
    if (appState === 'active') {
      if (lockOnReturn(backgroundAt.current, Date.now())) void lockIfEnabled();
      backgroundAt.current = null;
    }
  }, [appState]);

  const showLock = locked && person !== null;
  const covered =
    !showLock && person !== null && appState !== 'active' && lockEnabledFor(person.userId);

  return (
    <View className="flex-1">
      <View
        className="flex-1"
        importantForAccessibility={showLock ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={showLock}
      >
        {children}
      </View>
      {showLock ? <LockScreen person={person} /> : null}
      {covered ? <PrivacyCover /> : null}
    </View>
  );
}
