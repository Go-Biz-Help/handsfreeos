'use client';
/**
 * A video call that wasn't for an appointment (docs/video-calls.md, part 5) is its own line on the customer's
 * timeline. Its summary is the line's body; **Notes from the call** opens what else the AI made of it: After the
 * call's suggestions, and the transcript.
 */
import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { VIDEO_CALL_WORDS } from '@hfos/core';
import { CallReview } from '@/components/calendar/call-review';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Transcript = { id: string; provider: string; createdAt: string; body: string };

export function VideoCallNotes({
  workspaceId,
  videoCallId,
  title,
}: {
  workspaceId: string;
  videoCallId: string;
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
        data-testid="timeline-video-call-notes"
      >
        <FileText className="h-3.5 w-3.5" strokeWidth={1.5} />
        {VIDEO_CALL_WORDS.notes}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent title={title} className="w-[min(560px,calc(100vw-32px))]">
            <Notes workspaceId={workspaceId} videoCallId={videoCallId} />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function Notes({ workspaceId, videoCallId }: { workspaceId: string; videoCallId: string }) {
  const [transcripts, setTranscripts] = useState<Transcript[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/appointment.transcripts', { body: { workspaceId, videoCallId } })
      .then(unwrap)
      .then((out) => !cancelled && setTranscripts(out.items))
      .catch((e: unknown) => !cancelled && setFailed(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, videoCallId]);

  if (failed) return <p className="mt-3 text-[13px] text-text-2">{failed}</p>;
  if (!transcripts) return null;
  if (transcripts.length === 0)
    return <p className="mt-3 text-[13px] text-text-2">{VIDEO_CALL_WORDS.notesSoon}</p>;
  return (
    <div
      className="mt-2 flex max-h-[65vh] flex-col gap-3 overflow-y-auto"
      data-testid="video-call-notes"
    >
      <CallReview workspaceId={workspaceId} videoCallId={videoCallId} version={0} />
      {transcripts.map((t) => (
        <details key={t.id} data-testid="video-call-transcript">
          <summary className="cursor-pointer text-[13px] font-medium">
            {VIDEO_CALL_WORDS.transcriptFrom}
          </summary>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-text-2">{t.body}</p>
        </details>
      ))}
    </div>
  );
}
