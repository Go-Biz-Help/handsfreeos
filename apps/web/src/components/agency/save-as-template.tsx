'use client';
import { hasOrgPermission } from '@hfos/core';
import { Building2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { agencyHref } from '@/lib/agency/org';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Me, WorkflowSummary } from '@/lib/api/types';

let meOnce: Promise<Me> | null = null;
/** Who is signed in, with their organizations and businesses: fetched once a page load. */
function loadMe(): Promise<Me> {
  meOnce ??= apiBrowser()
    .POST('/v1/queries/account.me', { body: {} })
    .then((r) => unwrap(r))
    .catch((e: unknown) => {
      meOnce = null;
      throw e;
    });
  return meOnce;
}

/** The agency a business belongs to, when the person looking runs its agency area. */
function useAgencyOf(workspaceId: string): { id: string; name: string } | null {
  const [agency, setAgency] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMe()
      .then((me) => {
        if (cancelled) return;
        const ws = me.workspaces.find((w) => w.id === workspaceId);
        const org = me.organizations.find(
          (o) => o.id === ws?.organizationId && hasOrgPermission(o.role, 'org.templates.manage'),
        );
        setAgency(org ? { id: org.id, name: org.name } : null);
      })
      .catch(() => {
        // No button then; nothing else depends on it.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return agency;
}

/** "Save as template" in a workflow's editor, for the business's agency owners and admins. */
export function SaveAsTemplateButton({
  workspaceId,
  workflowId,
  workflowName,
}: {
  workspaceId: string;
  workflowId: string;
  workflowName: string;
}) {
  const agency = useAgencyOf(workspaceId);
  const [open, setOpen] = useState(false);
  if (!agency) return null;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        title={`Save a copy as a ${agency.name} template`}
        data-testid="save-as-template"
      >
        <Building2 className="h-4 w-4" strokeWidth={1.5} />
        Save as template
      </Button>
      {open ? (
        <SaveAsTemplateDialog
          onOpenChange={setOpen}
          organizationId={agency.id}
          agencyName={agency.name}
          fixed={{ workflowId, workflowName }}
        />
      ) : null}
    </>
  );
}

/**
 * Saves one business's workflow as an agency template: its stages, tags, calendars and people become
 * details each business matches when it's pushed. From a workflow's editor (`fixed`), or from the Templates
 * page, where you pick the business and then the workflow.
 */
export function SaveAsTemplateDialog({
  onOpenChange,
  organizationId,
  agencyName,
  fixed,
  businesses = [],
}: {
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  agencyName: string;
  fixed?: { workflowId: string; workflowName: string };
  businesses?: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? '');
  const [loaded, setLoaded] = useState<{ businessId: string; items: WorkflowSummary[] } | null>(
    null,
  );
  const [picked, setPicked] = useState('');
  const [name, setName] = useState(fixed?.workflowName ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The chosen business's workflows (from the Templates page).
  useEffect(() => {
    if (fixed || !businessId) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/workflow.list', { body: { workspaceId: businessId } })
      .then((r) => {
        if (!cancelled) setLoaded({ businessId, items: unwrap(r).items });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fixed, businessId]);

  const workflows = loaded?.businessId === businessId ? loaded.items : null;
  const chosen = fixed
    ? { id: fixed.workflowId, name: fixed.workflowName }
    : (workflows?.find((w) => w.id === picked) ?? workflows?.[0] ?? null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const templateName = name.trim() || chosen?.name || '';
    if (!chosen) return setError('Pick a workflow to save.');
    if (!templateName) return setError('Give the template a name.');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow_template.create_from_workflow', {
          body: {
            organizationId,
            workflowId: chosen.id,
            name: templateName,
            description: description.trim() || null,
          },
        }),
      );
      const n = out.placeholders.length;
      toast.success(
        n
          ? `Saved as a template, with ${n} ${n === 1 ? 'detail' : 'details'} each business matches.`
          : 'Saved as a template.',
      );
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
        title="Save as an agency template"
        description={`A copy for ${agencyName}’s templates. Its stages, tags, calendars and people become details each business matches when you push it. The workflow itself doesn’t change.`}
      >
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
          {fixed ? null : (
            <>
              <Field label="Business" htmlFor="tpl-business">
                <Select
                  id="tpl-business"
                  value={businessId}
                  onChange={(e) => {
                    setBusinessId(e.target.value);
                    setPicked('');
                    setName('');
                    setError(null);
                  }}
                >
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Workflow"
                htmlFor="tpl-workflow"
                hint={
                  workflows && !workflows.length ? 'This business has no workflows yet.' : undefined
                }
              >
                <Select
                  id="tpl-workflow"
                  value={chosen?.id ?? ''}
                  disabled={!workflows?.length}
                  onChange={(e) => {
                    setPicked(e.target.value);
                    setName('');
                  }}
                  data-testid="template-workflow"
                >
                  {!workflows ? <option value="">Loading…</option> : null}
                  {workflows?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <Field label="Template name" htmlFor="tpl-name" error={error}>
            <Input
              id="tpl-name"
              value={name}
              placeholder={chosen?.name ?? 'Estimate follow-up (home services)'}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              invalid={!!error}
              data-testid="template-name"
            />
          </Field>
          <Field label="What it’s for (optional)" htmlFor="tpl-description">
            <Textarea
              id="tpl-description"
              rows={2}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A text, an email, then a task"
            />
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="template-save">
              Save template
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
