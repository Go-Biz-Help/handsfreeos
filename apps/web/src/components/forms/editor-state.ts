'use client';
import {
  applyFormOps,
  FormOpError,
  newChoiceId,
  newPageId,
  newQuestionId,
  QUESTION_CONFIGS,
  type FormDefinition,
  type FormOp,
  type QuestionInput,
  type QuestionType,
} from '@hfos/core';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FormIssue } from '@/lib/api/types';

/**
 * The editor's hold on one form. The definition lives here; every change is a patch op applied in the
 * browser by the same code the server applies it with, so what you see is what will be saved. Saving sends
 * the ops, not the document, which is what lets two people work on one form without one erasing the other.
 */
export interface FormEditorState {
  readonly definition: FormDefinition;
  readonly revision: number;
  readonly issues: readonly FormIssue[];
  readonly saving: boolean;
  /** Changes made since the last save reached the server. */
  readonly dirty: boolean;
  readonly apply: (ops: FormOp[]) => void;
  readonly undo: () => void;
  readonly canUndo: boolean;
  readonly save: () => Promise<void>;
  readonly reload: (definition: FormDefinition, revision: number, issues: FormIssue[]) => void;
}

const HOLD_MS = 900;

export function useFormEditor(
  workspaceId: string,
  formId: string,
  initial: { definition: FormDefinition; revision: number; issues: FormIssue[] },
): FormEditorState {
  const [definition, setDefinition] = useState(initial.definition);
  const [revision, setRevision] = useState(initial.revision);
  const [issues, setIssues] = useState<readonly FormIssue[]>(initial.issues);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** The ops not yet saved, and the inverse of each, newest last. */
  const pending = useRef<FormOp[]>([]);
  const undos = useRef<FormOp[][]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  const saveNow = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const ops = pending.current;
    if (!ops.length) return;
    pending.current = [];
    setSaving(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/form.save_draft', {
          body: { workspaceId, formId, baseRevision: revision, ops: ops as never },
        }),
      );
      setRevision(out.revision);
      setIssues(out.issues);
      setDirty(pending.current.length > 0);
    } catch (e) {
      // Put them back so the next save tries again rather than losing the work.
      pending.current = [...ops, ...pending.current];
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [workspaceId, formId, revision]);

  const apply = useCallback(
    (ops: FormOp[]) => {
      if (!ops.length) return;
      try {
        const { definition: next, inverse } = applyFormOps(definition, ops);
        setDefinition(next);
        undos.current = [...undos.current.slice(-19), inverse];
        setCanUndo(true);
        pending.current = [...pending.current, ...ops];
        setDirty(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void saveNow(), HOLD_MS);
      } catch (e) {
        toast.error(e instanceof FormOpError ? e.message : errorMessage(e));
      }
    },
    [definition, saveNow],
  );

  const undo = useCallback(() => {
    const last = undos.current[undos.current.length - 1];
    if (!last) return;
    undos.current = undos.current.slice(0, -1);
    setCanUndo(undos.current.length > 0);
    try {
      const { definition: next } = applyFormOps(definition, last);
      setDefinition(next);
      pending.current = [...pending.current, ...last];
      setDirty(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveNow(), HOLD_MS);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [definition, saveNow]);

  const reload = useCallback(
    (next: FormDefinition, nextRevision: number, nextIssues: FormIssue[]) => {
      setDefinition(next);
      setRevision(nextRevision);
      setIssues(nextIssues);
      pending.current = [];
      undos.current = [];
      setCanUndo(false);
      setDirty(false);
    },
    [],
  );

  return {
    definition,
    revision,
    issues,
    saving,
    dirty,
    apply,
    undo,
    canUndo,
    save: saveNow,
    reload,
  };
}

// ---- The shapes a new thing starts as ----

const DEFAULT_TITLES: Partial<Record<QuestionType, string>> = {
  short_text: 'Your answer',
  long_text: 'Tell us more',
  choice: 'Pick one',
  checkboxes: 'Pick any that apply',
  yes_no: 'Yes or no?',
  number: 'How many?',
  money: 'How much?',
  date: 'Which day?',
  time: 'What time?',
  rating: 'How did we do?',
  scale: 'How likely are you to recommend us?',
  email: 'Your email',
  phone: 'Your phone',
  address: 'Your address',
  file: 'Add a photo',
  signature: 'Sign here',
  content: 'Something to read',
  payment: 'Payment',
  video: 'Watch this first',
};

/** A question of that type with the smallest sensible config, ready to drop on a page. */
export function newQuestion(type: QuestionType): QuestionInput {
  const config = QUESTION_CONFIGS[type].safeParse(startingConfig(type));
  return {
    id: newQuestionId(),
    type,
    title: DEFAULT_TITLES[type] ?? 'Your answer',
    config: (config.success ? config.data : {}) as never,
  } as QuestionInput;
}

function startingConfig(type: QuestionType): Record<string, unknown> {
  if (type === 'choice' || type === 'checkboxes')
    return {
      choices: [
        { id: newChoiceId(), label: 'First choice' },
        { id: newChoiceId(), label: 'Second choice' },
      ],
    };
  if (type === 'signature') return { statement: 'I agree to the work described above.' };
  if (type === 'content') return { body: 'A note for whoever is filling this in.' };
  if (type === 'payment') return { amount: { kind: 'fixed', cents: 5000 }, description: 'Deposit' };
  return {};
}

export const newPage = () => ({ id: newPageId(), title: '', questions: [] });
export const newChoice = (label: string) => ({ id: newChoiceId(), label });
