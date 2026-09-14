'use client';
import { AlertTriangle, Info, Minus, Plus, RefreshCw, UserPen } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ApiError, errorMessage } from '@/lib/api/client';
import {
  applyTemplateUpdate,
  previewTemplateUpdate,
  type TemplateUpdatePreview,
} from '@/lib/agency/update';
import { cn } from '@/lib/utils';

/**
 * "Update available" on a business's copy of a Go Biz Help template: what the new version changes, which of
 * the business's own changes stay, and Apply, which makes a draft revision (tested and published like any
 * change, never straight to live). Owners and admins only.
 */
export function TemplateUpdateButton({
  workspaceId,
  workflowId,
  className,
}: {
  workspaceId: string;
  workflowId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={cn('relative z-10', className)}
        onClick={() => setOpen(true)}
        data-testid={`update-review-${workflowId}`}
      >
        <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
        Review update
      </Button>
      {open ? (
        <TemplateUpdateDialog
          workspaceId={workspaceId}
          workflowId={workflowId}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function Lines({
  items,
  tone,
  icon: Icon,
  testId,
}: {
  items: readonly string[];
  tone: 'ok' | 'mine' | 'gone';
  icon: typeof Plus;
  testId: string;
}) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid={testId}>
      {items.map((line, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px] leading-snug">
          <span
            className={cn(
              'mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full',
              tone === 'ok' && 'bg-success-soft text-success-text',
              tone === 'mine' && 'bg-card-2 text-text-2',
              tone === 'gone' && 'bg-danger-soft text-danger-text',
            )}
          >
            <Icon className="h-3 w-3" strokeWidth={2.2} />
          </span>
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border pt-3">
      <h3 className="mb-2 text-[13px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export function TemplateUpdateDialog({
  workspaceId,
  workflowId,
  onOpenChange,
}: {
  workspaceId: string;
  workflowId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<TemplateUpdatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    previewTemplateUpdate(workspaceId, workflowId)
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, workflowId]);

  async function apply() {
    if (!preview) return;
    setBusy(true);
    try {
      const out = await applyTemplateUpdate(workspaceId, workflowId, preview.revision);
      toast.success(`Updated to version ${out.version}. Test it, then publish it.`);
      onOpenChange(false);
      router.push(`/app/w/${workspaceId}/workflows/${workflowId}?mode=steps`);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'revision_conflict') {
        // The draft moved on: show the update against it as it is now.
        toast.error('Your draft changed a moment ago. Here’s the update again.');
        setPreview(await previewTemplateUpdate(workspaceId, workflowId).catch(() => null));
      } else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const p = preview;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="Update available"
        className="max-h-[calc(100dvh-32px)] w-[min(560px,calc(100vw-24px))] overflow-y-auto"
        description={
          p
            ? `Go Biz Help updated “${p.templateName}” to version ${p.latestVersion}. You’re on version ${p.installedVersion ?? 1}.`
            : 'Checking what changed…'
        }
      >
        <div className="mt-4 flex flex-col gap-3" data-testid="template-update">
          {error ? (
            <p className="rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text">
              {error}
            </p>
          ) : !p ? (
            <p className="text-[13px] text-text-3">Loading…</p>
          ) : !p.updateAvailable ? (
            <p className="text-[13px] text-text-2">This copy already has the newest version.</p>
          ) : (
            <>
              <Section title={`What changes in version ${p.latestVersion}`}>
                {p.templateChanges.length ? (
                  <Lines items={p.templateChanges} tone="ok" icon={Plus} testId="update-changes" />
                ) : (
                  <p className="text-[13px] text-text-3">Nothing in the steps; the details only.</p>
                )}
              </Section>
              {p.kept.length ? (
                <Section title="Your changes stay">
                  <Lines items={p.kept} tone="mine" icon={UserPen} testId="update-kept" />
                </Section>
              ) : null}
              {p.dropped.length ? (
                <Section title="These changes of yours no longer fit, so they go">
                  <Lines items={p.dropped} tone="gone" icon={Minus} testId="update-dropped" />
                </Section>
              ) : null}
              {p.changedSinceInstall && !p.kept.length && !p.dropped.length ? (
                <p className="flex items-start gap-2 text-[13px] text-text-2">
                  <Info className="mt-px h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                  Your copy was edited, but it ends up the same as before, so nothing of yours is
                  lost.
                </p>
              ) : null}
              {p.unmapped.length ? (
                <p className="flex items-start gap-2 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text">
                  <AlertTriangle className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                  Afterwards, pick {p.unmapped.map((u) => u.label.toLowerCase()).join(', ')} in
                  Checks before you publish.
                </p>
              ) : null}
              <p className="flex items-start gap-2 rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] text-text-2">
                <Info className="mt-px h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                Applying makes a draft of your copy. You test it and publish it, like any change.
                What runs now keeps running until then.
              </p>
            </>
          )}
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Not now
            </Button>
            <Button
              onClick={() => void apply()}
              loading={busy}
              disabled={!p?.updateAvailable}
              data-testid="update-apply"
            >
              Apply the update
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
