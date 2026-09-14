'use client';
import {
  aiOutputKey,
  findStep,
  MAX_BRANCHES,
  newBranchId,
  newStepId,
  OUTPUT_KEY_RE,
  variablesAt,
  type AiStep,
} from '@hfos/core';
import { BookOpen, Plus, Split, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { AI_SOFT, AI_TEXT, laneColor } from '../chips';
import { useEditor } from '../editor-context';
import { VariableField } from '../variable-field';
import { PanelField, useDraftText, useStepUpdate } from './fields';

const TASKS = [
  { value: 'write', label: 'Write' },
  { value: 'classify', label: 'Sort' },
  { value: 'summarize', label: 'Summarize' },
] as const;

/** "Uses your knowledge base." with the link to Knowledge. */
export function KnowledgeLine() {
  const { workspaceId } = useEditor();
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-[9px] px-[11px] py-[9px] text-[12.5px] leading-[1.45]',
        AI_SOFT,
        AI_TEXT,
      )}
      data-testid="knowledge-line"
    >
      <BookOpen className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      <span>
        <strong className="font-semibold">Uses your knowledge base.</strong> The profile and
        published items. Each run lists the items it used.{' '}
        <Link
          href={`/app/w/${workspaceId}/knowledge`}
          className="font-semibold text-inherit underline"
        >
          Open Knowledge
        </Link>
      </span>
    </div>
  );
}

