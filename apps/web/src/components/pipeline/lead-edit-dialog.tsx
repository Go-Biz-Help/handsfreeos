'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { LeadCard } from '@/lib/api/types';
import { formatMoney, parseMoney } from '@/lib/format';

/** Title, value, assignee, expected close and source of a lead. Stage and next action have their own controls. */
export function LeadEditDialog({
  workspaceId,
  lead,
  open,
  onOpenChange,
  members,
  myUserId,
  onSaved,
}: {
  workspaceId: string;
  lead: LeadCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: { id: string; fullName: string }[];
  myUserId: string;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(lead.title);
  const [value, setValue] = useState(formatMoney(lead.valueCents));
  const [assignee, setAssignee] = useState(lead.assignee?.id ?? '');
  const [closeOn, setCloseOn] = useState(lead.expectedCloseOn ?? '');
  const [source, setSource] = useState(lead.source ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(lead.title);
    setValue(formatMoney(lead.valueCents));
    setAssignee(lead.assignee?.id ?? '');
    setCloseOn(lead.expectedCloseOn ?? '');
    setSource(lead.source ?? '');
    setErrors({});
  }, [open, lead]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(value);
    if (!title.trim()) return setErrors({ title: 'Give the lead a title.' });
    if (cents === null) return setErrors({ valueCents: 'Enter an amount in dollars.' });
    setBusy(true);
    setErrors({});
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/lead.update', {
          body: {
            workspaceId,
            leadId: lead.id,
            title: title.trim(),
            valueCents: cents,
            assigneeUserId: assignee || null,
            expectedCloseOn: closeOn || null,
            source: source.trim() || null,
          },
        }),
      );
      toast.success('Lead saved.');
      onOpenChange(false);
      onSaved?.();
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
      <DialogContent title="Edit lead">
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-3.5"
          noValidate
          data-testid="lead-edit-form"
        >
          <Field label="Title" htmlFor="le-title" error={errors.title}>
            <Input
              id="le-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              invalid={!!errors.title}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Value" htmlFor="le-value" error={errors.valueCents}>
              <Input
                id="le-value"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                invalid={!!errors.valueCents}
              />
            </Field>
            <Field label="Assigned to" htmlFor="le-assignee">
              <Select
                id="le-assignee"
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Expected close" htmlFor="le-close">
              <Input
                id="le-close"
                type="date"
                value={closeOn}
                onChange={(e) => setCloseOn(e.target.value)}
              />
            </Field>
            <Field label="Source" htmlFor="le-source">
              <Input id="le-source" value={source} onChange={(e) => setSource(e.target.value)} />
            </Field>
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="lead-edit-save">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
