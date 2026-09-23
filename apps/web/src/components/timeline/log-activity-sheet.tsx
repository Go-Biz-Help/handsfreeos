'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import { toLocalInputValue } from '@/lib/format';

export type LoggableKind = 'note' | 'call' | 'visit';

const LABELS: Record<LoggableKind, { body: string; placeholder: string; save: string }> = {
  note: { body: 'Note', placeholder: 'What do you want to remember?', save: 'Save note' },
  call: {
    body: 'What was said',
    placeholder: 'Summarize it in a sentence or two',
    save: 'Save call',
  },
  visit: {
    body: 'What happened',
    placeholder: 'Summarize it in a sentence or two',
    save: 'Save visit',
  },
};

/** Logs a note, call or visit on a person, company or lead. Optionally sets the next action on a lead. */
export function LogActivitySheet({
  workspaceId,
  open,
  onOpenChange,
  kind: initialKind,
  recordName,
  record,
  leads,
  onSaved,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: LoggableKind;
  recordName: string;
  record: { personId?: string; companyId?: string; leadId?: string; customRecordId?: string };
  /** Open leads the entry can be attached to (person and company pages). */
  leads?: { id: string; title: string }[];
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<LoggableKind>(initialKind);
  const [body, setBody] = useState('');
  const [when, setWhen] = useState(() => toLocalInputValue(new Date()));
  const [leadId, setLeadId] = useState(record.leadId ?? '');
  const [withNext, setWithNext] = useState(false);
  const [nextText, setNextText] = useState('');
  const [nextAt, setNextAt] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setBody('');
    setWhen(toLocalInputValue(new Date()));
    setLeadId(record.leadId ?? leads?.[0]?.id ?? '');
    setWithNext(false);
    setNextText('');
    setNextAt('');
    setErrors({});
  }, [open, initialKind, record.leadId, leads]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return setErrors({ body: 'Write something.' });
    setBusy(true);
    setErrors({});
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/activity.log', {
          body: {
            workspaceId,
            kind,
            body: body.trim(),
            occurredAt: when ? new Date(when).toISOString() : undefined,
            personId: record.personId ?? null,
            companyId: record.companyId ?? null,
            leadId: leadId || null,
            customRecordId: record.customRecordId ?? null,
          },
        }),
      );
      if (withNext && leadId && nextText.trim()) {
        unwrap(
          await apiBrowser().POST('/v1/commands/lead.set_next_action', {
            body: {
              workspaceId,
              leadId,
              text: nextText.trim(),
              dueAt: nextAt ? new Date(nextAt).toISOString() : null,
            },
          }),
        );
      }
      toast.success(`${kind[0]!.toUpperCase()}${kind.slice(1)} saved.`);
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

  const labels = LABELS[kind];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="Log activity"
        description={`Added to ${recordName}'s timeline and the audit log.`}
      >
        <form
          onSubmit={submit}
          className="flex flex-col gap-4"
          noValidate
          data-testid="log-activity-form"
        >
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'note', label: 'Note' },
              { value: 'call', label: 'Call' },
              { value: 'visit', label: 'Visit' },
            ]}
          />
          <Field label={labels.body} htmlFor="act-body" error={errors.body}>
            <Textarea
              id="act-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={labels.placeholder}
              autoFocus
              invalid={!!errors.body}
              rows={4}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="When" htmlFor="act-when">
              <Input
                id="act-when"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </Field>
            {leads && !record.leadId ? (
              <Field label="Related lead" htmlFor="act-lead">
                <Select id="act-lead" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                  <option value="">None</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.title}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          {leadId ? (
            <div className="flex flex-col gap-3 rounded-menu border border-border p-3">
              <Checkbox
                label="Set a next action from this"
                checked={withNext}
                onChange={(e) => setWithNext(e.target.checked)}
              />
              {withNext ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
                  <Input
                    aria-label="Next action"
                    placeholder="Call back about the estimate"
                    value={nextText}
                    onChange={(e) => setNextText(e.target.value)}
                  />
                  <Input
                    aria-label="When"
                    type="datetime-local"
                    value={nextAt}
                    onChange={(e) => setNextAt(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="activity-save">
              {labels.save}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
