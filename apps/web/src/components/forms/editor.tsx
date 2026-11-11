'use client';
import {
  allQuestions,
  POLL_WORDS,
  textingBoxesTwice,
  type FormDefinition,
  type FormOp,
  type TextingBoxTwice,
} from '@hfos/core';
import { AlertTriangle, Check, Loader2, Sparkles, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FormCatalogsOut, FormGet, FormResultsOut } from '@/lib/api/types';
import { cueErrorMessage, questionsWanting, writeCues } from '@/lib/forms/poll-cues';
import { FormStatusBadge } from './chips';
import { PollDraftCard } from './poll-draft';
import { PollLeadsCard } from './poll-leads';
import { PollSlidesCard } from './poll-slides';
import { FormDesignPanel, type FormBrand } from './design-panel';
import { useFormEditor } from './editor-state';
import { FormPreview } from './preview';
import { FormResults } from './results';
import { FormShare } from './share';
import { QuestionList } from './question-list';
import { QuestionSettings } from './question-settings';

type Tab = 'questions' | 'design' | 'preview' | 'results' | 'share';

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
  timeZone,
  openResponse = null,
  brand = { color: null, logo: null },
}: {
  workspaceId: string;
  initial: FormGet;
  catalogs: FormCatalogsOut | null;
  results: FormResultsOut | null;
  siteSlug: string | null;
  canManage: boolean;
  brandedOrigin: string | null;
  /** The business's, for when each answer came in on the exported spreadsheet. */
  timeZone: string;
  /** A response a search result opens (`?response=<id>`): the form opens on its Results, with it open. */
  openResponse?: string | null;
  /** The business's logo and colour, which the form follows until its design says otherwise. */
  brand?: FormBrand;
}) {
  const router = useRouter();
  const editor = useFormEditor(workspaceId, initial.form.formId, {
    definition: initial.definition as unknown as FormDefinition,
    revision: initial.revision,
    issues: initial.issues,
  });
  const questions = allQuestions(editor.definition);
  const [tab, setTab] = useState<Tab>(openResponse ? 'results' : 'questions');
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

  /** "Use on all my forms": the draft is saved first, since the design is read from it. */
  async function useDesignEverywhere() {
    try {
      await editor.save();
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/form.use_design_everywhere', {
          body: { workspaceId, formId: initial.form.formId },
        }),
      );
      toast.success(
        out.formIds.length === 0
          ? 'Your other forms already look like this.'
          : out.formIds.length === 1
            ? 'Your other form looks like this now.'
            : `Your other ${out.formIds.length} forms look like this now.`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
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
            // A live poll pops up in a video call, in the call's own look.
            ...(editor.definition.mode === 'poll'
              ? []
              : [{ value: 'design' as const, label: 'Design', testId: 'tab-design' }]),
            { value: 'preview', label: 'Preview', testId: 'tab-preview' },
            {
              value: 'results',
              label: initial.form.responseCount
                ? `Results ${initial.form.responseCount}`
                : 'Results',
              testId: 'tab-results',
            },
            // A live poll has no link: its questions pop up in a video call.
            ...(editor.definition.mode === 'poll'
              ? []
              : [{ value: 'share' as const, label: 'Share', testId: 'tab-share' }]),
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

      <TextingBoxTwiceCard
        twice={textingBoxesTwice(editor.definition)}
        apply={editor.apply}
        readOnly={!canManage}
        onDeleted={(id) => setSelected((s) => (s === id ? null : s))}
      />

      {tab === 'questions' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            {editor.definition.mode === 'poll' && (canManage || editor.definition.slides) ? (
              <PollSlidesCard
                workspaceId={workspaceId}
                formId={initial.form.formId}
                definition={editor.definition}
                apply={editor.apply}
                readOnly={!canManage}
              />
            ) : null}
            {editor.definition.mode === 'poll' && canManage ? (
              <PollDraftCard
                workspaceId={workspaceId}
                definition={editor.definition}
                apply={editor.apply}
              />
            ) : null}
            {editor.definition.mode === 'poll' ? (
              <PollLeadsCard
                workspaceId={workspaceId}
                definition={editor.definition}
                apply={editor.apply}
                readOnly={!canManage}
              />
            ) : null}
            {editor.definition.mode === 'poll' && canManage ? (
              <WriteAllCues
                workspaceId={workspaceId}
                definition={editor.definition}
                apply={editor.apply}
              />
            ) : null}
            <QuestionList
              definition={editor.definition}
              selectedId={selected}
              onSelect={setSelected}
              apply={editor.apply}
              readOnly={!canManage}
            />
          </div>
          {selected ? (
            <QuestionSettings
              workspaceId={workspaceId}
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
      ) : tab === 'design' ? (
        <FormDesignPanel
          workspaceId={workspaceId}
          embedOrigins={initial.form.embedOrigins}
          onUseEverywhere={useDesignEverywhere}
          definition={editor.definition}
          apply={editor.apply}
          readOnly={!canManage}
          brand={brand}
        />
      ) : tab === 'preview' ? (
        <div className="mx-auto w-full max-w-2xl">
          <FormPreview
            definition={editor.definition}
            businessColor={brand.color}
            logo={brand.logo}
          />
          <p className="mt-3 text-center text-[12.5px] text-text-3">
            Nothing here is recorded. This is the live version of what you are building.
          </p>
        </div>
      ) : tab === 'results' ? (
        results ? (
          <FormResults
            workspaceId={workspaceId}
            form={initial.form}
            results={results}
            canManage={canManage}
            timeZone={timeZone}
            openResponse={openResponse}
          />
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

/**
 * A live poll's when-to-ask phrases, written by the AI for every question that has none (part 3; the owner's 10). They
 * land in the draft as edits, to read and change before publishing.
 */
function WriteAllCues({
  workspaceId,
  definition,
  apply,
}: {
  workspaceId: string;
  definition: FormDefinition;
  apply: (ops: FormOp[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const wanting = questionsWanting(definition);
  if (!wanting.length) return null;
  const write = async () => {
    setBusy(true);
    try {
      const ops = await writeCues(workspaceId, definition, wanting);
      if (ops.length) {
        apply(ops);
        toast.success(
          ops.length === 1
            ? 'Phrases written for 1 question. Check them, then publish.'
            : `Phrases written for ${ops.length} questions. Check them, then publish.`,
        );
      }
    } catch (e) {
      toast.error(cueErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex items-center gap-3 p-3" data-testid="poll-write-cues">
      <Sparkles className="h-4 w-4 shrink-0 text-accent-text" strokeWidth={1.75} aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] text-text-2">
        {wanting.length === 1
          ? '1 question has no when-to-ask phrases. The AI listens for these during the call.'
          : `${wanting.length} questions have no when-to-ask phrases. The AI listens for these during the call.`}
      </p>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void write()}>
        {POLL_WORDS.writeAllCues}
      </Button>
    </Card>
  );
}

/**
 * A question asking for permission to text, on a form that already shows our box (core's `textingBoxesTwice`).
 * A warning, never a blocker: customers would see two boxes, and only ours saves their yes and carries the words the
 * texting registration quotes. One press deletes the question; Undo brings it back.
 */
function TextingBoxTwiceCard({
  twice,
  apply,
  readOnly,
  onDeleted,
}: {
  twice: readonly TextingBoxTwice[];
  apply: (ops: FormOp[]) => void;
  readOnly: boolean;
  onDeleted: (questionId: string) => void;
}) {
  if (!twice.length) return null;
  const one = twice.length === 1;
  return (
    <Card
      className="flex gap-3 border-warning/40 bg-warning-soft p-3.5"
      data-testid="form-texting-box-twice"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning-text" strokeWidth={1.75} />
      <div className="min-w-0 flex-1 text-[13px] text-text-2">
        <p className="font-medium text-text">Customers will see two boxes asking to text them</p>
        <p className="mt-1">
          HandsFreeOS already adds a “Text me” box to this form, worded the way the carriers
          approved. Only that box saves their yes to texts.{' '}
          {one ? 'This question asks the same thing:' : 'These questions ask the same thing:'}
        </p>
        <ul className="mt-2 space-y-2">
          {twice.map((q) => (
            <li key={q.questionId} className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-text">“{q.title || 'Untitled question'}”</p>
                {q.required ? (
                  <p className="mt-0.5 text-[12.5px] text-warning-text">
                    It must be checked to send the form, and carriers turn down a texting box that’s
                    required.
                  </p>
                ) : null}
              </div>
              {readOnly ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    apply([{ op: 'delete_question', questionId: q.questionId }]);
                    onDeleted(q.questionId);
                    toast.success('Deleted. Publish changes to take it off the live form.');
                  }}
                  data-testid="form-texting-box-delete"
                >
                  Delete this question
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
