'use client';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { TIMELINE_WORDS } from '@hfos/core';
import { VoicemailPlayer } from '@/components/calls/voicemail-player';
import { AttachmentChip } from '@/components/inbox/attachment-chip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { RecordType, TimelineEntry, TimelineList } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { cn, relativeTime } from '@/lib/utils';
import {
  describeTimeline,
  timelineActor,
  timelineApproval,
  timelineBody,
  timelineDotClass,
  timelineEditable,
  timelineRunId as workflowRunOf,
} from './describe';

export function Timeline({
  workspaceId,
  recordType,
  recordId,
  initial,
  myUserId,
  canModerate,
  subjectName,
  timeZone,
  members,
}: {
  workspaceId: string;
  recordType: RecordType;
  recordId: string;
  initial: TimelineList;
  myUserId: string;
  canModerate: boolean;
  /** The customer's name, for what they sent us (texts, emails, calls). */
  subjectName?: string;
  /** The workspace's time zone, for appointment times. */
  timeZone?: string;
  /** The team, for "approved by Chris" after what the AI teammate did with someone's OK. */
  members?: readonly { readonly id: string; readonly fullName: string }[];
}) {
  const router = useRouter();
  const key = `${initial.items[0]?.id ?? ''}:${initial.items.length}`;
  const [extra, setExtra] = useState<{
    key: string;
    items: TimelineEntry[];
    cursor: string | null;
  }>({ key, items: [], cursor: initial.nextCursor });
  const current = extra.key === key ? extra : { key, items: [], cursor: initial.nextCursor };
  const items = [...initial.items, ...current.items];
  const [busy, setBusy] = useState(false);

  async function loadMore() {
    if (!current.cursor) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/timeline.list', {
          body: { workspaceId, recordType, recordId, cursor: current.cursor, limit: 30 },
        }),
      );
      setExtra({ key, items: [...current.items, ...out.items], cursor: out.nextCursor });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(entry: TimelineEntry) {
    if (!confirm(TIMELINE_WORDS.deleteConfirm)) return;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/activity.delete', {
          body: { workspaceId, activityId: entry.id },
        }),
      );
      toast.success(TIMELINE_WORDS.deleted);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const opened = (
    <OpenedEntry
      workspaceId={workspaceId}
      recordType={recordType}
      myUserId={myUserId}
      subjectName={subjectName}
      timeZone={timeZone}
    />
  );
  if (items.length === 0)
    return (
      <>
        <EmptyState title={TIMELINE_WORDS.emptyTitle}>{TIMELINE_WORDS.emptyBody}</EmptyState>
        {opened}
      </>
    );
  return (
    <div className="px-5 pb-2 pt-5 md:px-6" data-testid="timeline">
      {opened}
      <ol className="relative ml-2 border-l border-border">
        {items.map((e) => {
          const body = timelineBody(e);
          // Texts and emails mirror the conversation, so they are never deleted from here.
          const editable = timelineEditable(e);
          const mine = editable && e.actor?.id === myUserId;
          const at = new Date(e.occurredAt);
          const recent = Date.now() - at.getTime() < 6 * 86_400_000;
          return (
            <li
              key={e.id}
              className="relative pb-5 pl-6"
              data-testid={`timeline-${e.kind}${e.subtype ? `-${e.subtype}` : ''}`}
            >
              <span
                className={cn(
                  'absolute -left-2 top-0.5 h-[15px] w-[15px] rounded-full border-2 border-card',
                  timelineDotClass(e),
                )}
                aria-hidden
              />
              <div className="flex items-start justify-between gap-3">
                <span className="text-[13px] leading-5">
                  <strong className="font-semibold">{timelineActor(e, subjectName)}</strong>{' '}
                  {describeTimeline(e, recordType, myUserId, timeZone)}
                  {timelineApproval(e, members)}
                  {workflowRunOf(e) ? (
                    <>
                      {' · '}
                      <Link
                        href={`/app/w/${workspaceId}/workflows/runs/${workflowRunOf(e)}`}
                        className="text-accent-text hover:underline"
                        data-testid="timeline-run-link"
                      >
                        {TIMELINE_WORDS.seeRun}
                      </Link>
                    </>
                  ) : null}
                </span>
                <span className="flex flex-none items-center gap-1">
                  {/* Rendered in the server's zone, then the viewer's: the words can differ by design. */}
                  <time
                    suppressHydrationWarning
                    dateTime={e.occurredAt}
                    title={at.toLocaleString()}
                    className="whitespace-nowrap text-xs text-text-3"
                  >
                    {recent ? relativeTime(e.occurredAt) : formatDate(e.occurredAt)}
                  </time>
                  {editable && (mine || canModerate) ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label="Entry actions"
                          className="-my-1 rounded-control p-1 text-text-3 hover:bg-card-2 hover:text-text"
                        >
                          <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem danger onSelect={() => void remove(e)}>
                          <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                          {TIMELINE_WORDS.deleteEntry}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </span>
              </div>
              {e.kind === 'call' &&
              e.subtype === 'voicemail' &&
              typeof e.meta.recordingPath === 'string' ? (
                <div
                  className="mt-1.5 flex flex-col gap-2 rounded-control bg-card-2 px-3 py-2.5"
                  data-testid="timeline-voicemail"
                >
                  <VoicemailPlayer
                    path={e.meta.recordingPath}
                    seconds={
                      typeof e.meta.recordingSeconds === 'number' ? e.meta.recordingSeconds : null
                    }
                    seed={typeof e.meta.callId === 'string' ? e.meta.callId : e.id}
                    surface="card"
                    bars={34}
                  />
                  {body ? <p className="text-[13px] leading-[1.5] text-text">“{body}”</p> : null}
                </div>
              ) : body ? (
                <div className="mt-1.5 whitespace-pre-wrap rounded-control bg-card-2 px-3 py-2.5 text-[13px] text-text">
                  {body}
                </div>
              ) : null}
              {e.kind === 'email' &&
              Array.isArray(e.meta.attachments) &&
              e.meta.attachments.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(
                    e.meta.attachments as { name: string; bucket: string; objectPath: string }[]
                  ).map((a) => (
                    <AttachmentChip key={a.objectPath} file={a} />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {current.cursor ? (
        <div className="flex justify-center pb-2">
          <Button variant="ghost" size="sm" loading={busy} onClick={loadMore}>
            {TIMELINE_WORDS.older}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The timeline line a search result opens (`?activity=<id>`: a note found by its words, or by who it's on), in a
 * dialog over the timeline, since it may sit far down the list or past its first page. It follows the address, so a
 * result on the record already open opens too (every record page renders per request, so this needs no Suspense
 * boundary), and is taken off it when the dialog closes, so a reload doesn't open it again.
 */
function OpenedEntry({
  workspaceId,
  recordType,
  myUserId,
  subjectName,
  timeZone,
}: {
  workspaceId: string;
  recordType: RecordType;
  myUserId: string;
  subjectName?: string;
  timeZone?: string;
}) {
  const [entry, setEntry] = useState<TimelineEntry | null>(null);
  const activityId = useSearchParams().get('activity');
  useEffect(() => {
    if (!activityId) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/activity.get', { body: { workspaceId, activityId } })
      .then(unwrap)
      .then((out) => !cancelled && setEntry(out.activity))
      .catch((e: unknown) => !cancelled && toast.error(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, activityId]);

  function close() {
    setEntry(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('activity');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  const body = entry ? timelineBody(entry) : null;
  return (
    <Dialog open={!!entry} onOpenChange={(open) => !open && close()}>
      {entry ? (
        <DialogContent
          title={`${timelineActor(entry, subjectName)} ${describeTimeline(entry, recordType, myUserId, timeZone)}`}
          description={
            <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time>
          }
          className="w-[min(560px,calc(100vw-32px))]"
        >
          <div
            className="mt-3 max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-control bg-card-2 px-3 py-2.5 text-[13.5px] text-text empty:hidden"
            data-testid="opened-activity"
          >
            {body}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
