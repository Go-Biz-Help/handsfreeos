'use client';
import { Eye, KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * Opening a business read-only. The reason box is not a formality: it is what the business reads in its own
 * audit log afterwards, so it is worded as the sentence they will see.
 *
 * The founder skips all of it (20261013002100): one click opens the business as its owner, with no reason and
 * no time limit, until they leave.
 */
export function ViewAsButton({
  workspaceId,
  businessName,
  ticketId,
  founder = false,
}: {
  workspaceId: string;
  businessName: string;
  ticketId?: string;
  founder?: boolean;
}) {
  if (founder) return <OpenAsOwnerButton workspaceId={workspaceId} ticketId={ticketId} />;
  return <LookButton workspaceId={workspaceId} businessName={businessName} ticketId={ticketId} />;
}

function OpenAsOwnerButton({ workspaceId, ticketId }: { workspaceId: string; ticketId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/platform.view_as.start', {
          body: { workspaceId, ...(ticketId ? { ticketId } : {}) },
        }),
      );
      router.push(`/app/w/${workspaceId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="secondary" onClick={start} disabled={busy} data-testid="view-as-open">
        <KeyRound className="h-[18px] w-[18px]" strokeWidth={1.5} />
        Open as owner
      </Button>
      {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
    </div>
  );
}

function LookButton({
  workspaceId,
  businessName,
  ticketId,
}: {
  workspaceId: string;
  businessName: string;
  ticketId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (reason.trim().length < 3) return setError('Say why, in a few words.');
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/platform.view_as.start', {
          body: {
            workspaceId,
            reason: reason.trim(),
            minutes,
            ...(ticketId ? { ticketId } : {}),
          },
        }),
      );
      router.push(`/app/w/${workspaceId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="view-as-open">
        <Eye className="h-[18px] w-[18px]" strokeWidth={1.5} />
        Look at their account
      </Button>
      <DialogContent
        title={`Look at ${businessName}`}
        description="You will see what they see, and you will not be able to change anything. They are told: it goes into their own audit log with your name, your reason, and how long you looked."
      >
        <div className="mt-4 flex flex-col gap-4">
          <Field label="Why are you looking?" htmlFor="view-as-reason">
            <Input
              id="view-as-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Checking why their appointment reminders stopped"
              data-testid="view-as-reason"
            />
          </Field>
          <Field label="For how long?" htmlFor="view-as-minutes">
            <select
              id="view-as-minutes"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="h-10 rounded-control border border-border bg-card px-2.5 text-sm"
            >
              <option value={15}>15 minutes</option>
              <option value={60}>An hour</option>
              <option value={240}>Four hours</option>
            </select>
          </Field>
          {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
          <div className="flex gap-2">
            <Button onClick={start} disabled={busy} data-testid="view-as-start">
              Start looking
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
