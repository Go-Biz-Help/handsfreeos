'use client';
import { customValueIsEmpty, customValueText, hasOptions, RECORD_WORDS } from '@hfos/core';
import { Pencil } from 'lucide-react';
import Link from 'next/link';
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
import { fieldErrors } from '@/lib/api/field-errors';
import type { CustomField } from '@/lib/api/types';

type FieldedRecord = 'person' | 'company' | 'lead' | 'custom_record';

/** A field's value as its input holds it: text for most, a list for several choices. */
type Draft = string | string[];

function toDraft(field: CustomField, value: unknown): Draft {
  if (customValueIsEmpty(value)) return field.type === 'multi_choice' ? [] : '';
  if (field.type === 'multi_choice')
    return Array.isArray(value) ? value.map(String) : [String(value)];
  if (field.type === 'boolean') return value === true ? 'true' : value === false ? 'false' : '';
  return String(value);
}

/** What the draft sends: nothing clears it, the rest is checked (and put in shape) on the server. */
function fromDraft(field: CustomField, draft: Draft): unknown {
  if (Array.isArray(draft)) return draft.length ? draft : null;
  if (!draft.trim()) return null;
  if (field.type === 'boolean') return draft === 'true';
  return draft;
}

/**
 * The fields a business invented, on one record's Details: the ones filled in, and the ones set to show even
 * when empty. Edit fills them in; owners and admins also get the way to Settings → Fields.
 */
export function CustomFieldsSection({
  workspaceId,
  recordType,
  recordId,
  fields,
  values,
  canEdit,
  manageHref,
}: {
  workspaceId: string;
  recordType: FieldedRecord;
  recordId: string;
  fields: CustomField[];
  values: Record<string, unknown>;
  canEdit: boolean;
  /** Where owners and admins change the fields themselves; nothing for everyone else. */
  manageHref?: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const shown = fields.filter((f) => f.alwaysShow || !customValueIsEmpty(values[f.id]));
  if (!fields.length && !manageHref) return null;
  return (
    <section className="mt-5 border-t border-border pt-4" data-testid="custom-fields">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">Fields</h3>
        <div className="flex items-center gap-2">
          {manageHref ? (
            <Link href={manageHref} className="text-[13px] text-accent-text hover:underline">
              Manage fields
            </Link>
          ) : null}
          {canEdit && fields.length ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="custom-fields-edit"
            >
              <Pencil className="h-4 w-4" strokeWidth={1.5} />
              {RECORD_WORDS.edit}
            </Button>
          ) : null}
        </div>
      </div>
      {!fields.length ? (
        <p className="text-[13px] text-text-2">
          No fields yet. Add the details you keep, like a gate code or a breed.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-text-2">Nothing filled in yet.</p>
      ) : (
        <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 text-[13.5px] md:grid-cols-[130px_1fr]">
          {shown.map((f) => (
            <FieldRow key={f.id} field={f} value={values[f.id]} />
          ))}
        </dl>
      )}
      {editing ? (
        <CustomFieldsDialog
          workspaceId={workspaceId}
          recordType={recordType}
          recordId={recordId}
          fields={fields}
          values={values}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </section>
  );
}

function FieldRow({ field, value }: { field: CustomField; value: unknown }) {
  const text = customValueText(field, value);
  return (
    <>
      <dt className="text-text-2">{field.label}</dt>
      <dd
        className={field.type === 'long_text' ? 'whitespace-pre-wrap' : 'break-words font-medium'}
        data-testid={`custom-field-${field.key}`}
      >
        {text === null ? (
          RECORD_WORDS.none
        ) : field.type === 'url' ? (
          <a
            href={String(value)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent-text hover:underline"
          >
            {text}
          </a>
        ) : (
          text
        )}
      </dd>
    </>
  );
}

/** Fill in a record's fields. Only what changed is sent, with what the dialog opened with. */
export function CustomFieldsDialog({
  workspaceId,
  recordType,
  recordId,
  fields,
  values,
  onClose,
}: {
  workspaceId: string;
  recordType: FieldedRecord;
  recordId: string;
  fields: CustomField[];
  values: Record<string, unknown>;
  onClose: () => void;
}) {
  const router = useRouter();
  const opened = Object.fromEntries(fields.map((f) => [f.id, toDraft(f, values[f.id])]));
  const [drafts, setDrafts] = useState<Record<string, Draft>>(opened);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => setErrors({}), [drafts]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const changed = fields.filter(
      (f) => JSON.stringify(drafts[f.id]) !== JSON.stringify(opened[f.id]),
    );
    if (!changed.length) return onClose();
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/record.set_fields', {
          body: {
            workspaceId,
            recordType,
            recordId,
            values: Object.fromEntries(changed.map((f) => [f.id, fromDraft(f, drafts[f.id]!)])),
            base: Object.fromEntries(changed.map((f) => [f.id, values[f.id] ?? null])),
          },
        }),
      );
      toast.success('Saved.');
      onClose();
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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Edit fields" className="w-[min(560px,calc(100vw-32px))]">
        <form
          onSubmit={save}
          className="mt-4 flex max-h-[70vh] flex-col gap-3.5 overflow-y-auto pr-1"
          noValidate
          data-testid="custom-fields-form"
        >
          {fields.map((f) => (
            <FieldInput
              key={f.id}
              field={f}
              value={drafts[f.id]!}
              error={errors[f.id]}
              onChange={(v) => setDrafts((d) => ({ ...d, [f.id]: v }))}
            />
          ))}
          <div className="sticky bottom-0 flex justify-end gap-2 bg-card pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="custom-fields-save">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One field's input, by its type. */
export function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: CustomField;
  value: Draft;
  error?: string;
  onChange: (value: Draft) => void;
}) {
  const id = `field-${field.id}`;
  const text = typeof value === 'string' ? value : '';
  const hint = field.help || undefined;
  if (field.type === 'multi_choice') {
    const picked = Array.isArray(value) ? value : [];
    return (
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium text-text">{field.label}</legend>
        <div className="flex flex-col gap-1.5">
          {field.options.map((o) => (
            <Checkbox
              key={o.value}
              label={o.label}
              checked={picked.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...picked, o.value] : picked.filter((v) => v !== o.value),
                )
              }
            />
          ))}
        </div>
        {error ? (
          <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
            {error}
          </p>
        ) : hint ? (
          <p className="mt-1.5 text-[12.5px] text-text-3">{hint}</p>
        ) : null}
      </fieldset>
    );
  }
  return (
    <Field label={field.label} htmlFor={id} hint={hint} error={error}>
      {field.type === 'long_text' ? (
        <Textarea id={id} rows={3} value={text} onChange={(e) => onChange(e.target.value)} />
      ) : hasOptions(field.type) ? (
        <Select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">{RECORD_WORDS.none}</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : field.type === 'boolean' ? (
        <Select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">{RECORD_WORDS.none}</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      ) : (
        <Input
          id={id}
          type={
            field.type === 'date'
              ? 'date'
              : field.type === 'email'
                ? 'email'
                : field.type === 'url'
                  ? 'url'
                  : field.type === 'phone'
                    ? 'tel'
                    : 'text'
          }
          inputMode={field.type === 'number' || field.type === 'money' ? 'decimal' : undefined}
          placeholder={field.type === 'money' ? '$0.00' : undefined}
          value={text}
          invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
