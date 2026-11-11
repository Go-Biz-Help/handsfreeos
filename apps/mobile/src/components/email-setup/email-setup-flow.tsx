import {
  EMAIL_SETUP_WORDS as W,
  emailSetupPendingDomain,
  emailSetupProblems,
  ONBOARDING_SETUP_WORDS as S,
  onboardingSetupProblemsOf,
  type EmailSetupPart,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { View, type ScrollView } from 'react-native';

import { ArrowLeft } from '@/components/icons';
import { SetupFrame } from '@/components/onboarding-setup/frame';
import { businessHref } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import type { EmailSetupCalls, EmailSetupGot } from '@/email-setup/calls';
import { ApiError, errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

import { EmailOwnScreen, EmailRecordsScreen, EmailSenderScreen } from './screens';

/**
 * Home's "Set up your business email" on the phone (the owner's 7a), as the web's email-setup-flow.tsx: the
 * onboarding setup's email screens on a screen of their own. Each Next saves its part (`email_setup.save`) without
 * touching the setup's own answers; the last goes back Home.
 */
export function EmailSetupFlow({
  workspaceId,
  got,
  at,
  calls,
}: {
  workspaceId: string;
  got: EmailSetupGot;
  /** `?at=records`: straight to the domain's records, when one is still on its way. */
  at: string | null;
  calls: EmailSetupCalls;
}) {
  const { online } = useNetwork();
  const [state, setState] = React.useState(got.state);
  const [answers, setAnswers] = React.useState(got.answers);
  const [part, setPart] = React.useState<EmailSetupPart>(
    at === 'records' && got.answers.with === 'domain' && emailSetupPendingDomain(got.state)
      ? 'records'
      : 'sender',
  );
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const scroller = React.useRef<ScrollView>(null);

  const refresh = React.useCallback(async () => {
    try {
      setState((await calls.get()).state);
    } catch {
      // The next look tries again.
    }
  }, [calls]);

  const parts: readonly EmailSetupPart[] =
    answers.with === 'domain' ? ['sender', 'records', 'own'] : ['sender', 'own'];
  const i = Math.max(0, parts.indexOf(part));
  const set = (next: typeof answers) => {
    setAnswers(next);
    setProblems({});
    setError(null);
  };
  const go = (to: EmailSetupPart) => {
    setPart(to);
    setProblems({});
    setError(null);
    scroller.current?.scrollTo({ y: 0, animated: false });
  };
  const home = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(workspaceId));
  };

  async function next() {
    const found = emailSetupProblems(part, answers, state);
    if (found.length) {
      setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
      return;
    }
    if (!online) {
      setError(P.needsSignal);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await calls.save(part, answers);
      await refresh();
      const after = parts[i + 1];
      if (after) {
        go(after);
        return;
      }
      toast.show(saved.changes[0] ?? W.done);
      home();
    } catch (e) {
      setProblems(e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {});
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const props = { state, answers, set, problems, calls };
  return (
    <SetupFrame
      screen={`email-${part}`}
      progress={{ stop: 'email', at: i + 1, of: parts.length }}
      stopName={W.stop}
      title={
        part === 'sender' ? W.senderTitle : part === 'records' ? W.recordsScreenTitle : W.ownTitle
      }
      hint={part === 'sender' ? W.senderHint : part === 'records' ? W.recordsScreenHint : W.ownHint}
      summary={null}
      scroller={scroller}
      footer={
        <>
          {error ? <FieldError testID="email-setup-error">{error}</FieldError> : null}
          <View className="flex-row items-center gap-3">
            {i > 0 ? (
              <Button
                variant="ghost"
                icon={ArrowLeft}
                onPress={() => go(parts[i - 1]!)}
                disabled={busy}
                testID="email-setup-back"
              >
                {S.back}
              </Button>
            ) : null}
            <Button
              className="flex-1"
              onPress={() => void next()}
              loading={busy}
              testID="email-setup-next"
            >
              {i === parts.length - 1 ? W.done : S.next}
            </Button>
          </View>
        </>
      }
    >
      {part === 'sender' ? (
        <EmailSenderScreen {...props} />
      ) : part === 'records' ? (
        <EmailRecordsScreen {...props} onChanged={refresh} />
      ) : (
        <EmailOwnScreen {...props} onChanged={refresh} />
      )}
    </SetupFrame>
  );
}
