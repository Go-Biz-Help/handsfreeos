'use client';
/**
 * Home's "Set up your business email" (the owner's 7a) on the web: the onboarding setup's email screens on a page of
 * their own, for a business that finished setting up before the step existed or whose domain's records are still on
 * their way. Each Next saves its part with email_setup.save, as the setup's "Your business email" stop does, without
 * touching the setup's own answers. The last part goes Home.
 */
import {
  EMAIL_SETUP_WORDS as W,
  EmailSetupGetOutput,
  EmailSetupSaveOutput,
  emailSetupPendingDomain,
  emailSetupProblems,
  onboardingSetupProblemsOf,
  ONBOARDING_SETUP_WORDS as S,
  type EmailSetupAnswers,
  type EmailSetupPart,
  type EmailSetupState,
} from '@hfos/core';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SetupCard } from '@/components/onboarding-setup/frame';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { EmailOwnScreen, EmailRecordsScreen, EmailSenderScreen } from './screens';

const LIVE = ['email_domain', 'email_address', 'mailbox_connection'];

const partsOf = (answers: EmailSetupAnswers): readonly EmailSetupPart[] =>
  answers.with === 'domain' ? ['sender', 'records', 'own'] : ['sender', 'own'];

export function EmailSetupFlow({
  workspaceId,
  got,
  at,
}: {
  workspaceId: string;
  got: { readonly state: EmailSetupState; readonly answers: EmailSetupAnswers };
  /** `?at=records`: straight to the domain's records, when one is still on its way. */
  at: 'records' | null;
}) {
  const router = useRouter();
  const home = `/app/w/${workspaceId}`;
  const [state, setState] = useState(got.state);
  const [answers, setAnswers] = useState(got.answers);
  const [part, setPart] = useState<EmailSetupPart>(
    at === 'records' && got.answers.with === 'domain' && emailSetupPendingDomain(got.state)
      ? 'records'
      : 'sender',
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const fresh = EmailSetupGetOutput.parse(
        unwrap(await apiBrowser().POST('/v1/queries/email_setup.get', { body: { workspaceId } })),
      );
      setState(fresh.state);
    } catch {
      // The next change or the next look tries again.
    }
  }, [workspaceId]);

  // The records being made and found, an address added, a mailbox connected: as they happen.
  const version = useLiveVersion(LIVE, 1_000);
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);

  const parts = partsOf(answers);
  const i = Math.max(0, parts.indexOf(part));
  const set = (next: EmailSetupAnswers) => {
    setAnswers(next);
    setProblems({});
    setError(null);
  };

  const go = (to: EmailSetupPart) => {
    setPart(to);
    setProblems({});
    setError(null);
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function next() {
    const found = emailSetupProblems(part, answers, state);
    if (found.length) {
      setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = EmailSetupSaveOutput.parse(
        unwrap(
          await apiBrowser().POST('/v1/commands/email_setup.save', {
            body: { workspaceId, part, email: answers },
          }),
        ),
      );
      await refresh();
      const after = parts[i + 1];
      if (after) {
        go(after);
        return;
      }
      toast.success(saved.changes[0] ?? W.done);
      router.push(home);
      router.refresh();
    } catch (e) {
      const byPath = e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {};
      setProblems(byPath);
      setError(Object.keys(byPath).length ? null : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const back = () => {
    const before = parts[i - 1];
    if (before) go(before);
  };

  const props = { workspaceId, state, answers, set, problems };
  const title =
    part === 'sender' ? W.senderTitle : part === 'records' ? W.recordsScreenTitle : W.ownTitle;
  const hint =
    part === 'sender' ? W.senderHint : part === 'records' ? W.recordsScreenHint : W.ownHint;

  return (
    <div ref={top} className="w-full max-w-[720px] scroll-mt-20">
      <SetupCard
        screen={`email_${part}`}
        testId="email-setup"
        counter={`${S.position(i + 1, parts.length)} · ${W.stop}`}
        title={title}
        hint={hint}
        summary={null}
        footer={
          <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
            {error ? <FieldError>{error}</FieldError> : null}
            <div className="flex flex-wrap-reverse items-center justify-between gap-3">
              {i > 0 ? (
                <Button
                  variant="ghost"
                  onClick={back}
                  disabled={busy}
                  data-testid="email-setup-back"
                >
                  <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                  {S.back}
                </Button>
              ) : (
                <span />
              )}
              <Button
                size="lg"
                onClick={() => void next()}
                loading={busy}
                data-testid="email-setup-next"
              >
                {i === parts.length - 1 ? W.done : S.next}
                <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        }
      >
        {part === 'sender' ? (
          <EmailSenderScreen {...props} />
        ) : part === 'records' ? (
          <EmailRecordsScreen {...props} onChanged={refresh} />
        ) : (
          <EmailOwnScreen {...props} forClient={false} />
        )}
      </SetupCard>
    </div>
  );
}
