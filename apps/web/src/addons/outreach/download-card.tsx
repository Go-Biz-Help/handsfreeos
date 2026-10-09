'use client';
/**
 * Bringing in Facebook's download file, on the Friends tab (docs/outreach.md, decisions 2 and 15). The person picks
 * the zips Facebook gave them, and their browser reads them (@hfos/core/addons/outreach/download): names and moments
 * are sent, a part at a time, with each one-to-one chat's latest few messages for the AI to read (./chats-view.tsx).
 * With the last part, HandsFreeOS matches the names to the people saved and puts what the file says in place in their
 * own friends.
 */
import {
  DOWNLOAD_LIST_KEYS,
  DOWNLOAD_LISTS,
  DownloadError,
  downloadParts,
  readDownload,
  type DownloadCounts,
  type DownloadRead,
} from '@hfos/core/addons/outreach/download';
import { FileUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Friends } from './types';

type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading'; readonly done: number; readonly all: number }
  | { readonly kind: 'read'; readonly read: DownloadRead }
  | {
      readonly kind: 'sending';
      readonly read: DownloadRead;
      readonly done: number;
      readonly all: number;
    }
  /** A part that didn't go: trying again carries on from it, in the same bringing-in. */
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly read: DownloadRead | null;
      readonly importId?: string;
      readonly from?: number;
    };

const COULD_NOT_READ =
  'That file couldn’t be read. Pick the zip files Facebook gave you, just as they downloaded.';

