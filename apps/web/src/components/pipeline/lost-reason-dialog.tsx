'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';

const REASONS = [
  ['Went with another bidder', 'Price or timing'],
  ['Decided not to do the work', 'Postponed or cancelled'],
  ['No response', 'Went cold after follow-ups'],
] as const;

/** Moving a lead into a lost stage asks why. The reason lands on the lead and in the audit log. */
export function LostReasonDialog({
  open,
  onOpenChange,
  leadTitle,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadTitle: string;
  onConfirm: (reason: string) => void;
  busy?: boolean;
}) {
  const [picked, setPicked] = useState(0);
  const [extra, setExtra] = useState('');
  useEffect(() => {
    if (open) {
      setPicked(0);
      setExtra('');
    }
  }, [open]);
  const reason = [REASONS[picked]![0], extra.trim()].filter(Boolean).join(' · ');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Why was it lost?"
        description={`Recorded on ${leadTitle} and in the audit log. It helps spot patterns later.`}
      >
        <div role="radiogroup" aria-label="Reason" className="mt-4 flex flex-col gap-2">
          {REASONS.map(([title, detail], i) => (
            <RadioCard
              key={title}
              selected={picked === i}
              onSelect={() => setPicked(i)}
              title={title}
              description={detail}
              testId={`lost-reason-${i}`}
            />
          ))}
        </div>
        <Field label="Anything else?" htmlFor="lost-extra" className="mt-3.5" hint="Optional.">
          <Input
            id="lost-extra"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="They chose a cheaper patch job"
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => onConfirm(reason)}
            data-testid="lost-confirm"
          >
            Mark as lost
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
