'use client';
/**
 * A phone call on the business number that someone on the team was on (20261027023200) is its own line on the
 * customer's timeline. Once its words are in, the AI's summary is the line's body; **Notes from the call** opens the
 * rest of what the AI made of it: the tasks it added, the follow-up and record change waiting for an OK, and what was
 * said.
 */
import { CALL_REVIEW_WORDS as W } from '@hfos/core';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { CallReview } from '@/components/calendar/call-review';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

export function PhoneCallNotes({
  workspaceId,
  callId,
  title,
}: {
  workspaceId: string;
  callId: string;
  /** What the timeline line says, for the dialog's title. */
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 mt-1"
        onClick={() => setOpen(true)}
        data-testid="timeline-phone-call-notes"
      >
        <FileText className="h-3.5 w-3.5" strokeWidth={1.5} />
        {W.notes}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent title={title} className="w-[min(560px,calc(100vw-32px))]">
            <div className="mt-2 flex max-h-[65vh] flex-col overflow-y-auto">
              <CallReview workspaceId={workspaceId} callId={callId} version={0} />
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
