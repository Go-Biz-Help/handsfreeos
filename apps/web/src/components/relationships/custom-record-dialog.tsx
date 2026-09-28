'use client';
import { lowerLabel } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { FieldInput } from '@/components/crm/custom-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { editedOnly, orNull } from '@/lib/api/edits';
import { fieldErrors } from '@/lib/api/field-errors';
import type { CustomField, CustomRecordDetail } from '@/lib/api/types';
import { useOpenedWith } from '@/lib/use-opened-with';

interface Kind {
  readonly id: string;
  readonly singular: string;
  readonly nameLabel: string;
}

/**
 * Add a record of one of the business's own kinds (a pet, a vehicle, a property) with its fields, or change an
 * existing one's name and notes. A new one opens on its own page, where it can be related to its owners.
 */
export function CustomRecordDialog({
  workspaceId,
  kind,
  fields = [],
  initial: latest,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  kind: Kind;
  /** The kind's fields, filled in as it's added (editing them is the Fields section's). */
  fields?: CustomField[];
  initial?: CustomRecordDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The record as the dialog opened on it, not as the page shows it now: see useOpenedWith.
  const initial = useOpenedWith(open, latest);
  const router = useRouter();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string | string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setNotes(initial?.notes ?? '');
    setDrafts({});
    setErrors({});
  }, [open, initial]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErrors({ name: 'Enter a name.' });
    setBusy(true);
    setErrors({});
    try {
      if (initial) {
        const edit = editedOnly(
          { name: initial.name, notes: initial.notes ?? null },
          { name: name.trim(), notes: orNull(notes) },
        );
        if (edit.any)
          unwrap(
            await apiBrowser().POST('/v1/commands/custom_record.update', {
              body: { workspaceId, customRecordId: initial.id, ...edit.changes, base: edit.base },
            }),
          );
        toast.success('Saved.');
        onOpenChange(false);
        router.refresh();
        return;
      }
      const values = Object.fromEntries(
        Object.entries(drafts).filter(([, v]) => (Array.isArray(v) ? v.length : v.trim())),
      );
      const made = unwrap(
        await apiBrowser().POST('/v1/commands/custom_record.create', {
          body: { workspaceId, typeId: kind.id, name: name.trim(), notes: orNull(notes), values },
        }),
      );
      toast.success(`${kind.singular} added.`);
      onOpenChange(false);
      router.push(`/app/w/${workspaceId}/customers/records/${made.customRecordId}`);
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
      <DialogContent
        title={initial ? `Edit ${lowerLabel(kind.singular)}` : `Add ${lowerLabel(kind.singular)}`}
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          onSubmit={submit}
          className="mt-4 flex max-h-[70vh] flex-col gap-3.5 overflow-y-auto pr-1"
          noValidate
          data-testid="custom-record-form"
        >
          <Field label={kind.nameLabel} htmlFor="custom-record-name" error={errors.name}>
            <Input
              id="custom-record-name"
              value={name}
              maxLength={160}
              autoFocus
              invalid={!!errors.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {initial
            ? null
            : fields.map((f) => (
                <FieldInput
                  key={f.id}
                  field={f}
                  value={drafts[f.id] ?? (f.type === 'multi_choice' ? [] : '')}
                  error={errors[f.id]}
                  onChange={(v) => setDrafts((d) => ({ ...d, [f.id]: v }))}
                />
              ))}
          <Field label="Notes" htmlFor="custom-record-notes" error={errors.notes}>
            <Textarea
              id="custom-record-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <div className="sticky bottom-0 flex justify-end gap-2 bg-card pt-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="custom-record-save">
              {initial ? 'Save' : `Add ${lowerLabel(kind.singular)}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
