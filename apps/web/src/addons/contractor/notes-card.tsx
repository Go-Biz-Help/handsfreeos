'use client';
/**
 * Notes from the field (docs/contractor.md, "On the phone"): what the crew typed, said or photographed on the job,
 * the newest first. Most come from the phone, with or without signal; the office can type one here. A voice note
 * shows its words once they've come, and its recording and photos open among the job's files. On the job's page
 * it's all the job's notes; on a visit's work order it's that visit's.
 *
 * People take off their own notes, and someone who sets the add-on up anyone's. Its photos and recording stay in
 * the job's files either way.
 */
import { NOTE_LIMITS } from '@hfos/core/addons/contractor/notes';
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { formatDate } from '@hfos/core';
import { Camera, Mic, MoreHorizontal, StickyNote } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { jobRecordHref } from './bits';
import { ConfirmDialog } from './job-dialogs';
import type { FieldNote, NoteList } from './types';
import { useAct } from './use-act';

const N = CONTRACTOR_WORDS.notes;
/** How many notes show before "Show all". */
const FIRST = 5;

/** A visit a note can be on, as the card names it. */
export interface NoteVisit {
  readonly appointmentId: string;
  readonly label: string;
}

export function FieldNotesCard({
  workspaceId,
  jobId,
  notes,
  visits,
  myUserId,
  timeZone,
  forVisit,
}: {
  workspaceId: string;
  jobId: string;
  notes: NoteList;
  /** The job's visits, to say which one a note was taken on. */
  visits: readonly NoteVisit[];
  myUserId: string;
  timeZone: string;
  /** On a visit's work order: the visit, whose notes these are. */
  forVisit?: string;
}) {
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FieldNote | null>(null);
  const list = notes.notes;
  const shown = all ? list : list.slice(0, FIRST);
  const names = new Map(notes.files.map((f) => [f.id, f.name]));
  // A file of the job's opens on core's page for its record.
  const fileHref = (fileId: string) => `${jobRecordHref(workspaceId, jobId)}?file=${fileId}`;
  const visitLabel = (appointmentId: string | null) =>
    appointmentId ? (visits.find((v) => v.appointmentId === appointmentId)?.label ?? null) : null;
  return (
    <Card className="p-0" data-testid="notes-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{forVisit ? N.visitTitle : N.title}</h2>
          <p className="text-[12.5px] text-text-3">{N.hint}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)} data-testid="note-add">
          {N.add}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-text-2" data-testid="notes-none">
          {forVisit ? N.noneForVisit : N.none}
        </p>
      ) : (
        <ul>
          {shown.map((n) => {
            const visit = forVisit ? null : visitLabel(n.appointmentId);
            const mayRemove = notes.may.removeAny || n.by?.userId === myUserId;
            const Icon = n.audio ? Mic : n.body ? StickyNote : Camera;
            return (
              <li
                key={n.id}
                className="flex items-start gap-3 border-b border-border px-5 py-3 last:border-b-0"
                data-testid="note"
              >
                <Icon className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-text-3">
                    <span className="font-medium text-text-2" data-testid="note-by">
                      {n.by?.name ?? N.gone}
                    </span>
                    <span>{formatDate(n.notedAt, { time: true, timeZone })}</span>
                    {visit ? <span>{N.onVisit(visit)}</span> : null}
                    {n.audio ? <Badge variant="gray">{N.voice}</Badge> : null}
                  </div>
                  {n.body ? (
                    <p
                      className="mt-1 whitespace-pre-wrap break-words text-[14px]"
                      data-testid="note-body"
                    >
                      {n.body}
                    </p>
                  ) : null}
                  {n.audio ? (
                    <div className="mt-1 text-[14px]" data-testid="note-voice">
                      {n.audio.transcript ? (
                        <p className="whitespace-pre-wrap break-words">{n.audio.transcript}</p>
                      ) : (
                        <p className="text-[13.5px] text-text-2" data-testid="note-words-state">
                          {n.audio.state === 'failed' ? N.wordsFailed : N.wordsWaiting}
                        </p>
                      )}
                      {n.audio.fileId ? (
                        <Link
                          href={fileHref(n.audio.fileId)}
                          className="mt-0.5 inline-block text-[13px] font-medium text-accent-text hover:underline"
                          data-testid="note-recording"
                        >
                          {N.recording}
                        </Link>
                      ) : (
                        <p className="mt-0.5 text-[12.5px] text-text-3">{N.recordingGone}</p>
                      )}
                    </div>
                  ) : null}
                  {n.photoFileIds.length ? (
                    <div
                      className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1"
                      data-testid="note-photos"
                    >
                      {n.photoFileIds.map((fileId, i) => (
                        <Link
                          key={fileId}
                          href={fileHref(fileId)}
                          className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-text hover:underline"
                          title={names.get(fileId)}
                          data-testid="note-photo"
                        >
                          <Camera className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {N.photo(i + 1)}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
                {mayRemove ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="rounded p-1.5 text-text-3 hover:bg-card-2 hover:text-text"
                        aria-label={N.menu}
                        data-testid="note-menu"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem danger onSelect={() => setRemoving(n)}>
                        {N.remove}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {list.length > FIRST || notes.truncated ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-[12.5px] text-text-2">
          {list.length > FIRST ? (
            <button
              type="button"
              className="hover:text-text hover:underline"
              onClick={() => setAll(!all)}
              data-testid="notes-show-all"
            >
              {all ? N.showFewer : N.showAll(list.length)}
            </button>
          ) : null}
          {notes.truncated && all ? <span>{N.truncated(list.length)}</span> : null}
        </div>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title={N.add} description={N.addHint}>
          {adding ? (
            <NoteForm
              workspaceId={workspaceId}
              jobId={jobId}
              forVisit={forVisit}
              onClose={() => setAdding(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={N.removeTitle}
        description={N.removeAsk}
        submit={N.remove}
        done={N.removed}
        run={async () =>
          removing &&
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.note.remove', {
              body: { workspaceId, noteId: removing.id },
            }),
          )
        }
      />
    </Card>
  );
}

/** A typed note from the office. Photos and voice notes come from the phone. */
function NoteForm({
  workspaceId,
  jobId,
  forVisit,
  onClose,
}: {
  workspaceId: string;
  jobId: string;
  forVisit?: string;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const { busy, errors, act } = useAct(onClose);
  const said = body.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!said) return;
        void act(
          'save',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/contractor.note.add', {
                body: {
                  workspaceId,
                  jobId,
                  body: said,
                  ...(forVisit ? { appointmentId: forVisit } : {}),
                },
              }),
            ),
          N.added,
        );
      }}
    >
      <Field label={N.label} htmlFor="note-body" error={errors.body}>
        <Textarea
          id="note-body"
          rows={4}
          value={body}
          maxLength={NOTE_LIMITS.body}
          placeholder={N.placeholder}
          onChange={(e) => setBody(e.target.value)}
          autoFocus
          data-testid="note-body-input"
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {N.cancel}
        </Button>
        <Button type="submit" loading={busy === 'save'} disabled={!said} data-testid="note-save">
          {N.save}
        </Button>
      </div>
    </form>
  );
}
