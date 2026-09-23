'use client';
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  hasOptions,
  type CustomFieldType,
} from '@hfos/core';
import { Archive, ArrowDown, ArrowUp, Pencil, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { RecordIcon } from '@/components/relationships/record-icon';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, FieldError } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { CustomField } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

/** Whose fields the page is showing: customers, companies, or one kind of record. */
export interface FieldTarget {
  /** What `?for=` holds: person, company, or the kind's id. */
  readonly key: string;
  readonly label: string;
  /** One of them, in a sentence: "customer", "pet". */
  readonly one: string;
  readonly entity: 'person' | 'company' | 'custom_record';
  readonly recordTypeId: string | null;
  readonly icon: string;
}

/**
 * Settings → Fields: the details a business keeps that HandsFreeOS doesn't ask for, on customers, companies and
 * each kind of record. Filled in under Details on each record; the order here is the order there.
 */
export function FieldsSettings({
  workspaceId,
  targets,
  target,
  fields,
}: {
  workspaceId: string;
  targets: FieldTarget[];
  target: FieldTarget;
  fields: CustomField[];
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ field?: CustomField } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useLiveRefresh(['custom_field', 'custom_record_type']);

  async function call(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Swaps a field with its neighbour, numbering the list from 0 so fields that shared a place get their own. */
  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= fields.length) return;
    const order = fields.slice();
    [order[index], order[j]] = [order[j]!, order[index]!];
    const moved = order
      .map((f, position) => ({ f, position }))
      .filter(({ f, position }) => f.position !== position);
    void call(`move-${fields[index]!.id}`, async () => {
      for (const { f, position } of moved)
        unwrap(
          await apiBrowser().POST('/v1/commands/custom_field.update', {
            body: { workspaceId, customFieldId: f.id, position },
          }),
        );
    });
  }

  function retire(f: CustomField) {
    if (
      !confirm(
        `Retire “${f.label}”? It comes off every ${target.one} that has it filled in, and can’t be brought back.`,
      )
    )
      return;
    void call(
      `archive-${f.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/custom_field.archive', {
            body: { workspaceId, customFieldId: f.id },
          }),
        ),
      `${f.label} retired.`,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Fields</h2>
          <p className="max-w-[640px] text-[13px] text-text-2">
            The details you keep that aren’t already here: a gate code, a breed, an account number.
            They show under Details on each record, in this order.
          </p>
        </div>
        <Button onClick={() => setDialog({})} data-testid="field-new">
          <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
          Add field
        </Button>
      </div>

      <nav aria-label="Fields for" className="flex flex-wrap gap-1.5" data-testid="field-targets">
        {targets.map((t) => {
          const active = t.key === target.key;
          return (
            <Link
              key={t.key}
              href={`/app/w/${workspaceId}/settings/fields?for=${t.key}`}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium',
                active
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-border text-text-2 hover:bg-card-2 hover:text-text',
              )}
            >
              {t.entity === 'custom_record' ? (
                <RecordIcon icon={t.icon} className="h-4 w-4 rounded-[4px] bg-transparent" />
              ) : null}
              {t.label}
            </Link>
          );
        })}
      </nav>

      <Card className="overflow-hidden">
        {fields.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-text-2">
            No fields for {target.label.toLowerCase()} yet.
          </p>
        ) : (
          <ul className="divide-y divide-border" data-testid="fields-list">
            {fields.map((f, i) => (
              <li
                key={f.id}
                className="flex items-center gap-2 px-5 py-3"
                data-testid={`field-row-${f.key}`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{f.label}</span>
                  <span className="text-xs text-text-3">
                    {CUSTOM_FIELD_TYPE_LABELS[f.type]}
                    {hasOptions(f.type)
                      ? `: ${f.options
                          .slice(0, 4)
                          .map((o) => o.label)
                          .join(', ')}${f.options.length > 4 ? '…' : ''}`
                      : ''}
                    {f.alwaysShow ? ' · shows even when empty' : ''}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={i === 0 || !!busy}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${f.label} up`}
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={1.5} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={i === fields.length - 1 || !!busy}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${f.label} down`}
                >
                  <ArrowDown className="h-4 w-4" strokeWidth={1.5} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDialog({ field: f })}
                  aria-label={`Edit ${f.label}`}
                >
                  <Pencil className="h-4 w-4" strokeWidth={1.5} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  loading={busy === `archive-${f.id}`}
                  onClick={() => retire(f)}
                  aria-label={`Retire ${f.label}`}
                >
                  <Archive className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {dialog ? (
        <FieldDialog
          workspaceId={workspaceId}
          target={target}
          field={dialog.field}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

interface ChoiceDraft {
  /** Kept for a choice the field already has, so records that picked it still read it. */
  readonly value?: string;
  readonly label: string;
}

function FieldDialog({
  workspaceId,
  target,
  field,
  onClose,
}: {
  workspaceId: string;
  target: FieldTarget;
  field?: CustomField;
  onClose: () => void;
}) {
  const router = useRouter();
  const [label, setLabel] = useState(field?.label ?? '');
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text');
  const [choices, setChoices] = useState<ChoiceDraft[]>(
    field?.options.length ? field.options.map((o) => ({ ...o })) : [{ label: '' }, { label: '' }],
  );
  const [help, setHelp] = useState(field?.help ?? '');
  const [alwaysShow, setAlwaysShow] = useState(field?.alwaysShow ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const listed = hasOptions(type);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) return setErrors({ label: 'Name the field.' });
    const options = choices.map((c) => ({ ...c, label: c.label.trim() })).filter((c) => c.label);
    if (listed && !options.length) return setErrors({ options: 'Add at least one choice.' });
    setBusy(true);
    setErrors({});
    try {
      if (field) {
        unwrap(
          await apiBrowser().POST('/v1/commands/custom_field.update', {
            body: {
              workspaceId,
              customFieldId: field.id,
              label: label.trim(),
              ...(listed ? { options } : {}),
              help: help.trim(),
              alwaysShow,
            },
          }),
        );
        toast.success('Saved.');
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/custom_field.create', {
            body: {
              workspaceId,
              entity: target.entity,
              recordTypeId: target.recordTypeId,
              label: label.trim(),
              type,
              ...(listed ? { options } : {}),
              help: help.trim() || undefined,
              alwaysShow,
            },
          }),
        );
        toast.success(`${label.trim()} added.`);
      }
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
      <DialogContent
        title={field ? `Edit ${field.label}` : `Add a field for ${target.label.toLowerCase()}`}
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          onSubmit={save}
          className="mt-4 flex max-h-[70vh] flex-col gap-3.5 overflow-y-auto pr-1"
          noValidate
          data-testid="field-form"
        >
          <Field label="Name" htmlFor="field-label" error={errors.label}>
            <Input
              id="field-label"
              value={label}
              maxLength={60}
              autoFocus
              invalid={!!errors.label}
              placeholder="Gate code, Breed, Account number…"
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field
            label="What it holds"
            htmlFor="field-type"
            hint={field ? 'This stays as it is, so what’s filled in keeps its meaning.' : undefined}
          >
            <Select
              id="field-type"
              value={type}
              disabled={!!field}
              onChange={(e) => setType(e.target.value as CustomFieldType)}
            >
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CUSTOM_FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {listed ? (
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium text-text">Choices</legend>
              <ul className="flex flex-col gap-1.5">
                {choices.map((c, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <Input
                      value={c.label}
                      maxLength={80}
                      aria-label={`Choice ${i + 1}`}
                      onChange={(e) =>
                        setChoices((list) =>
                          list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={choices.length === 1}
                      onClick={() => setChoices((list) => list.filter((_, j) => j !== i))}
                      aria-label={`Remove choice ${i + 1}`}
                    >
                      <X className="h-4 w-4" strokeWidth={1.5} />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1.5"
                onClick={() => setChoices((list) => [...list, { label: '' }])}
              >
                <Plus className="h-4 w-4" strokeWidth={1.5} />
                Add choice
              </Button>
              <FieldError>{errors.options}</FieldError>
            </fieldset>
          ) : null}
          <Field label="Help (optional)" htmlFor="field-help" error={errors.help}>
            <Input
              id="field-help"
              value={help}
              maxLength={200}
              placeholder="Shown under the field while it’s filled in"
              onChange={(e) => setHelp(e.target.value)}
            />
          </Field>
          <Checkbox
            label={`Show on every ${target.one}, even when it’s empty`}
            checked={alwaysShow}
            onChange={(e) => setAlwaysShow(e.target.checked)}
          />
          <div className="sticky bottom-0 flex justify-end gap-2 bg-card pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="field-save">
              {field ? 'Save' : 'Add field'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
