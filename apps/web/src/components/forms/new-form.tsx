'use client';
import type { FormMode } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { FORM_MODE_LABELS, MODE_BLURB } from '@/lib/forms/words';

const MODES: FormMode[] = ['form', 'survey', 'quiz'];

/** Name it, say which of the three it is, and open the editor. Everything else is changed later. */
export function NewFormDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<FormMode>('form');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/form.create', {
          body: { workspaceId, name: name.trim(), mode },
        }),
      );
      router.push(`/app/w/${workspaceId}/forms/${out.formId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New form"
        description="You can change any of this later, including which of the three it is."
      >
        <div className="space-y-4">
          <Field label="What is it called?" htmlFor="form-name">
            <Input
              id="form-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Quote request"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
            />
          </Field>
          <fieldset>
            <legend className="mb-1.5 block text-[13px] font-medium text-text">Which kind?</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {MODES.map((m) => (
                <RadioCard
                  key={m}
                  selected={mode === m}
                  onSelect={() => setMode(m)}
                  title={FORM_MODE_LABELS[m]}
                  description={MODE_BLURB[m]}
                  testId={`form-mode-${m}`}
                />
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!name.trim()} data-testid="form-create">
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
