'use client';
/**
 * The agency's saved answers for quick setup (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §9): the answers one
 * client business was set up with, kept so the others start quick setup from them. Saved from quick setup's last
 * screen or here, renamed and removed here. Removing them changes no business.
 */
import { AI_SETUP_MAX, formatDate, SETUP_KIND_LABELS } from '@hfos/core';
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AiSetupTemplate } from '@/lib/api/types';

type Business = { readonly id: string; readonly name: string };
const NAME_MAX = AI_SETUP_MAX.templateName;

export function AiSetupBoard({
  organizationId,
  setups,
  businesses,
}: {
  organizationId: string;
  setups: readonly AiSetupTemplate[];
  businesses: readonly Business[];
}) {
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<AiSetupTemplate | null>(null);
  const [removing, setRemoving] = useState<AiSetupTemplate | null>(null);

  return (
    <>
      <PageHeader
        title="AI setups"
        description="Answers from quick setup your businesses start from: what the AI teammate helps with, when it answers, its name, tone, prices and questions for leads. A business setting up its teammate starts from the newest saved for its kind, and can pick another on the first screen."
        actions={
          <Button onClick={() => setSaving(true)} data-testid="ai-setups-save">
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Save from a business
          </Button>
        }
      />
      {setups.length ? (
        <Card className="overflow-hidden" data-testid="ai-setups-list">
          {setups.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0 md:px-[18px]"
              data-testid={`ai-setup-row-${s.id}`}
            >
              <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] bg-accent-soft text-accent-text">
                <Sparkles className="h-[15px] w-[15px]" strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold">{s.name}</span>
                  <Badge className="h-5 text-[11.5px]">{SETUP_KIND_LABELS[s.kind]}</Badge>
                </span>
                {s.about ? <span className="text-xs text-text-2">{s.about}</span> : null}
                <span className="text-xs text-text-3">
                  {s.from ? `From ${s.from.name} · ` : ''}Saved {formatDate(s.updatedAt)}
                </span>
              </span>
              <span className="flex flex-none gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setRenaming(s)}
                  data-testid={`ai-setup-rename-${s.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoving(s)}
                  aria-label={`Remove ${s.name}`}
                  data-testid={`ai-setup-remove-${s.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </Button>
              </span>
            </div>
          ))}
        </Card>
      ) : (
        <Card data-testid="ai-setups-empty">
          <EmptyState
            title="No saved AI setups yet"
            actions={
              <Button size="sm" onClick={() => setSaving(true)}>
                Save from a business
              </Button>
            }
          >
            Set up the AI teammate in one of your businesses with quick setup, then save its answers
            from the last screen or here. Your other businesses start from them.
          </EmptyState>
        </Card>
      )}
      {saving ? (
        <SaveDialog
          organizationId={organizationId}
          businesses={businesses}
          onClose={() => setSaving(false)}
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          organizationId={organizationId}
          setup={renaming}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      {removing ? (
        <RemoveDialog
          organizationId={organizationId}
          setup={removing}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}

/** Saves the answers a business was set up with. */
function SaveDialog({
  organizationId,
  businesses,
  onClose,
}: {
  organizationId: string;
  businesses: readonly Business[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!businessId) return setError('Pick a business.');
    if (!name.trim()) return setError('Name these answers.');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/ai_setup_template.save', {
          body: { organizationId, workspaceId: businessId, name: name.trim() },
        }),
      );
      toast.success(`Saved as “${out.name}”.`);
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title="Save a business’s AI setup"
        description="Saves what its AI teammate helps with, when it answers, its name, how it says it’s AI, its tone, prices and questions for leads. Nothing about the business itself is saved."
      >
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
          <Field label="Business" htmlFor="ai-setups-business">
            <Select
              id="ai-setups-business"
              value={businessId}
              onChange={(e) => {
                setBusinessId(e.target.value);
                setError(null);
              }}
              data-testid="ai-setups-business"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name" htmlFor="ai-setups-name" error={error}>
            <Input
              id="ai-setups-name"
              value={name}
              placeholder="Home services"
              maxLength={NAME_MAX}
              invalid={!!error}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              data-testid="ai-setups-name"
            />
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="ai-setups-save-confirm">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  organizationId,
  setup,
  onClose,
}: {
  organizationId: string;
  setup: AiSetupTemplate;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(setup.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Name these answers.');
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/ai_setup_template.rename', {
          body: { organizationId, templateId: setup.id, name: name.trim() },
        }),
      );
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent title={`Rename “${setup.name}”`}>
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
          <Field label="Name" htmlFor="ai-setups-rename" error={error}>
            <Input
              id="ai-setups-rename"
              value={name}
              maxLength={NAME_MAX}
              invalid={!!error}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              data-testid="ai-setups-rename-name"
            />
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="ai-setups-rename-confirm">
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  organizationId,
  setup,
  onClose,
}: {
  organizationId: string;
  setup: AiSetupTemplate;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/ai_setup_template.delete', {
          body: { organizationId, templateId: setup.id },
        }),
      );
      toast.success(`Removed “${setup.name}”.`);
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={`Remove “${setup.name}”?`}
        description="Your businesses can’t start from these answers anymore. Businesses already set up from them keep their answers."
      >
        {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            loading={busy}
            data-testid="ai-setups-remove-confirm"
          >
            Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
