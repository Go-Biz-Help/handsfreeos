/**
 * A video call that wasn't for an appointment (docs/video-calls.md, part 5) is its own line on the customer's
 * timeline, as on the web. Its summary is the line's body; **Notes from the call** opens what else the AI made of
 * it: After the call's suggestions, and what was said. Asked for online, as an appointment's are.
 */
import { VIDEO_CALL_WORDS as W } from '@hfos/core';
import * as React from 'react';

import { CallRecord } from '@/components/calendar/meeting';
import { FileText } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { useNetwork } from '@/lib/network';

export function VideoCallNotes({ videoCallId }: { videoCallId: string }) {
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
        testID="timeline-video-call-notes"
      >
        {W.notes}
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={W.notes}
        scroll
        testID="video-call-notes"
      >
        {open ? (
          <CallRecord workspaceId={business.id} videoCallId={videoCallId} online={online} ours />
        ) : null}
      </Sheet>
    </>
  );
}
