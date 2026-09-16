'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { editedOnly, orNull, saveTagChanges } from '@/lib/api/edits';
import { fieldErrors } from '@/lib/api/field-errors';
import type { CompanyDetail, Match, Tag } from '@/lib/api/types';
import { DuplicateWarning } from './duplicate-warning';
import { TagPicker } from './tag-picker';

interface Form {
  name: string;
  phone: string;
  email: string;
  website: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  source: string;
  notes: string;
  tagIds: string[];
}
const empty = (): Form => ({
  name: '',
  phone: '',
  email: '',
  website: '',
  line1: '',
  city: '',
  state: '',
  postalCode: '',
  source: '',
  notes: '',
  tagIds: [],
});
/** A company's details as the dialog saves them. */
const saveable = (f: Form) => ({
  name: f.name.trim(),
  email: orNull(f.email),
  phone: orNull(f.phone),
  website: orNull(f.website),
  source: orNull(f.source),
  notes: orNull(f.notes),
});
const addressOf = (f: Form) => ({
  line1: orNull(f.line1),
  city: orNull(f.city),
  state: orNull(f.state),
  postalCode: orNull(f.postalCode),
});

const fromCompany = (c: CompanyDetail): Form => ({
  name: c.name,
  phone: c.phone ?? '',
  email: c.email ?? '',
  website: c.website ?? '',
  line1: c.address.line1 ?? '',
  city: c.address.city ?? '',
  state: c.address.state ?? '',
  postalCode: c.address.postalCode ?? '',
  source: c.source ?? '',
  notes: c.notes ?? '',
  tagIds: c.tags.map((t) => t.id),
});

export function CompanyDialog({
  workspaceId,
  tags,
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  workspaceId: string;
  tags: Tag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: CompanyDetail;
  onSaved?: (companyId: string) => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Form>(() => (initial ? fromCompany(initial) : empty()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<Match[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(initial ? fromCompany(initial) : empty());
    setErrors({});
    setMatches([]);
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const email = form.email.trim();
    const phone = form.phone.trim();
    const name = form.name.trim();
    if (!email && !phone && name.length < 3) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/crm.find_matches', {
            body: {
              workspaceId,
              kind: 'company',
              email: email || null,
              phone: phone || null,
              name: name || null,
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
  }, [form.email, form.phone, form.name, open, workspaceId, initial]);

  const set = (key: keyof Form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((er) => (key in er ? { ...er, [key]: '' } : er));
  };

  async function save(ignoreDuplicates = false) {
    if (!form.name.trim()) return setErrors({ name: 'Enter a company name.' });
    setBusy(true);
    setErrors({});
    try {
      const fields = {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        website: form.website.trim() || null,
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
        // Only what was edited, each with what the dialog opened with (the number as stored, not as shown):
        // anyone else's change meanwhile stays, and the newest change to a detail wins.
        const opened = fromCompany(initial);
        const details = editedOnly(saveable(opened), saveable(form), {
          ...saveable(opened),
          phone: initial.phoneE164 ?? orNull(opened.phone),
        });
        const address = editedOnly(addressOf(opened), addressOf(form));
        if (details.any || address.any)
          unwrap(
            await apiBrowser().POST('/v1/commands/company.update', {
              body: {
                workspaceId,
                companyId: initial.id,
                ...details.changes,
                ...(address.any ? { address: address.changes } : {}),
                base: { ...details.base, ...(address.any ? { address: address.base } : {}) },
              },
            }),
          );
        await saveTagChanges(
          workspaceId,
          'company',
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
          await apiBrowser().POST('/v1/commands/company.create', {
            body: { workspaceId, ...fields, tagIds: form.tagIds, ignoreDuplicates },
          }),
        );
        toast.success(`${fields.name} added.`);
        onOpenChange(false);
        if (onSaved) onSaved(out.companyId);
        else router.push(`/app/w/${workspaceId}/customers/companies/${out.companyId}`);
        router.refresh();
      }
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'duplicate')
        setMatches(((e.details as { matches?: Match[] })?.matches ?? []) as Match[]);
      else {
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
        title={initial ? 'Edit details' : 'Add a company'}
        description={
          initial ? undefined : 'The business you work with. People can be linked to it afterwards.'
        }
        className="w-[min(560px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-y-auto"
      >
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-3.5"
          noValidate
          data-testid="company-form"
        >
          <Field label="Company name" htmlFor="c-name" error={errors.name}>
            <Input
              id="c-name"
              value={form.name}
              onChange={set('name')}
              autoFocus={!initial}
              invalid={!!errors.name}
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Phone" htmlFor="c-phone" error={errors.phone}>
              <Input
                id="c-phone"
                type="tel"
                inputMode="tel"
                placeholder="(713) 555-0100"
                value={form.phone}
                onChange={set('phone')}
                invalid={!!errors.phone}
                autoComplete="off"
              />
            </Field>
            <Field label="Email" htmlFor="c-email" error={errors.email}>
              <Input
                id="c-email"
                type="email"
                placeholder="office@example.com"
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
              kind="company"
              matches={matches}
              onSaveAnyway={initial ? undefined : () => void save(true)}
              saving={busy}
            />
          ) : null}
          <Field label="Website" htmlFor="c-web">
            <Input
              id="c-web"
              placeholder="example.com"
              value={form.website}
              onChange={set('website')}
              autoComplete="off"
            />
          </Field>
          <Field label="Address" htmlFor="c-line1">
            <Input
              id="c-line1"
              placeholder="4100 Kirby Dr"
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
                placeholder="77098"
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
          <Field label="Source" htmlFor="c-source">
            <Input id="c-source" value={form.source} onChange={set('source')} autoComplete="off" />
          </Field>
          <Field label="Notes" htmlFor="c-notes">
            <Textarea id="c-notes" value={form.notes} onChange={set('notes')} />
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="company-save">
              {initial ? 'Save changes' : 'Save company'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
