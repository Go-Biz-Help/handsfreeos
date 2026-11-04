'use client';
import { instantOfInput, zonedInputValue } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ZonePick } from '@/components/calendar/zone-field';
import { useBusinessZone } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { editedOnly } from '@/lib/api/edits';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Task } from '@/lib/api/types';
import { useOpenedWith } from '@/lib/use-opened-with';

export interface TaskRelation {
  personId?: string | null;
  companyId?: string | null;
  leadId?: string | null;
  /** A pet, vehicle or property (0101). */
  customRecordId?: string | null;
}

/**
 * Create or edit a task. Due dates are all-day unless a time is added. The date and time read on the business's
 * clock, as the Tasks list shows them, with a Time zone pick for a time set on someone else's (core `zone-pick.ts`).
 */
export function TaskDialog({
  workspaceId,
  open,
  onOpenChange,
  members,
  myUserId,
  relation,
  initial: latest,
  leads,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: { id: string; fullName: string }[];
  myUserId: string;
  relation?: TaskRelation;
  initial?: Task;
  leads?: { id: string; title: string }[];
}) {
  // The record as the dialog opened on it, not as the page shows it now: see useOpenedWith.
  const initial = useOpenedWith(open, latest);
  const router = useRouter();
  const businessZone = useBusinessZone();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [due, setDue] = useState('');
  const [timed, setTimed] = useState(false);
  /** The zone the due date and time are read in: the business's, or another picked under them. */
  const [zone, setZone] = useState(businessZone);
  /** What the due box opened with, so a save that didn't touch it keeps the moment exactly as it was. */
  const [opened, setOpened] = useState({ due: '', timed: false });
  const [assignee, setAssignee] = useState(myUserId);
  const [leadId, setLeadId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? '');
    setNotes(initial?.notes ?? '');
    const isTimed = !!initial?.dueAt && !initial.allDay;
    const openedDue = initial?.dueAt ? zonedInputValue(initial.dueAt, businessZone, !isTimed) : '';
    setTimed(isTimed);
    setDue(openedDue);
    setOpened({ due: openedDue, timed: isTimed });
    setZone(businessZone);
    setAssignee(initial?.assignee?.id ?? myUserId);
    setLeadId(initial?.lead?.id ?? relation?.leadId ?? '');
    setErrors({});
  }, [open, initial, myUserId, relation?.leadId, businessZone]);

  // An all-day task is kept at noon where the business is; a time is read on the picked zone's clock.
  const dueMs = due
    ? instantOfInput(timed ? due : due.slice(0, 10), timed ? zone : businessZone)
    : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setErrors({ title: 'Enter a task.' });
    if (due && dueMs === null) return setErrors({ dueAt: 'Pick a date from the calendar.' });
    setBusy(true);
    setErrors({});
    try {
      const untouched =
        !!initial?.dueAt && due === opened.due && timed === opened.timed && zone === businessZone;
      const dueAt = untouched
        ? new Date(initial.dueAt!).toISOString()
        : dueMs === null
          ? null
          : new Date(dueMs).toISOString();
      const fields = {
        title: title.trim(),
        notes: notes.trim() || null,
        dueAt,
        allDay: !timed,
        assigneeUserId: assignee || null,
        leadId: leadId || null,
      };
      if (initial) {
        // Only what was edited, each with what the dialog opened with: anyone else's change meanwhile stays.
        const edit = editedOnly(
          {
            title: initial.title,
            notes: initial.notes ?? null,
            dueAt: initial.dueAt ? new Date(initial.dueAt).toISOString() : null,
            allDay: initial.allDay,
            assigneeUserId: initial.assignee?.id ?? null,
            leadId: initial.lead?.id ?? null,
          },
          fields,
        );
        if (edit.any)
          unwrap(
            await apiBrowser().POST('/v1/commands/task.update', {
              body: { workspaceId, taskId: initial.id, ...edit.changes, base: edit.base },
            }),
          );
        toast.success('Task saved.');
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/task.create', {
            body: {
              workspaceId,
              ...fields,
              personId: relation?.personId ?? null,
              companyId: relation?.companyId ?? null,
              customRecordId: relation?.customRecordId ?? null,
            },
          }),
        );
        toast.success('Task added.');
      }
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={initial ? 'Edit task' : 'New task'}>
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-3.5"
          noValidate
          data-testid="task-form"
        >
          <Field label="Task" htmlFor="t-title" error={errors.title}>
            <Input
              id="t-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Call about the estimate"
              autoFocus
              invalid={!!errors.title}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Due" htmlFor="t-due" error={errors.dueAt}>
              <Input
                id="t-due"
                type={timed ? 'datetime-local' : 'date'}
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
              <Checkbox
                className="mt-2 text-[13px]"
                label="At a specific time"
                checked={timed}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTimed(next);
                  setDue((d) => (!d ? d : next ? `${d.slice(0, 10)}T09:00` : d.slice(0, 10)));
                }}
              />
            </Field>
            {timed ? (
              <ZonePick
                id="t-zone"
                value={zone}
                onChange={setZone}
                businessZone={businessZone}
                at={dueMs}
                testId="task-zone"
                className="sm:order-last sm:col-span-2"
              />
            ) : null}
            <Field label="Assigned to" htmlFor="t-assignee">
              <Select
                id="t-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === myUserId ? `${m.fullName} (you)` : m.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {leads && leads.length > 0 && !relation?.leadId ? (
            <Field label="Related lead" htmlFor="t-lead">
              <Select id="t-lead" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">None</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Notes" htmlFor="t-notes">
            <Textarea
              id="t-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="task-save">
              {initial ? 'Save task' : 'Add task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
