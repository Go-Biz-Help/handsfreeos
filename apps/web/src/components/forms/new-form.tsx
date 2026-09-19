'use client';
import { FORM_STARTERS, type FormMode } from '@hfos/core';
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
  const [starter, setStarter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/form.create', {
          body: { workspaceId, name: name.trim(), mode, ...(starter ? { starter } : {}) },
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
                  selected={mode === m && !starter}
                  onSelect={() => {
                    setMode(m);
                    setStarter(null);
                  }}
                  title={FORM_MODE_LABELS[m]}
                  description={MODE_BLURB[m]}
                  testId={`form-mode-${m}`}
                />
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 block text-[13px] font-medium text-text">
              Or start from one of these
            </legend>
            <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {FORM_STARTERS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => {
                    setStarter(s.key);
                    setMode(s.mode);
                    if (!name.trim()) setName(s.name);
                  }}
                  className={
                    starter === s.key
                      ? 'w-full rounded-card border border-accent bg-accent/5 px-3 py-2 text-left'
                      : 'w-full rounded-card border border-border px-3 py-2 text-left hover:bg-card-2'
                  }
                  data-testid={`form-starter-${s.key}`}
                >
                  <span className="block text-[13.5px] font-medium text-text">{s.name}</span>
                  <span className="block text-[12.5px] text-text-3">{s.blurb}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={create}
              loading={busy}
              disabled={!name.trim()}
              data-testid="form-create"
            >
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
