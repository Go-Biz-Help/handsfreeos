'use client';
import {
  parseDefinition,
  placeholdersIn,
  templateIssues,
  type WorkflowDefinition,
} from '@hfos/core';
import { ArrowUpRight, LayoutTemplate } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { WorkflowEditor } from '@/components/workflows/editor';
import { renameTemplate, templateDraftAdapter } from '@/lib/agency/draft';
import { agencyHref } from '@/lib/agency/org';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowCatalogsOut, WorkflowDetail, WorkflowTemplateGet } from '@/lib/api/types';
import type { WorkflowDraft } from '@/lib/workflows/use-draft';
import { behindBy } from '@/lib/agency/installs';
import { InstallChip, type Business } from './template-list';
import { PushStepper } from './push-stepper';

const KIND_WORD: Record<string, string> = {
  stage: 'stage',
  pipeline: 'pipeline',
  tag: 'tag',
  calendar: 'calendar',
  service: 'service',
  user: 'person',
  workflow: 'workflow',
};

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

/** Hands the editor's live draft to the page around it (the placeholder chips follow each edit). */
function DraftWatcher({
  def,
  onChange,
}: {
  def: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
}) {
  useEffect(() => onChange(def), [def, onChange]);
  return null;
}

/** Publish: the draft as it is now becomes the next version (saved first). No test gate: each business tests its copy. */
function PublishTemplateButton({
  organizationId,
  templateId,
  draft,
}: {
  organizationId: string;
  templateId: string;
  draft: WorkflowDraft;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const errors = useMemo(
    () => templateIssues(draft.definition).filter((i) => i.severity === 'error').length,
    [draft.definition],
  );
  async function publish() {
    setBusy(true);
    try {
      if (!(await draft.flush())) {
        toast.error('Your latest changes aren’t saved yet, so nothing was published.');
        return;
      }
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow_template.publish', {
          body: { organizationId, templateId },
        }),
      );
      toast.success(
        out.published
          ? `Published version ${out.version}. Businesses on an older version see “Update available”.`
          : `Nothing changed since version ${out.version}.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      size="sm"
      loading={busy}
      disabled={errors > 0}
      title={errors ? 'Fix the red items in Checks first' : undefined}
      onClick={() => void publish()}
      data-testid="template-publish"
    >
      Publish
    </Button>
  );
}

/**
 * An agency template in the workflow editor (kind 'template'): the same steps, canvas, panels and checks,
 * with its placeholders shown as the details each business matches, Simulate-only tests, rename (its name in
 * the header, as a workflow's), Publish (the next version) and Push. Below: the businesses it's in, and its
 * versions.
 */
export function TemplateEditor({
  organizationId,
  data,
  businesses,
  sample,
}: {
  organizationId: string;
  data: WorkflowTemplateGet;
  businesses: readonly Business[];
  /** A business whose name and time zone fill previews (a template has none of its own). */
  sample: {
    readonly workspaceId: string;
    readonly businessName: string;
    readonly timeZone: string;
  };
}) {
  const t = data.template;
  const [pushing, setPushing] = useState(false);
  /** Its name as last renamed here (the push dialog's title follows it). */
  const [name, setName] = useState(t.name);
  const [seenName, setSeenName] = useState(t.name);
  if (t.name !== seenName) {
    setSeenName(t.name);
    setName(t.name);
  }
  const [liveDef, setLiveDef] = useState<WorkflowDefinition>(() => parseDefinition(t.definition));
  const adapter = useMemo(() => templateDraftAdapter(organizationId, t.id), [organizationId, t.id]);
  const placeholders = useMemo(() => placeholdersIn(liveDef), [liveDef]);

  // The editor takes a workflow's shape: a draft with nothing published or tested of its own.
  const workflow = useMemo<WorkflowDetail>(
    () => ({
      id: t.id,
      name: t.name,
      description: t.description,
      status: 'draft',
      revision: t.revision,
      testedRevision: null,
      tested: false,
      activeVersion: null,
      trigger: { kind: 'manual', event: null, summary: '' },
      calendarIds: [],
      allCalendars: false,
      reentry: 'after_exit',
      source: { kind: 'blank', recipeKey: null, recipeName: null, template: null },
      runs30d: 0,
      activeRuns: 0,
      lastError: null,
      lastRun: null,
      createdBy: t.createdBy,
      updatedAt: t.updatedAt,
      definition: t.definition,
      definitionVersion: 1,
      issues: [],
      installedRevision: null,
      changedSinceInstall: false,
    }),
    [t],
  );
  // Nothing to name: a template's stages, people and calendars are placeholders.
  const catalogs = useMemo<WorkflowCatalogsOut>(
    () => ({
      timeZone: sample.timeZone,
      team: [],
      pipelines: [],
      tags: [],
      calendars: [],
      services: [],
      workflows: [],
      textingReady: true,
    }),
    [sample.timeZone],
  );

  return (
    <div data-testid="template-editor" data-template-id={t.id}>
      <div
        className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-menu bg-accent-soft px-3 py-2 text-[13px] text-accent-text"
        data-testid="template-banner"
      >
        <LayoutTemplate className="h-4 w-4 flex-none" strokeWidth={1.75} />
        <span className="font-semibold">
          Agency template ·{' '}
          {t.latestVersion ? `version ${t.latestVersion} published` : 'not published yet'}
        </span>
        {placeholders.length ? (
          <>
            <span className="text-accent-text/80">Details each business matches:</span>
            {placeholders.map((p) => (
              <span
                key={p.key}
                className="inline-flex h-6 items-center gap-1 rounded-full bg-card px-2.5 text-xs font-medium text-text"
                data-testid={`placeholder-${p.key}`}
              >
                {p.label}
                <span className="text-text-3">· {KIND_WORD[p.kind] ?? p.kind}</span>
              </span>
            ))}
          </>
        ) : (
          <span>It names nothing a business has to match.</span>
        )}
      </div>

      <WorkflowEditor
        key={t.id}
        kind="template"
        workspaceId={sample.workspaceId}
        workflow={workflow}
        versions={[]}
        catalogs={catalogs}
        canManage
        businessName={sample.businessName}
        quietHours={null}
        sample={null}
        initialStep={null}
        adapter={adapter}
        onRename={async (next) => {
          await renameTemplate(organizationId, t.id, next);
          setName(next);
        }}
        crumb={{ href: agencyHref(organizationId), label: 'Templates' }}
        actions={(draft) => (
          <>
            <DraftWatcher def={draft.definition} onChange={setLiveDef} />
            <PublishTemplateButton
              organizationId={organizationId}
              templateId={t.id}
              draft={draft}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!t.latestVersion}
              title={t.latestVersion ? undefined : 'Publish it first'}
              onClick={() => setPushing(true)}
              data-testid="template-push"
            >
              Push…
            </Button>
          </>
        )}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_336px]">
        <Card className="overflow-hidden" data-testid="template-installs">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-[15px] font-semibold">Installed in</h2>
            <p className="text-xs text-text-3">
              Each business gets a draft, and tests and publishes it itself.
            </p>
          </div>
          {data.installs.length ? (
            data.installs.map((i) => {
              const behind = behindBy(i, t.latestVersion);
              return (
                <div
                  key={i.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
                >
                  <InstallChip install={i} latest={t.latestVersion} />
                  <span className="min-w-0 flex-1 truncate font-medium">{i.workspaceName}</span>
                  <span
                    className={
                      i.status === 'failed'
                        ? 'text-danger-text'
                        : behind
                          ? 'text-warning-text'
                          : 'text-text-3'
                    }
                  >
                    {i.status === 'failed'
                      ? `Couldn’t install${i.lastError ? `: ${i.lastError}` : ''}`
                      : i.status === 'pending'
                        ? 'Installing…'
                        : behind
                          ? `${behind} behind`
                          : 'Up to date'}
                  </span>
                  {i.workflowId ? (
                    <Link
                      href={`/app/w/${i.workspaceId}/workflows/${i.workflowId}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline"
                    >
                      Their copy
                      <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </Link>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="px-4 py-5 text-[13px] text-text-3">
              {t.latestVersion
                ? 'Not pushed to any business yet.'
                : 'Publish it, then push it to your client businesses.'}
            </p>
          )}
        </Card>
        <Card className="overflow-hidden" data-testid="template-versions">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-[15px] font-semibold">Versions</h2>
          </div>
          {data.versions.length ? (
            <ol>
              {data.versions.map((v) => (
                <li key={v.id} className="border-b border-border px-4 py-2.5 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="font-semibold">Version {v.version}</span>
                    <span className="text-xs text-text-3">
                      {v.publishedBy?.fullName ?? 'Someone'} · {shortDate(v.createdAt)}
                    </span>
                  </div>
                  {v.diff.length ? (
                    <ul className="mt-1 list-disc pl-4 text-xs text-text-2">
                      {v.diff.slice(0, 4).map((d, n) => (
                        <li key={n}>{d}</li>
                      ))}
                      {v.diff.length > 4 ? <li>…and {v.diff.length - 4} more</li> : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-4 py-5 text-[13px] text-text-3">Nothing published yet.</p>
          )}
        </Card>
      </div>

      {pushing ? (
        <PushStepper
          organizationId={organizationId}
          template={{ ...t, name }}
          installs={data.installs}
          businesses={businesses}
          onClose={() => setPushing(false)}
        />
      ) : null}
    </div>
  );
}
