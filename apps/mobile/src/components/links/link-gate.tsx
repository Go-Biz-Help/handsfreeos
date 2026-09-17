import { PUSH_BUTTONS } from '@hfos/core';
import { router, usePathname, type Href } from 'expo-router';
import * as React from 'react';
import { AppState } from 'react-native';

import { toast } from '@/components/ui/toast';
import { useSession } from '@/lib/auth';
import { biometrics } from '@/lib/biometrics';
import { loadMe, useMe } from '@/lib/businesses';
import { config } from '@/lib/config';
import { lockEnabledFor, useLock } from '@/lib/lock';
import { networkSnapshot } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { decideLink, type LinkDecision } from '@/links/decide';
import { pendingLinks, usePendingLink, useUnlockToRun } from '@/links/pending';
import { isPushButton } from '@/push/categories';
import { pressRunner } from '@/push/device';
import { outcomeWords } from '@/push/press';
import { rememberPress } from '@/push/test-flags';

/**
 * Opens a link once the app can show it (inside the signed-in app, with the person's copy open): a notification tapped,
 * an email's link, or the app's own scheme, including one that arrived while nobody was signed in or the app was locked.
 * Only /app/… opens a screen; the desk work opens the web; a link to a business the person isn't part of says so.
 */
export function LinkGate() {
  const state = useSession();
  const userId = state.status === 'signedIn' ? state.person.userId : null;
  if (!userId) return null;
  return (
    <>
      <OpenLinks userId={userId} />
      <RunPendingPress userId={userId} />
    </>
  );
}

function OpenLinks({ userId }: { userId: string }) {
  const { locked } = useLock();
  const pending = usePendingLink();
  const { me } = useMe(userId);
  const pathname = usePathname();
  // Just signed in or started, the app first opens the business the person had open last (app/index.tsx): the link
  // opens after that, or it would be replaced by it.
  const choosing = pathname === '/app' && (me?.businesses.length ?? 0) > 0;

  React.useEffect(() => {
    if (!pending || locked || !me || choosing) return;
    const taken = pendingLinks.take();
    if (!taken) return;
    const webOrigins = [config.webUrl];
    void (async () => {
      let decision: LinkDecision = decideLink(taken.link, {
        businessIds: me.businesses.map((b) => b.id),
        webOrigins,
      });
      // Added to a business since the phone last asked: check again before saying it isn't theirs.
      if (decision.kind === 'not-yours' && networkSnapshot().online) {
        const fresh = await loadMe(userId).catch(() => null);
        if (fresh)
          decision = decideLink(taken.link, {
            businessIds: fresh.businesses.map((b) => b.id),
            webOrigins,
          });
      }
      switch (decision.kind) {
        case 'screen':
          router.navigate(decision.href as Href);
          return;
        case 'web':
          if (!(await openWeb(decision.path)))
            toast.error('This phone has no web browser to open that page in.');
          return;
        case 'not-yours':
          toast.show(decision.message, {
            tone: 'danger',
            action: { label: 'OK', onPress: () => undefined },
          });
          return;
        case 'ignore':
          return;
      }
    })();
  }, [pending, locked, me, choosing, userId]);

  return null;
}

/** "Unlock to send your reply": what the phone's own prompt says before a waiting button runs. */
function unlockPrompt(actionId: string): string {
  if (!isPushButton(actionId)) return 'Unlock HandsFreeOS';
  switch (actionId) {
    case 'reply':
      return 'Unlock to send your reply';
    case 'approve':
      return 'Unlock to approve it';
    default:
      return `Unlock to ${PUSH_BUTTONS[actionId].title.replace(/^Let /, 'let ')}`;
  }
}

function useAppActive(): boolean {
  const [active, setActive] = React.useState(AppState.currentState === 'active');
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/**
 * A notification's button that waited for the phone to be unlocked, now that the person opened the app from "Unlock
 * your phone to…": opening the app took the phone's own unlock, and the app asks for its Face ID lock too (unless it
 * just did, or the person turned it off), then runs the press.
 */
function RunPendingPress({ userId }: { userId: string }) {
  const { locked } = useLock();
  const wanted = useUnlockToRun();
  const active = useAppActive();
  const unlockedAt = React.useRef<number | null>(null);
  const wasLocked = React.useRef(locked);

  React.useEffect(() => {
    if (wasLocked.current && !locked) unlockedAt.current = Date.now();
    wasLocked.current = locked;
  }, [locked]);

  React.useEffect(() => {
    if (!wanted || locked || !active) return;
    if (!pendingLinks.takeUnlock()) return;
    const pending = pressRunner.pending();
    if (!pending) return;
    void (async () => {
      const justUnlocked = unlockedAt.current !== null && Date.now() - unlockedAt.current < 15_000;
      if (!justUnlocked && (config.e2e || lockEnabledFor(userId))) {
        const answer = await biometrics.authenticate(unlockPrompt(pending.actionId));
        if (answer !== 'unlocked' && answer !== 'unavailable') {
          toast.show('Nothing was sent.', {
            action: { label: 'Unlock', onPress: () => pendingLinks.unlockToRun() },
          });
          return;
        }
      }
      const outcome = await pressRunner.runPending();
      if (!outcome) return;
      rememberPress(outcome);
      if (outcome.kind !== 'asked')
        toast.show(outcomeWords(outcome), outcome.kind === 'refused' ? { tone: 'danger' } : {});
    })();
  }, [wanted, locked, active, userId]);

  return null;
}