/** "Oct 7, 2026". */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Each list's count, and the chats', leaving out the lists the file didn't have. */
function CountList({ counts }: { counts: Omit<DownloadCounts, 'linked' | 'notLinked'> }) {
  const shown = [
    ...DOWNLOAD_LIST_KEYS.map((k) => [DOWNLOAD_LISTS[k], counts[k]] as const),
    ['Chats', counts.chats] as const,
  ].filter(([, n]) => n > 0);
  return (
    <dl className="mt-2 space-y-1 text-[13px]" data-testid="download-counts">
      {shown.map(([label, n]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <dt className="text-text-2">{label}</dt>
          <dd className="tabular-nums">{n.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What was read, counted by list. */
function countsOf(read: DownloadRead): Omit<DownloadCounts, 'linked' | 'notLinked'> {
  const counts = Object.fromEntries(DOWNLOAD_LIST_KEYS.map((k) => [k, 0])) as Record<
    (typeof DOWNLOAD_LIST_KEYS)[number],
    number
  >;
  for (const p of read.people) counts[p.list]++;
  return { ...counts, chats: read.chats.length };
}

function Progress({ done, all, label }: { done: number; all: number; label: string }) {
  const share = all ? done / all : 0;
  return (
    <div className="mt-3" data-testid="download-progress">
      <p className="text-[12.5px] text-text-2" aria-live="polite">
        {label}
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-card-2" aria-hidden="true">
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function DownloadCard({
  workspaceId,
  download,
}: {
  workspaceId: string;
  download: Friends['download'];
}) {
  const router = useRouter();
  const picker = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });

  const read = async (files: File[]) => {
    setStage({ kind: 'reading', done: 0, all: 0 });
    try {
      const got = await readDownload(files, (done, all) =>
        setStage({ kind: 'reading', done, all }),
      );
      setStage({ kind: 'read', read: got });
    } catch (e) {
      setStage({
        kind: 'failed',
        message: e instanceof DownloadError ? e.message : COULD_NOT_READ,
        read: null,
      });
    }
  };

  /** Sends the parts in order, from `from`; the first starts the bringing-in and the last finishes it. */
  const send = async (got: DownloadRead, importId?: string, from = 0) => {
    const parts = downloadParts(got);
    let id = importId;
    for (let i = from; i < parts.length; i++) {
      setStage({ kind: 'sending', read: got, done: i, all: parts.length });
      try {
        const sent = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.download.save', {
            body: {
              workspaceId,
              madeAt: got.madeAt,
              ...(id ? { importId: id } : {}),
              people: parts[i]!.people,
              chats: parts[i]!.chats,
              last: i === parts.length - 1,
            },
          }),
        );
        id = sent.importId;
        if (sent.counts) {
          const { linked } = sent.counts;
          toast.success(
            `Your Facebook file is in. ${linked.toLocaleString()} ${linked === 1 ? 'name matches' : 'names match'} people saved here.`,
          );
        }
      } catch (e) {
        setStage({ kind: 'failed', message: errorMessage(e), read: got, importId: id, from: i });
        return;
      }
    }
    setStage({ kind: 'idle' });
    router.refresh();
  };

  const pickButton = (label: string, variant: 'primary' | 'secondary' | 'ghost') => (
    <Button
      variant={variant}
      size="sm"
      onClick={() => picker.current?.click()}
      data-testid="download-pick"
    >
      <FileUp className="h-4 w-4" strokeWidth={1.75} />
      {label}
    </Button>
  );

  return (
    <Card className="p-4" data-testid="download-card">
      <h3 className="text-[15px] font-semibold">Bring in your Facebook file</h3>
      <input
        ref={picker}
        type="file"
        multiple
        accept=".zip,application/zip"
        className="hidden"
        data-testid="download-files"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void read(files);
        }}
      />

      {stage.kind === 'idle' && download ? (
        <div data-testid="download-done">
          <p className="mt-1.5 text-[13px] text-text-2">
            Brought in {day(download.at)}, from a file Facebook made {day(download.madeAt)}.{' '}
            {download.counts.linked.toLocaleString()} of{' '}
            {(download.counts.linked + download.counts.notLinked).toLocaleString()} names match
            people saved here. The rest aren’t saved here yet, or share a name with someone else.
          </p>
          <CountList counts={download.counts} />
          <div className="mt-3">{pickButton('Bring in a newer file', 'secondary')}</div>
        </div>
      ) : null}

      {stage.kind === 'idle' && !download ? (
        <div>
          <p className="mt-1.5 text-[13px] text-text-2">
            Facebook’s download of your information says since when you’ve been friends with each
            person, when each request was sent, who you removed, and when you last messaged each
            person. It’s read here in your browser. Only names and dates are sent, plus the latest
            20 messages of each one-to-one chat, which the AI reads for a summary and your tags on
            the Chats tab.
          </p>
          <details className="mt-2 text-[13px] text-text-2">
            <summary className="cursor-pointer text-accent-text">How to get it</summary>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5">
              <li>
                On Facebook, open Accounts Center, then Your information and permissions, then
                Download your information.
              </li>
              <li>
                Pick Friends and followers, and Messages. Set Date range to All time and Format to
                JSON. Facebook emails you when it’s ready to download.
              </li>
              <li>
                For your newer chats, also download your chat backup: on facebook.com, open
                Messenger at the top right, then Options next to Chats, Chat history, Last backup
                and Download chat backup.
              </li>
              <li>Pick all the zip files here at once.</li>
            </ol>
          </details>
          <div className="mt-3">{pickButton('Pick the files', 'primary')}</div>
        </div>
      ) : null}

      {stage.kind === 'reading' ? (
        <Progress
          done={stage.done}
          all={stage.all}
          label={
            stage.all
              ? `Reading your file: ${stage.done.toLocaleString()} of ${stage.all.toLocaleString()} parts`
              : 'Opening your file…'
          }
        />
      ) : null}

      {stage.kind === 'read' ? (
        <div data-testid="download-read">
          <p className="mt-1.5 text-[13px] text-text-2">
            In your file, made {day(stage.read.madeAt)}:
          </p>
          <CountList counts={countsOf(stage.read)} />
          {stage.read.unread ? (
            <p className="mt-2 text-[12.5px] text-text-3">
              {stage.read.unread.toLocaleString()}{' '}
              {stage.read.unread === 1 ? 'part of it couldn’t' : 'parts of it couldn’t'} be read, so{' '}
              {stage.read.unread === 1 ? 'it’s' : 'they’re'} left out.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void send(stage.read)} data-testid="download-send">
              Bring them in
            </Button>
            {pickButton('Pick other files', 'ghost')}
          </div>
        </div>
      ) : null}

      {stage.kind === 'sending' ? (
        <Progress
          done={stage.done}
          all={stage.all}
          label={
            stage.all > 1
              ? `Bringing it in: part ${(stage.done + 1).toLocaleString()} of ${stage.all.toLocaleString()}`
              : 'Bringing it in…'
          }
        />
      ) : null}

      {stage.kind === 'failed' ? (
        <div>
          <FieldError>{stage.message}</FieldError>
          <div className="mt-3 flex flex-wrap gap-2">
            {stage.read ? (
              <Button
                size="sm"
                onClick={() => void send(stage.read!, stage.importId, stage.from)}
                data-testid="download-retry"
              >
                Try again
              </Button>
            ) : null}
            {pickButton('Pick other files', stage.read ? 'ghost' : 'secondary')}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
