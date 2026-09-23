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
import { editedOnly, orNull, saveTagChanges } from '@/lib/api/edits';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Match, PersonDetail, Tag } from '@/lib/api/types';
import {
  addressesOut,
  addressRows,
  emailRows,
  emailsOut,
  listErrorsOf,
  OtherAddresses,
  OtherPoints,
  phoneRows,
  phonesOut,
  storedLists,
  swapMainAddress,
  swapMainPoint,
  type AddressRow,
  type PointRow,
} from './contact-points';
import { DuplicateWarning } from './duplicate-warning';
import { TagPicker } from './tag-picker';

interface Form {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  companyId: string;
  line1: string;
  /** Not shown: carried so a swap with another address moves them too (0100). */
  line2: string;
  country: string;
  city: string;
  state: string;
  postalCode: string;
  /** The other emails, numbers and addresses (0100); a blank row is not saved. */
  otherEmails: PointRow[];
  otherPhones: PointRow[];
  otherAddresses: AddressRow[];
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
  line2: '',
  country: '',
  city: '',
  state: '',
  postalCode: '',
  otherEmails: [],
  otherPhones: [],
  otherAddresses: [],
  source: '',
  notes: '',
  tagIds: [],
});

/** A person's details as the dialog saves them. */
const saveable = (f: Form) => ({
  firstName: f.firstName.trim(),
  lastName: f.lastName.trim(),
  email: orNull(f.email),
  phone: orNull(f.phone),
  companyId: f.companyId || null,
  otherEmails: emailsOut(f.otherEmails),
  otherPhones: phonesOut(f.otherPhones),
  otherAddresses: addressesOut(f.otherAddresses),
  source: orNull(f.source),
  notes: orNull(f.notes),
});
const addressOf = (f: Form) => ({
  line1: orNull(f.line1),
  line2: orNull(f.line2),
  city: orNull(f.city),
  state: orNull(f.state),
  postalCode: orNull(f.postalCode),
  ...(f.country ? { country: f.country } : {}),
});

const fromPerson = (p: PersonDetail): Form => ({
  firstName: p.firstName,
  lastName: p.lastName,
  phone: p.phone ?? '',
  email: p.email ?? '',
  companyId: p.company?.id ?? '',
  line1: p.address.line1 ?? '',
  line2: p.address.line2 ?? '',
  country: p.address.country ?? '',
  city: p.address.city ?? '',
  state: p.address.state ?? '',
  postalCode: p.address.postalCode ?? '',
  otherEmails: emailRows(p.otherEmails),
  otherPhones: phoneRows(p.otherPhones),
  otherAddresses: addressRows(p.otherAddresses),
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
  const [listErrors, setListErrors] = useState<Record<string, string>>({});
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
    setListErrors({});
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

  /** One of the others becomes the main one, and the main one takes its place in the list. */
  const makeMainPoint = (kind: 'phone' | 'email') => (row: PointRow) =>
    setForm((f) => {
      if (kind === 'phone') {
        const { main, list } = swapMainPoint(f.phone, f.otherPhones, row);
        return { ...f, phone: main, otherPhones: list };
      }
      const { main, list } = swapMainPoint(f.email, f.otherEmails, row);
      return { ...f, email: main, otherEmails: list };
    });
  const makeMainAddress = (row: AddressRow) =>
    setForm((f) => {
      const { main, list } = swapMainAddress(f, f.otherAddresses, row);
      return { ...f, ...main, otherAddresses: list };
    });

  async function save(ignoreDuplicates = false) {
    if (!form.firstName.trim() && !form.lastName.trim())
      return setErrors({ firstName: 'Enter a first or last name.' });
    setBusy(true);
    setErrors({});
    setListErrors({});
    try {
      const fields = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        companyId: form.companyId || null,
        address: addressOf(form),
        otherEmails: emailsOut(form.otherEmails),
        otherPhones: phonesOut(form.otherPhones),
        otherAddresses: addressesOut(form.otherAddresses),
        source: form.source.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (initial) {
        // Only what was edited, each with what the dialog opened with (the number as stored, not as shown):
        // anyone else's change meanwhile stays, and the newest change to a detail wins.
        const opened = fromPerson(initial);
        const details = editedOnly(saveable(opened), saveable(form), {
          ...saveable(opened),
          phone: initial.phoneE164 ?? orNull(opened.phone),
          ...storedLists(initial),
        });
        const address = editedOnly(addressOf(opened), addressOf(form));
        if (details.any || address.any)
          unwrap(
            await apiBrowser().POST('/v1/commands/person.update', {
              body: {
                workspaceId,
                personId: initial.id,
                ...details.changes,
                ...(address.any ? { address: address.changes } : {}),
                base: { ...details.base, ...(address.any ? { address: address.base } : {}) },
              },
            }),
          );
        await saveTagChanges(
          workspaceId,
          'person',
          initial.id,
          initial.tags.map((t) => t.id),
          form.tagIds,
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
        const onRows = listErrorsOf(e, form);
        const fe = Object.keys(onRows).length ? {} : fieldErrors(e);
        if (Object.keys(onRows).length) setListErrors(onRows);
        else if (Object.keys(fe).length) setErrors(fe);
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
          <OtherPoints
            kind="phone"
            rows={form.otherPhones}
            onChange={(otherPhones) => setForm((f) => ({ ...f, otherPhones }))}
            onMakeMain={makeMainPoint('phone')}
            errors={listErrors}
          />
          <OtherPoints
            kind="email"
            rows={form.otherEmails}
            onChange={(otherEmails) => setForm((f) => ({ ...f, otherEmails }))}
            onMakeMain={makeMainPoint('email')}
            errors={listErrors}
          />
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
          <OtherAddresses
            rows={form.otherAddresses}
            onChange={(otherAddresses) => setForm((f) => ({ ...f, otherAddresses }))}
            onMakeMain={makeMainAddress}
            errors={listErrors}
          />
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
