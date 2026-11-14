'use client';
/**
 * Across the top of every page of a practice business (Admin → Try onboarding, 20261027027200): it isn't real, when
 * it goes, what is pretended, and End practice, which deletes it for good after asking once.
 */
import { PRACTICE_WORDS as W, practiceEndsIn } from '@hfos/core';
import { FlaskConical } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FieldError } from '@/components/ui/field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

export function PracticeBanner({
  workspaceId,
  name,
  endsAt,
}: {
  workspaceId: string;
  name: string;
  endsAt: string;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  // Worked out after the page is drawn, so the server's clock and the browser's never disagree in the markup.
  const [endsIn, setEndsIn] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setEndsIn(practiceEndsIn(endsAt));
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [endsAt]);

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-warning-soft px-4 py-2 text-[13px] text-warning-text"
      data-testid="practice-banner"
    >
      <FlaskConical className="h-4 w-4 flex-none" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">{W.banner(endsIn ?? 'within a day')}</span>
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="font-semibold underline underline-offset-2"
        data-testid="practice-end"
      >
        {W.end}
      </button>
      <EndPracticeDialog
        workspaceId={workspaceId}
        name={name}
        open={asking}
        onOpenChange={setAsking}
        onEnded={() => {
          router.push('/admin/try?ended=1');
          router.refresh();
        }}
      />
    </div>
  );
}

/** "End practice and delete it for good?", then `practice.end`. */
export function EndPracticeDialog({
  workspaceId,
  name,
  open,
  onOpenChange,
  onEnded,
}: {
  workspaceId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/practice.end', { body: { workspaceId } }));
      onOpenChange(false);
      onEnded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent title={W.end} description={W.endAsk(name)}>
        <FieldError>{error}</FieldError>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {W.endNo}
          </Button>
          <Button
            variant="danger"
            onClick={() => void end()}
            loading={busy}
            data-testid="practice-end-yes"
          >
            {busy ? W.ending : W.endYes}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
