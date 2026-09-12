'use client';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { VoicemailPlayer } from '@/components/calls/voicemail-player';
import { Button } from '@/components/ui/button';
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
  isChannelEntry,
  timelineActor,
  timelineBody,
  timelineDotClass,
} from './describe';

export function Timeline({
  workspaceId,
  recordType,
  recordId,
  initial,
  myUserId,
  canModerate,
  subjectName,
}: {
  workspaceId: string;
  recordType: RecordType;
  recordId: string;
  initial: TimelineList;
  myUserId: string;
  canModerate: boolean;
  /** The customer's name, for what they sent us (texts, emails, calls). */
  subjectName?: string;
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
    if (!confirm('Delete this entry from the timeline? This is recorded in the audit log.')) return;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/activity.delete', {
          body: { workspaceId, activityId: entry.id },
        }),
      );
      toast.success('Deleted.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (items.length === 0)
    return (
      <EmptyState title="Nothing here yet">
        Notes, calls, texts, tasks and files show up here as they happen.
      </EmptyState>
    );
  return (
    <div className="px-5 pb-2 pt-5 md:px-6" data-testid="timeline">
      <ol className="relative ml-2 border-l border-border">
        {items.map((e) => {
          const body = timelineBody(e);
          // Texts and emails mirror the conversation, so they are never deleted from here.
          const editable = e.kind !== 'system' && !isChannelEntry(e);
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
                  {describeTimeline(e, recordType, myUserId)}
                </span>
                <span className="flex flex-none items-center gap-1">
                  <time
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
                          Delete entry
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
            </li>
          );
        })}
      </ol>
      {current.cursor ? (
        <div className="flex justify-center pb-2">
          <Button variant="ghost" size="sm" loading={busy} onClick={loadMore}>
            Show older
          </Button>
        </div>
      ) : null}
    </div>
  );
}