export function AiPanel({ step }: { step: AiStep }) {
  const update = useStepUpdate(step.id);
  const { def, apply, readOnly, select } = useEditor();
  const vars = useMemo(() => variablesAt(def, step.id), [def, step.id]);
  const prompt = useDraftText(step.prompt, (next) =>
    update({ prompt: next }, 'Edit the AI’s instructions', { group: 'prompt', quiet: true }),
  );
  const fallback = useDraftText(step.task === 'classify' ? '' : (step.fallback ?? ''), (next) =>
    update({ fallback: next.trim() ? next : null }, 'Change the fallback', {
      group: 'fallback',
      quiet: true,
    }),
  );
  const key = useDraftText(step.outputKey ?? '', (next) => {
    const k = next.trim().toLowerCase();
    if (k && !OUTPUT_KEY_RE.test(k))
      return {
        ok: false,
        message: 'Use a short lowercase name, like reply or quote_note.',
        error: null,
      };
    return update({ outputKey: k || null }, 'Change where the result is saved', {
      group: 'key',
      quiet: true,
    });
  });
  const setTask = (task: AiStep['task']) => {
    if (task === step.task || readOnly) return;
    update(
      {
        task,
        categories:
          task === 'classify' && step.categories.length < 2 ? ['Yes', 'No'] : step.categories,
        fallback: null,
      },
      'Change what the AI does',
    );
  };
  const cats = step.categories;
  const setCats = (next: string[], label: string, group?: string, renamed?: [string, string]) =>
    update(
      {
        categories: next,
        ...(renamed && step.fallback === renamed[0] ? { fallback: renamed[1] } : {}),
        ...(step.fallback && !next.includes(step.fallback) && !renamed ? { fallback: null } : {}),
      },
      label,
      { group, quiet: !!group },
    );
  const branchOnCategories = () => {
    const loc = findStep(def, step.id);
    if (!loc) return;
    const field = `ai.${aiOutputKey(step)}`;
    const paths = cats.slice(0, MAX_BRANCHES).map((c) => ({
      id: newBranchId(),
      name: c.slice(0, 60),
      condition: { match: 'all' as const, conditions: [{ field, op: 'eq' as const, value: c }] },
      steps: [],
    }));
    const branches =
      paths.length < MAX_BRANCHES
        ? [...paths, { id: newBranchId(), name: 'Otherwise', condition: null, steps: [] }]
        : paths;
    const id = newStepId();
    const out = apply(
      [
        {
          op: 'add_step',
          parentId: loc.lane.parentId,
          branchId: loc.lane.branchId,
          index: loc.index + 1,
          step: { id, type: 'branch', mode: 'multi', branches },
        },
      ],
      'Add a path for each category',
    );
    if (out.ok) select(id);
  };

  return (
    <div data-testid="panel-ai">
      <PanelField label="The AI should">
        <Segmented
          ariaLabel="The AI should"
          fill
          value={step.task}
          onChange={setTask}
          options={TASKS}
        />
      </PanelField>
      <div className="mb-3.5">
        <VariableField
          id={`prompt-${step.id}`}
          label="Instructions"
          multiline
          rows={4}
          value={prompt.value}
          onChange={prompt.change}
          error={prompt.error}
          variables={vars}
          maxLength={2000}
          hint="Their latest message and the details of this run go with it."
        />
      </div>
      {step.task === 'write' ? (
        <PanelField label="Length">
          <Segmented
            ariaLabel="Length"
            value={step.channel}
            onChange={(channel) => {
              if (!readOnly) update({ channel }, 'Change what the AI writes');
            }}
            options={[
              { value: 'sms', label: 'One text (up to 160 characters)' },
              { value: 'email', label: 'An email' },
            ]}
          />
        </PanelField>
      ) : null}
      {step.task === 'classify' ? (
        <>
          <PanelField label="Sort their reply into these categories">
            <div className="flex flex-col gap-1.5">
              {cats.map((c, i) => (
                <CategoryRow
                  key={`${i}-${cats.length}`}
                  name={c}
                  color={laneColor(i, i === cats.length - 1 && /^other/i.test(c))}
                  canRemove={cats.length > 2}
                  onRename={(next) =>
                    setCats(
                      cats.map((x, j) => (j === i ? next : x)),
                      'Rename a category',
                      `cat-${i}`,
                      [c, next],
                    )
                  }
                  onRemove={() =>
                    setCats(
                      cats.filter((_, j) => j !== i),
                      'Remove a category',
                    )
                  }
                />
              ))}
              {cats.length < 10 && !readOnly ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 self-start px-1.5"
                  onClick={() => {
                    let n = cats.length + 1;
                    while (cats.some((c) => c.toLowerCase() === `category ${n}`)) n += 1;
                    setCats([...cats, `Category ${n}`], 'Add a category');
                  }}
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Add a category
                </Button>
              ) : null}
            </div>
          </PanelField>
          <PanelField
            label="If it isn’t sure, or the daily AI limit is reached"
            htmlFor={`fb-${step.id}`}
          >
            <Select
              id={`fb-${step.id}`}
              selectSize="sm"
              value={step.fallback ?? ''}
              disabled={readOnly}
              onChange={(e) => update({ fallback: e.target.value || null }, 'Change the fallback')}
            >
              <option value="">Leave it blank</option>
              {cats.map((c) => (
                <option key={c} value={c}>
                  Use {c}
                </option>
              ))}
            </Select>
          </PanelField>
          {!readOnly ? (
            <PanelField
              label="Paths"
              hint="Adds an If step after this one with a path per category, ready for its steps."
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={branchOnCategories}
                data-testid="ai-branch-on-categories"
              >
                <Split className="h-3.5 w-3.5" strokeWidth={1.5} />
                Make a path for each category
              </Button>
            </PanelField>
          ) : null}
        </>
      ) : (
        <PanelField
          label="If the AI can’t answer, or the daily AI limit is reached"
          htmlFor={`fallback-${step.id}`}
          error={fallback.error}
          hint="Used instead. Leave it empty to skip what uses the result."
        >
          <Textarea
            id={`fallback-${step.id}`}
            className="min-h-[60px] text-[14px]"
            value={fallback.value}
            readOnly={readOnly}
            maxLength={1600}
            onChange={(e) => fallback.change(e.target.value)}
          />
        </PanelField>
      )}
      <PanelField
        label="Save the result as"
        htmlFor={`key-${step.id}`}
        error={key.error}
        hint={`Later steps use it as {{ai.${aiOutputKey(step)}}}.`}
      >
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs text-text-3">ai.</span>
          <Input
            id={`key-${step.id}`}
            inputSize="sm"
            value={key.value}
            placeholder={aiOutputKey({ task: step.task, outputKey: null })}
            readOnly={readOnly}
            maxLength={40}
            onChange={(e) => key.change(e.target.value)}
          />
        </span>
      </PanelField>
      <PanelField label="Knowledge">
        <Checkbox
          label="Write from the knowledge base"
          checked={step.useKnowledge}
          disabled={readOnly}
          onChange={(e) =>
            update({ useKnowledge: e.target.checked }, 'Change whether it uses Knowledge')
          }
        />
      </PanelField>
      {step.useKnowledge ? <KnowledgeLine /> : null}
    </div>
  );
}

function CategoryRow({
  name,
  color,
  canRemove,
  onRename,
  onRemove,
}: {
  name: string;
  color: string;
  canRemove: boolean;
  onRename: (next: string) => ReturnType<ReturnType<typeof useStepUpdate>>;
  onRemove: () => void;
}) {
  const { readOnly } = useEditor();
  const text = useDraftText(name, onRename);
  return (
    <div className="flex items-center gap-2 rounded-[8px] border border-border bg-card py-1.5 pl-2.5 pr-1.5">
      <span
        aria-hidden
        className="h-[9px] w-[9px] flex-none rounded-full"
        style={{ background: color }}
      />
      <Input
        inputSize="sm"
        aria-label="Category"
        className="h-8 border-transparent px-1.5 font-semibold focus:border-accent"
        value={text.value}
        invalid={!!text.error}
        readOnly={readOnly}
        maxLength={40}
        onChange={(e) => text.change(e.target.value)}
      />
      {canRemove && !readOnly ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-[26px] w-[26px]"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      ) : null}
    </div>
  );
}
