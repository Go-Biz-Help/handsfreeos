'use client';
import { allQuestions, type FormDefinition } from '@hfos/core';
import { AlertTriangle, Check, Loader2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FormCatalogsOut, FormGet, FormResultsOut } from '@/lib/api/types';
import { FormStatusBadge } from './chips';
import { useFormEditor } from './editor-state';
import { FormPreview } from './preview';
import { FormResults } from './results';
import { FormShare } from './share';
import { QuestionList } from './question-list';
import { QuestionSettings } from './question-settings';

type Tab = 'questions' | 'preview' | 'results' | 'share';

/**
 * One form, three ways to look at the same thing: the questions, and the form as a customer sees it. The
 * Assistant is the third, and it edits this same draft through the same ops.
 *
 * Changes save themselves a moment after you stop; publishing is deliberate, and is the only thing that
 * changes what a customer fills in.
 */
export function FormEditor({
  workspaceId,
  initial,
  catalogs,
  results,
  siteSlug,
  canManage,
  brandedOrigin,
}: {
  workspaceId: string;
  initial: FormGet;
  catalogs: FormCatalogsOut | null;
  results: FormResultsOut | null;
  siteSlug: string | null;
  canManage: boolean;
  brandedOrigin: string | null;
}) {
  const router = useRouter();
  const editor = useFormEditor(workspaceId, initial.form.formId, {
    definition: initial.definition as unknown as FormDefinition,
    revision: initial.revision,
    issues: initial.issues,
  });
  const questions = allQuestions(editor.definition);
  const [tab, setTab] = useState<Tab>('questions');
  const [selected, setSelected] = useState<string | null>(questions[0]?.id ?? null);
  const [publishing, setPublishing] = useState(false);

  async function publish() {
    setPublishing(true);
    try {
      await editor.save();
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/form.publish', {
          body: {
            workspaceId,
            formId: initial.form.formId,
            baseRevision: editor.revision,
            source: 'editor',
          },
        }),
      );
      toast.success(
        out.version === 1
          ? 'Published. It is taking answers now.'
          : `Published version ${out.version}.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="How to look at this form"
          options={[
            { value: 'questions', label: 'Questions', testId: 'tab-questions' },
            { value: 'preview', label: 'Preview', testId: 'tab-preview' },
            {
              value: 'results',
              label: initial.form.responseCount
                ? `Results ${initial.form.responseCount}`
                : 'Results',
              testId: 'tab-results',
            },
            { value: 'share', label: 'Share', testId: 'tab-share' },
          ]}
        />
        <FormStatusBadge status={initial.form.status} />
        <span className="text-[12.5px] text-text-3" data-testid="save-state">
          {editor.saving ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              Saving
            </span>
          ) : editor.dirty ? (
            'Unsaved changes'
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5" strokeWidth={1.75} />
              Saved
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {canManage ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={editor.undo}
              disabled={!editor.canUndo}
              aria-label="Undo"
            >
              <Undo2 className="h-4 w-4" strokeWidth={1.75} />
              Undo
            </Button>
          ) : null}
          {canManage ? (
            <Button
              onClick={publish}
              loading={publishing}
              disabled={!questions.length}
              data-testid="form-publish"
            >
              {initial.form.version ? 'Publish changes' : 'Publish'}
            </Button>
          ) : null}
        </div>
      </div>

      {editor.issues.length ? (
        <Card
          className="flex gap-3 border-warning/40 bg-warning-soft p-3.5"
          data-testid="form-issues"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning-text" strokeWidth={1.75} />
          <div className="min-w-0 text-[13px] text-text-2">
            <p className="font-medium text-text">To fix before this can go out</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {editor.issues.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      {tab === 'questions' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <QuestionList
            definition={editor.definition}
            selectedId={selected}
            onSelect={setSelected}
            apply={editor.apply}
            readOnly={!canManage}
          />
          {selected ? (
            <QuestionSettings
              definition={editor.definition}
              questionId={selected}
              apply={editor.apply}
              catalogs={catalogs}
              readOnly={!canManage}
            />
          ) : (
            <Card className="p-6 text-center text-[13px] text-text-3">
              Add a question, then pick it to change what it asks.
            </Card>
          )}
        </div>
      ) : tab === 'preview' ? (
        <div className="mx-auto w-full max-w-2xl">
          <FormPreview definition={editor.definition} />
          <p className="mt-3 text-center text-[12.5px] text-text-3">
            Nothing here is recorded. This is the live version of what you are building.
          </p>
        </div>
      ) : tab === 'results' ? (
        results ? (
          <FormResults workspaceId={workspaceId} form={initial.form} results={results} />
        ) : null
      ) : (
        <FormShare
          workspaceId={workspaceId}
          form={initial.form}
          siteSlug={siteSlug}
          canManage={canManage}
          brandedOrigin={brandedOrigin}
        />
      )}
    </div>
  );
}
