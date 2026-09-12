'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Match, PersonDetail, Tag } from '@/lib/api/types';
import { DuplicateWarning } from './duplicate-warning';
import { TagPicker } from './tag-picker';

interface Form {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  companyId: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  source: string;
  notes: string;
  tagIds: string[];
}

const empty = (companyId = '', phone = '', email = '', name = ''): Form => ({
  firstName: name.trim().split(/\s+/)[0] ?? '',
  lastName: name.trim().split(/\s+/).slice(1).join(' '),
  phone,
  email,
  companyId,
  line1: '',
  city: '',
  state: '',
  postalCode: '',
  source: '',
  notes: '',
  tagIds: [],
});

const fromPerson = (p: PersonDetail): Form => ({
  firstName: p.firstName,
  lastName: p.lastName,
  phone: p.phone ?? '',
  email: p.email ?? '',
  companyId: p.company?.id ?? '',
  line1: p.address.line1 ?? '',
  city: p.address.city ?? '',
  state: p.address.state ?? '',
  postalCode: p.address.postalCode ?? '',
  source: p.source ?? '',
  notes: p.notes ?? '',
  tagIds: p.tags.map((t) => t.id),
});

/** Add or edit a person. Warns about an existing match by phone or email before saving. */
export function PersonDialog({
  workspaceId,
  tags,
  open,
  onOpenChange,
  initial,
  defaultCompanyId,
  defaultPhone,
  defaultEmail,
  defaultName,
  onSaved,
}: {
  workspaceId: string;
  tags: Tag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: PersonDetail;
  defaultCompanyId?: string;
  /** A number to start with (adding the sender of a text as a customer). */
  defaultPhone?: string;
  /** An address and name to start with (adding someone who emailed as a customer). */
  defaultEmail?: string;
  defaultName?: string;
  onSaved?: (personId: string) => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Form>(() =>
    initial
      ? fromPerson(initial)
      : empty(defaultCompanyId, defaultPhone, defaultEmail, defaultName),
  );
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<Match[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(!!initial);

  useEffect(() => {
    if (!open) return;
    setForm(
      initial
        ? fromPerson(initial)
        : empty(defaultCompanyId, defaultPhone, defaultEmail, defaultName),
    );
    setErrors({});
    setMatches([]);
    setMore(!!initial);
    void (async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/company.list', {
            body: { workspaceId, limit: 100 },
          }),
        );
        setCompanies(out.items.map((c) => ({ id: c.id, name: c.name })));
      } catch {
        /* the company select just stays empty */
      }
    })();
  }, [open, initial, defaultCompanyId, workspaceId]);

  // Duplicate check while typing (debounced); a malformed phone is reported on save instead.
  useEffect(() => {
    if (!open) return;
    const email = form.email.trim();
    const phone = form.phone.trim();
    if (!email && !phone) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/crm.find_matches', {
            body: {
              workspaceId,
              kind: 'person',
              email: email || null,
              phone: phone || null,
              ...(initial ? { exceptId: initial.id } : {}),
            },
          }),
        );
        setMatches(out.matches);
      } catch {
        setMatches([]);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [form.email, form.phone, open, workspaceId, initial]);

  const set = (key: keyof Form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((er) => (key in er ? { ...er, [key]: '' } : er));
  };

  async function save(ignoreDuplicates = false) {
    if (!form.firstName.trim() && !form.lastName.trim())
      return setErrors({ firstName: 'Enter a first or last name.' });
    setBusy(true);
    setErrors({});
    try {
      const fields = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        companyId: form.companyId || null,
        address: {
          line1: form.line1.trim() || null,
          city: form.city.trim() || null,
          state: form.state.trim() || null,
          postalCode: form.postalCode.trim() || null,
        },
        source: form.source.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (initial) {
        unwrap(
          await apiBrowser().POST('/v1/commands/person.update', {
            body: { workspaceId, personId: initial.id, ...fields },
          }),
        );
        const before = initial.tags
          .map((t) => t.id)
          .sort()
          .join(',');
        if (before !== [...form.tagIds].sort().join(','))
          unwrap(
            await apiBrowser().POST('/v1/commands/record.set_tags', {
              body: {
                workspaceId,
                recordType: 'person',
                recordId: initial.id,
                tagIds: form.tagIds,
              },
            }),
          );
        toast.success('Saved.');
        onOpenChange(false);
        onSaved?.(initial.id);
        router.refresh();
      } else {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/person.create', {
            body: { workspaceId, ...fields, tagIds: form.tagIds, ignoreDuplicates },
          }),
        );
        toast.success(`${[fields.firstName, fields.lastName].filter(Boolean).join(' ')} added.`);
        onOpenChange(false);
        if (onSaved) onSaved(out.personId);
        else router.push(`/app/w/${workspaceId}/customers/people/${out.personId}`);
        router.refresh();
      }
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'duplicate') {
        setMatches(((e.details as { matches?: Match[] })?.matches ?? []) as Match[]);
      } else {
        const fe = fieldErrors(e);
        if (Object.keys(fe).length) setErrors(fe);
        else toast.error(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={initial ? 'Edit details' : 'Add a person'}
        description={
          initial
            ? undefined
            : 'A phone number or email is enough to start. You can fill in the rest later.'
        }
        className="w-[min(560px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-y-auto"
      >
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-3.5"
          noValidate
          data-testid="person-form"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" htmlFor="p-first" error={errors.firstName}>
              <Input
                id="p-first"
                value={form.firstName}
                onChange={set('firstName')}
                autoFocus={!initial}
                invalid={!!errors.firstName}
                autoComplete="off"
              />
            </Field>
            <Field label="Last name" htmlFor="p-last" error={errors.lastName}>
              <Input
                id="p-last"
                value={form.lastName}
                onChange={set('lastName')}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Phone" htmlFor="p-phone" error={errors.phone}>
              <Input
                id="p-phone"
                type="tel"
                inputMode="tel"
                placeholder="(713) 555-0100"
                value={form.phone}
                onChange={set('phone')}
                invalid={!!errors.phone}
                autoComplete="off"
              />
            </Field>
            <Field label="Email" htmlFor="p-email" error={errors.email}>
              <Input
                id="p-email"
                type="email"
                placeholder="mike@example.com"
                value={form.email}
                onChange={set('email')}
                invalid={!!errors.email}
                autoComplete="off"
              />
            </Field>
          </div>
          {matches.length > 0 ? (
            <DuplicateWarning
              workspaceId={workspaceId}
              kind="person"
              matches={matches}
              onSaveAnyway={initial ? undefined : () => void save(true)}
              saving={busy}
            />
          ) : null}
          <Field label="Company" htmlFor="p-company">
            <Select id="p-company" value={form.companyId} onChange={set('companyId')}>
              <option value="">No company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {form.companyId &&
              !companies.some((c) => c.id === form.companyId) &&
              initial?.company ? (
                <option value={form.companyId}>{initial.company.name}</option>
              ) : null}
            </Select>
          </Field>
          <Field label="Address" htmlFor="p-line1">
            <Input
              id="p-line1"
              placeholder="123 Main St"
              value={form.line1}
              onChange={set('line1')}
              autoComplete="off"
            />
            <div className="mt-2 grid grid-cols-[1fr_72px_96px] gap-2">
              <Input
                aria-label="City"
                placeholder="Houston"
                value={form.city}
                onChange={set('city')}
                autoComplete="off"
              />
              <Input
                aria-label="State"
                placeholder="TX"
                value={form.state}
                onChange={set('state')}
                autoComplete="off"
              />
              <Input
                aria-label="ZIP"
                placeholder="77002"
                value={form.postalCode}
                onChange={set('postalCode')}
                autoComplete="off"
              />
            </div>
          </Field>
          <div>
            <Label>Tags</Label>
            <TagPicker
              workspaceId={workspaceId}
              tags={tags}
              selected={form.tagIds}
              onChange={(ids) => setForm((f) => ({ ...f, tagIds: ids }))}
            />
          </div>
          {more ? (
            <>
              <Field
                label="Source"
                htmlFor="p-source"
                hint="Where they came from: referral, website, yard sign…"
              >
                <Input
                  id="p-source"
                  value={form.source}
                  onChange={set('source')}
                  autoComplete="off"
                />
              </Field>
              <Field label="Notes" htmlFor="p-notes">
                <Textarea
                  id="p-notes"
                  value={form.notes}
                  onChange={set('notes')}
                  placeholder="Gate codes, preferences, anything the team should know."
                />
              </Field>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setMore(true)}
              className="self-start text-[13px] font-medium text-accent-text hover:underline"
            >
              Add source and notes
            </button>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="person-save">
              {initial ? 'Save changes' : 'Save person'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
