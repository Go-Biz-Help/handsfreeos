'use client';
/**
 * What happened in the field, read-only on the web (round six, boards 89 and 90): a deal's field notes (typed words,
 * a recording's words, photos) and its final walkthrough's list and how each thing was. Both are made on the phone,
 * with or without signal (ops/field.ts); the web shows them on the deal page. Words are core's
 * (@hfos/core/addons/realestate/field-words.ts).
 */
import { fmtAt } from '@hfos/core';
import {
  FIELD_NOTE_ABOUT_WORDS,
  FIELD_NOTE_WORDS,
  WALKTHROUGH_ITEM_WORDS,
  WALKTHROUGH_SOURCE_WORDS,
  WALKTHROUGH_WORDS,
} from '@hfos/core/addons/realestate/field-words';
import { Check, CircleHelp, Mic, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { FileItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { CardHead } from './bits';
import { openFile } from './documents-page';
import { SignedPhoto } from './listing-bits';
import type { FieldNote, Teammate, Walkthrough } from './types';

const SHOWN = 4;

/** A photo on a note or an item: a small square that opens the full one. */
function Thumb({ file, alt }: { file: FileItem | undefined; alt: string }) {
  return (
    <button
      type="button"
      className="h-14 w-14 flex-none overflow-hidden rounded-control border border-border disabled:cursor-default"
      disabled={!file}
      onClick={() => file && openFile(file).catch((e: Error) => toast.error(e.message))}
      aria-label={file ? `Open ${file.name}` : alt}
    >
      <SignedPhoto file={file} alt={alt} className="h-14" />
    </button>
  );
}

export function FieldNotesCard({
  notes,
  files,
  members,
  timeZone,
}: {
  notes: readonly FieldNote[];
  /** The deal's files, for the notes' photos and recordings. */
  files: readonly FileItem[];
  members: readonly Teammate[];
  timeZone: string;
}) {
  const [all, setAll] = useState(false);
  const fileById = new Map(files.map((f) => [f.id, f]));
  const nameOf = new Map(members.map((m) => [m.id, m.fullName]));
  const shown = all ? notes : notes.slice(0, SHOWN);
  return (
    <Card className="p-4 md:p-5" data-testid="deal-field-notes">
      <CardHead title={`${FIELD_NOTE_WORDS.title} · ${notes.length}`} />
      <ul className="divide-y divide-border">
        {shown.map((n) => {
          const audio = n.audioFileId ? fileById.get(n.audioFileId) : undefined;
          return (
            <li key={n.id} className="py-2.5 first:pt-0" data-testid={`field-note-${n.id}`}>
              <div className="text-[12.5px] text-text-3">
                {[
                  fmtAt(n.notedAt, timeZone),
                  FIELD_NOTE_ABOUT_WORDS[n.aboutKind],
                  n.createdBy ? nameOf.get(n.createdBy) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {n.body ? <p className="mt-0.5 whitespace-pre-line text-[13.5px]">{n.body}</p> : null}
              {n.audioFileId ? (
                <div className="mt-1 flex items-start gap-2 text-[13.5px]">
                  <Mic className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                  <div className="min-w-0">
                    {n.transcript ? (
                      <p className="whitespace-pre-line">
                        <span className="text-text-2">{FIELD_NOTE_WORDS.said}: </span>“
                        {n.transcript}”
                      </p>
                    ) : (
                      <p className="text-text-2">
                        {n.transcriptState === 'waiting'
                          ? FIELD_NOTE_WORDS.waiting
                          : n.transcriptState === 'failed'
                            ? FIELD_NOTE_WORDS.failed
                            : null}
                      </p>
                    )}
                    {audio ? (
                      <button
                        type="button"
                        className="text-[12.5px] text-accent-text hover:underline"
                        onClick={() => openFile(audio).catch((e: Error) => toast.error(e.message))}
                      >
                        {FIELD_NOTE_WORDS.recording}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {n.photoFileIds.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {n.photoFileIds.map((id, i) => (
                    <Thumb key={id} file={fileById.get(id)} alt={`Photo ${i + 1}`} />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {notes.length > SHOWN ? (
        <button
          type="button"
          className="mt-1 text-[13px] text-accent-text hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? FIELD_NOTE_WORDS.fewer : FIELD_NOTE_WORDS.more(notes.length)}
        </button>
      ) : null}
      <p className="mt-2 text-[12.5px] text-text-3">{FIELD_NOTE_WORDS.about}</p>
    </Card>
  );
}

function ItemIcon({ state }: { state: Walkthrough['items'][number]['state'] }) {
  const cls = 'mt-0.5 h-[18px] w-[18px] flex-none rounded-full p-[3px]';
  if (state === 'ok')
    return <Check className={cn(cls, 'bg-success text-on-solid')} strokeWidth={2.5} />;
  if (state === 'not_ok')
    return <X className={cn(cls, 'bg-danger text-on-solid')} strokeWidth={2.5} />;
  if (state === 'unsure')
    return <CircleHelp className={cn(cls, 'p-0 text-warning')} strokeWidth={1.75} />;
  return <span className={cn(cls, 'border-[1.5px] border-border-strong')} aria-hidden />;
}

export function WalkthroughCard({
  walkthrough: w,
  files,
  timeZone,
}: {
  walkthrough: Walkthrough;
  files: readonly FileItem[];
  timeZone: string;
}) {
  const [all, setAll] = useState(false);
  const fileById = new Map(files.map((f) => [f.id, f]));
  // What needs a look first: anything not right or not sure; the rest a press away.
  const flagged = w.items.filter((i) => i.state === 'not_ok' || i.state === 'unsure');
  const shown = all || !flagged.length ? w.items : flagged;
  const groups = new Map<string, typeof w.items>();
  for (const i of shown) groups.set(i.source, [...(groups.get(i.source) ?? []), i]);
  const when =
    w.state === 'done' && w.finishedAt
      ? `Finished ${fmtAt(w.finishedAt, timeZone)}`
      : w.state === 'started' && w.startedAt
        ? `Started ${fmtAt(w.startedAt, timeZone)}`
        : w.scheduledAt
          ? fmtAt(w.scheduledAt, timeZone)
          : null;
  return (
    <Card className="p-4 md:p-5" data-testid="deal-walkthrough">
      <CardHead
        title={WALKTHROUGH_WORDS.title}
        action={
          <Badge variant={w.state === 'done' ? 'ok' : w.state === 'started' ? 'pending' : 'gray'}>
            {WALKTHROUGH_WORDS.states[w.state]}
          </Badge>
        }
      />
      <p className="text-[13.5px]" data-testid="walkthrough-summary">
        {w.summary}
      </p>
      <p className="text-[12.5px] text-text-3">
        {[when, w.clientsAgreedAt ? WALKTHROUGH_WORDS.clientsAgreed : null]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <div className="mt-2 space-y-2.5">
        {[...groups].map(([source, items]) => (
          <section key={source}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">
              {WALKTHROUGH_SOURCE_WORDS[source as keyof typeof WALKTHROUGH_SOURCE_WORDS]}
            </h3>
            <ul className="mt-1 space-y-1.5">
              {items.map((i) => (
                <li
                  key={i.id}
                  className="flex items-start gap-2.5"
                  data-testid={`walkthrough-item-${i.id}`}
                >
                  <ItemIcon state={i.state} />
                  <div className="min-w-0 flex-1 text-[13.5px]">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span>{i.title}</span>
                      <span
                        className={cn(
                          'text-[12.5px]',
                          i.state === 'not_ok'
                            ? 'text-danger-text'
                            : i.state === 'unsure'
                              ? 'text-warning-text'
                              : 'text-text-3',
                        )}
                      >
                        {WALKTHROUGH_ITEM_WORDS[i.state]}
                      </span>
                    </div>
                    {[i.note ?? i.detail, i.dutyId ? WALKTHROUGH_WORDS.dutyAdded : null]
                      .filter(Boolean)
                      .map((line) => (
                        <div key={line} className="text-[12.5px] text-text-2">
                          {line}
                        </div>
                      ))}
                    {i.photoFileIds.length ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {i.photoFileIds.map((id, n) => (
                          <Thumb key={id} file={fileById.get(id)} alt={`Photo ${n + 1}`} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {flagged.length && flagged.length < w.items.length ? (
        <button
          type="button"
          className="mt-2 text-[13px] text-accent-text hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? WALKTHROUGH_WORDS.fewer : WALKTHROUGH_WORDS.all(w.items.length)}
        </button>
      ) : null}
      <p className="mt-2 text-[12.5px] text-text-3">{WALKTHROUGH_WORDS.checkedOnPhone}</p>
    </Card>
  );
}
