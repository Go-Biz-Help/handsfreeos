'use client';
/**
 * Drafting an estimate with AI (docs/contractor.md, "The AI helpers"; the owner's decision 6: "An estimate the AI
 * drafts always waits for a person"). On a job's Estimates card, for people who may see job costs:
 *
 * - **Draft with AI** takes what the work is, with any measurements, and asks the worker
 *   (`contractor.estimate.draft`). The AI reads the job, the crew's notes and the newest photos, and what comes back
 *   is a draft kept beside the job. The builder then opens from it.
 * - **Drafts from the AI** lists the ones still waiting. A draft isn't an estimate: someone opens it in the builder,
 *   checks each line and saves, or sets it aside.
 */
import { DRAFT_LIMITS } from '@hfos/core/addons/contractor/estimate-draft';
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { formatDate } from '@hfos/core';
import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { contractorHref } from './bits';
import type { WaitingDraft } from './types';
import { useAct } from './use-act';

const A = CONTRACTOR_WORDS.aiDraft;

/** Where a waiting draft opens: the builder, new, for its job, starting from it. */
const draftHref = (workspaceId: string, jobId: string, draftId: string) =>
  contractorHref(workspaceId, `estimates/new?jobId=${jobId}&draftId=${draftId}`);

/** The button on a job's Estimates card, and the dialog it opens. */
export function DraftWithAi({ workspaceId, jobId }: { workspaceId: string; jobId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="job-ai-draft">
        <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
        {A.button}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={A.title} description={A.lede}>
          {open ? (
            <DraftForm workspaceId={workspaceId} jobId={jobId} onClose={() => setOpen(false)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DraftForm({
  workspaceId,
  jobId,
  onClose,
}: {
  workspaceId: string;
  jobId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [brief, setBrief] = useState('');
  const [options, setOptions] = useState<1 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const out = await workerPost<{ draftId: string; jobId: string }>(
        '/v1/addons/contractor/actions/contractor.estimate.draft',
        {
          workspaceId,
          input: { jobId, options, ...(brief.trim() ? { brief: brief.trim() } : {}) },
        },
      );
      toast.success(A.ready);
      // The builder opens from the draft: nothing is an estimate until the person saves there.
      router.push(draftHref(workspaceId, out.jobId, out.draftId));
    } catch (e) {
      // The refusal stays in the dialog: what to add (a note, a photo, what the work is) is in its words.
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void go();
      }}
    >
      <Field label={A.brief} htmlFor="ai-draft-brief" hint={A.briefHint}>
        <Textarea
          id="ai-draft-brief"
          rows={4}
          value={brief}
          maxLength={DRAFT_LIMITS.brief}
          placeholder={A.briefPlaceholder}
          onChange={(e) => setBrief(e.target.value)}
          disabled={busy}
          autoFocus
          data-testid="ai-draft-brief"
        />
      </Field>
      <Field label={A.options} htmlFor="ai-draft-options" className="mt-3">
        <Select
          id="ai-draft-options"
          value={String(options)}
          disabled={busy}
          onChange={(e) => setOptions(e.target.value === '3' ? 3 : 1)}
          data-testid="ai-draft-options"
        >
          <option value="1">{A.one}</option>
          <option value="3">{A.three}</option>
        </Select>
      </Field>
      {busy ? (
        <p className="mt-3 text-[12.5px] text-text-2" role="status" data-testid="ai-draft-going">
          {A.going}
        </p>
      ) : error ? (
        <p
          className="mt-3 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] leading-[1.45] text-danger-text"
          role="alert"
          data-testid="ai-draft-error"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          {A.cancel}
        </Button>
        <Button type="submit" loading={busy} data-testid="ai-draft-go">
          {A.go}
        </Button>
      </div>
    </form>
  );
}

/** A job's drafts still waiting for someone: open one to check it, or set it aside. */
export function WaitingDrafts({
  workspaceId,
  drafts,
  timeZone,
  readOnly,
}: {
  workspaceId: string;
  drafts: readonly WaitingDraft[];
  timeZone: string;
  /** The job is done, cancelled or archived: a draft can still be set aside, not opened into a new estimate. */
  readOnly?: boolean;
}) {
  const { busy, act } = useAct();
  if (drafts.length === 0) return null;
  return (
    <div className="border-b border-border bg-card-2/50 px-5 py-3" data-testid="ai-drafts">
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-text-3">
        <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
        {A.waiting}
      </h3>
      <p className="text-[12.5px] text-text-3">{A.waitingHint}</p>
      <ul className="mt-2 space-y-2">
        {drafts.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5"
            data-testid="ai-draft"
          >
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] font-medium">
                {d.title ?? A.untitled}
              </span>
              <span className="block text-[12.5px] text-text-3">
                {[
                  A.size(d.lines, d.guessed),
                  A.from(d.notesRead, d.photosRead),
                  A.askedBy(d.askedBy, formatDate(d.createdAt, { timeZone })),
                ].join(' · ')}
              </span>
            </span>
            <span className="flex flex-none items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                loading={busy === d.id}
                onClick={() =>
                  void act(
                    d.id,
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/contractor.estimate_draft.dismiss', {
                          body: { workspaceId, draftId: d.id },
                        }),
                      ),
                    A.dismissed,
                  )
                }
                data-testid="ai-draft-dismiss"
              >
                {A.dismiss}
              </Button>
              {readOnly ? null : (
                <ButtonLink
                  href={draftHref(workspaceId, d.jobId, d.id)}
                  size="sm"
                  variant="secondary"
                  data-testid="ai-draft-open"
                >
                  {A.open}
                </ButtonLink>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
