'use client';
import { FileUp, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { uploadTemplatePdf } from '@/lib/documents/files';

/** A new template: its PDF and its name, then straight into the editor to place the fields. */
export function NewTemplateButton({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function create() {
    if (busy) return;
    if (!name.trim()) {
      setError('Name the template.');
      return;
    }
    setBusy(true);
    setError(null);
    let templateId: string | null = null;
    try {
      const made = unwrap(
        await apiBrowser().POST('/v1/commands/document_template.create', {
          body: { workspaceId, name: name.trim() },
        }),
      );
      templateId = made.templateId;
      if (file) await uploadTemplatePdf(workspaceId, made.templateId, file, made.revision);
      router.push(`/app/w/${workspaceId}/documents/templates/${made.templateId}`);
    } catch (e) {
      if (templateId) {
        // The template is made; its PDF can be added again from the editor.
        toast.error(errorMessage(e));
        router.push(`/app/w/${workspaceId}/documents/templates/${templateId}`);
        return;
      }
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="template-new">
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        New template
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return;
          setOpen(o);
          if (!o) {
            setName('');
            setFile(null);
            setError(null);
          }
        }}
      >
        <DialogContent
          title="New template"
          description="Start from the PDF of your contract or agreement. Next, you put fields on it for each person who signs."
        >
          <div className="mt-4 flex flex-col gap-4">
            <div>
              <input
                ref={input}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f && !name.trim()) setName(f.name.replace(/\.pdf$/i, '').slice(0, 120));
                }}
                data-testid="template-new-file"
              />
              <Button variant="secondary" className="w-full" onClick={() => input.current?.click()}>
                <FileUp className="h-4 w-4" strokeWidth={1.75} />
                {file ? file.name : 'Choose the PDF'}
              </Button>
              <p className="mt-1.5 text-[12.5px] text-text-3">
                Up to 25 MB. You can also add it later.
              </p>
            </div>
            <Field label="Name" htmlFor="template-new-name" error={error}>
              <Input
                id="template-new-name"
                value={name}
                maxLength={120}
                placeholder="Service agreement"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void create()}
                data-testid="template-new-name"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => void create()}
                loading={busy}
                data-testid="template-new-create"
              >
                Make the template
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
