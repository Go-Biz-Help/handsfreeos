'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

const WHY_NOT: Record<string, string> = {
  unknown: 'This link is not valid. Ask for a new one.',
  already_accepted: 'This invitation was already accepted. Each link works once.',
  revoked: 'This invitation was cancelled. Ask for a new one.',
  expired: 'This invitation has expired. For safety, links stop working after seven days.',
  wrong_address:
    'This invitation was sent to a different email address. Sign in with that address and open the link again.',
  not_signed_in: 'Sign in first, then open the link again.',
};

export function AcceptSupportInvite({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/support.staff.accept', { body: { token } }),
      );
      if (!out.accepted) {
        setProblem(WHY_NOT[out.reason ?? 'unknown'] ?? WHY_NOT['unknown']!);
        setBusy(false);
        return;
      }
      router.replace('/admin/tickets');
      router.refresh();
    } catch (e) {
      setProblem(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="lg"
        className="mt-6 w-full"
        loading={busy}
        onClick={accept}
        data-testid="accept-support-invite"
      >
        Accept and open the desk
      </Button>
      {problem ? (
        <p
          className="mt-3.5 text-center text-[13px] text-danger-text"
          data-testid="support-invite-problem"
        >
          {problem}
        </p>
      ) : null}
    </>
  );
}
