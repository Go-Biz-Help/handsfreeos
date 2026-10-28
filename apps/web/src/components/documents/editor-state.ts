'use client';
/**
 * The template editor's hold on one definition (core's definition.ts), and what the Send screen uses for one
 * customer's own changes (27a). A change is a function of the whole definition; the one before it is kept so Undo
 * puts it back. A drag shows as it moves (`preview`) and becomes one change when it's let go (`commit`).
 */
import type { DocumentDefinition, DocumentFieldType, DocumentPick } from '@hfos/core';
import { useCallback, useRef, useState } from 'react';

export type Selected = DocumentPick;
/** What a click on the page does: place a field, type over the words there, or add new words. */
export type Tool =
  | { readonly kind: 'field'; readonly type: DocumentFieldType }
  | { readonly kind: 'words' }
  | { readonly kind: 'textbox' }
  | null;

export interface DefinitionEditor {
  readonly definition: DocumentDefinition;
  /** Changed since `markSaved`. */
  readonly dirty: boolean;
  /** A change, with Undo. */
  readonly change: (fn: (d: DocumentDefinition) => DocumentDefinition) => void;
  /** Shown while a drag moves; `commit` makes it one change. */
  readonly preview: (fn: (d: DocumentDefinition) => DocumentDefinition) => void;
  readonly commit: () => void;
  readonly undo: () => void;
  readonly canUndo: boolean;
  readonly reset: (d: DocumentDefinition) => void;
  readonly markSaved: (saved: DocumentDefinition) => void;
  /** Bumps on every change, for whoever saves it. */
  readonly version: number;
}

export function useDefinitionEditor(initial: DocumentDefinition): DefinitionEditor {
  const [definition, setDefinition] = useState(initial);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(initial);
  const undos = useRef<DocumentDefinition[]>([]);
  const dragFrom = useRef<DocumentDefinition | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const current = useRef(initial);
  current.current = definition;

  const push = (before: DocumentDefinition) => {
    undos.current = [...undos.current.slice(-39), before];
    setCanUndo(true);
  };

  const change = useCallback((fn: (d: DocumentDefinition) => DocumentDefinition) => {
    const before = dragFrom.current ?? current.current;
    dragFrom.current = null;
    const next = fn(current.current);
    if (next === current.current) return;
    push(before);
    current.current = next;
    setDefinition(next);
    setVersion((v) => v + 1);
  }, []);

  const preview = useCallback((fn: (d: DocumentDefinition) => DocumentDefinition) => {
    dragFrom.current ??= current.current;
    const next = fn(current.current);
    current.current = next;
    setDefinition(next);
  }, []);

  const commit = useCallback(() => {
    const before = dragFrom.current;
    dragFrom.current = null;
    if (!before || before === current.current) return;
    push(before);
    setVersion((v) => v + 1);
  }, []);

  const undo = useCallback(() => {
    const last = undos.current[undos.current.length - 1];
    if (!last) return;
    undos.current = undos.current.slice(0, -1);
    setCanUndo(undos.current.length > 0);
    current.current = last;
    setDefinition(last);
    setVersion((v) => v + 1);
  }, []);

  const reset = useCallback((d: DocumentDefinition) => {
    undos.current = [];
    dragFrom.current = null;
    setCanUndo(false);
    current.current = d;
    setDefinition(d);
    setSaved(d);
  }, []);

  return {
    definition,
    dirty: definition !== saved,
    change,
    preview,
    commit,
    undo,
    canUndo,
    reset,
    markSaved: setSaved,
    version,
  };
}

// ---------- what's placed: core's, so the phone's editor does the same (packages/core/src/documents/edit.ts) ----------

export {
  boxOnPage as boxAt,
  newDocumentField as newField,
  newDocumentTextBox as newTextBox,
  movedBox as moved,
  withField as updateField,
  withEdit as updateEdit,
  withoutPick as removeItem,
  fieldTypesFor as typesFor,
  documentRoleColour as roleColour,
  newDocumentRoleKey as newRoleKey,
} from '@hfos/core';
