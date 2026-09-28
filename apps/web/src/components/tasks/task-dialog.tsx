'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
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
import { toLocalDateValue, toLocalInputValue } from '@/lib/format';
import { useOpenedWith } from '@/lib/use-opened-with';

export interface TaskRelation {
  personId?: string | null;
  companyId?: string | null;
  leadId?: string | null;
  /** A pet, vehicle or property (0101). */
  customRecordId?: string | null;
}

/** Create or edit a task. Due dates are all-day unless a time is added. */
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
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [due, setDue] = useState('');
  const [timed, setTimed] = useState(false);
  const [assignee, setAssignee] = useState(myUserId);
  const [leadId, setLeadId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? '');
    setNotes(initial?.notes ?? '');
    const isTimed = !!initial?.dueAt && !initial.allDay;
    setTimed(isTimed);
    setDue(
      initial?.dueAt
        ? isTimed
          ? toLocalInputValue(new Date(initial.dueAt))
          : toLocalDateValue(new Date(initial.dueAt))
        : '',
    );
    setAssignee(initial?.assignee?.id ?? myUserId);
    setLeadId(initial?.lead?.id ?? relation?.leadId ?? '');
    setErrors({});
  }, [open, initial, myUserId, relation?.leadId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setErrors({ title: 'Enter a task.' });
    setBusy(true);
    setErrors({});
    try {
      const dueAt = due
        ? (timed ? new Date(due) : new Date(`${due}T12:00:00`)).toISOString()
        : null;
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
