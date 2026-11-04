/**
 * A phone call on the business number that someone on the team was on (20261027023200) is its own line on the
 * customer's timeline, as on the web. Once its words are in, the AI's summary is the line's body; **Notes from the
 * call** opens the rest: the tasks it added, the follow-up and record change waiting for an OK, and what was said.
 * Asked for online.
 */
import { CALL_REVIEW_WORDS as W } from '@hfos/core';
import * as React from 'react';

import { CallRecord } from '@/components/calendar/meeting';
import { FileText } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { useNetwork } from '@/lib/network';

export function PhoneCallNotes({ callId }: { callId: string }) {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={FileText}
        className="self-start"
        onPress={() => setOpen(true)}
        testID="timeline-phone-call-notes"
      >
        {W.notes}
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={W.notes}
        scroll
        testID="phone-call-notes"
      >
        {open ? <CallRecord workspaceId={business.id} callId={callId} online={online} /> : null}
      </Sheet>
    </>
  );
}
