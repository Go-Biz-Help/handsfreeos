'use client';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { agencyHref } from '@/lib/agency/org';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/** "New template": a blank one, started by hand with no steps yet, opened in the template editor. */
export function NewTemplateButton({
  organizationId,
  agencyName,
}: {
  organizationId: string;
  agencyName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="template-new">
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        New template
      </Button>
      {open ? (
        <NewTemplateDialog
          onOpenChange={setOpen}
          organizationId={organizationId}
          agencyName={agencyName}
        />
      ) : null}
    </>
  );
}

function NewTemplateDialog({
  onOpenChange,
  organizationId,
  agencyName,
}: {
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  agencyName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const templateName = name.trim();
    if (!templateName) return setError('Give the template a name.');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow_template.create', {
          body: { organizationId, name: templateName, description: description.trim() || null },
        }),
      );
      toast.success(`Created the template “${templateName}”. Pick what starts it, then add steps.`);
      onOpenChange(false);
      router.push(`${agencyHref(organizationId)}/${out.templateId}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="New template"
        description={`A blank template for ${agencyName}. It starts by hand with no steps: build it, publish it, then push it to your client businesses.`}
      >
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-4"
          noValidate
          data-testid="template-new-dialog"
        >
          <Field label="Template name" htmlFor="tpl-new-name" error={error}>
            <Input
              id="tpl-new-name"
              value={name}
              placeholder="Seasonal tune-up reminder"
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              invalid={!!error}
              data-testid="template-new-name"
            />
          </Field>
          <Field label="What it’s for (optional)" htmlFor="tpl-new-description">
            <Textarea
              id="tpl-new-description"
              rows={2}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A reminder text each spring and fall"
              data-testid="template-new-description"
            />
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="template-new-create">
              Create template
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
