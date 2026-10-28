import type { DocumentDefinition, DocumentFieldType } from '@hfos/core';
import * as React from 'react';

/**
 * The phone editor's hold on one definition, as the web's editor holds it (apps/web/src/components/documents/
 * editor-state.ts): a change is a function of the whole definition (core's edit.ts makes them), and the one before it
 * is kept so Undo puts it back. A drag shows as it moves (`preview`) and becomes one change when it's let go
 * (`commit`). The Send screen holds one customer's own word changes the same way (27a).
 */

/** What a tap on the page does: place a field, type over the words there, or add new words. */
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

/** Undo goes back this many changes. */
const UNDOS = 40;

export function useDefinitionEditor(initial: DocumentDefinition): DefinitionEditor {
  const [definition, setDefinition] = React.useState(initial);
  const [version, setVersion] = React.useState(0);
  const [saved, setSaved] = React.useState(initial);
  const [canUndo, setCanUndo] = React.useState(false);
  const undos = React.useRef<DocumentDefinition[]>([]);
  const dragFrom = React.useRef<DocumentDefinition | null>(null);
  const current = React.useRef(initial);
  current.current = definition;

  const push = (before: DocumentDefinition) => {
    undos.current = [...undos.current.slice(-(UNDOS - 1)), before];
    setCanUndo(true);
  };

  const change = React.useCallback((fn: (d: DocumentDefinition) => DocumentDefinition) => {
    const before = dragFrom.current ?? current.current;
    dragFrom.current = null;
    const next = fn(current.current);
    if (next === current.current) return;
    push(before);
    current.current = next;
    setDefinition(next);
    setVersion((v) => v + 1);
  }, []);

  const preview = React.useCallback((fn: (d: DocumentDefinition) => DocumentDefinition) => {
    dragFrom.current ??= current.current;
    const next = fn(current.current);
    current.current = next;
    setDefinition(next);
  }, []);

  const commit = React.useCallback(() => {
    const before = dragFrom.current;
    dragFrom.current = null;
    if (!before || before === current.current) return;
    push(before);
    setVersion((v) => v + 1);
  }, []);

  const undo = React.useCallback(() => {
    const last = undos.current[undos.current.length - 1];
    if (!last) return;
    undos.current = undos.current.slice(0, -1);
    setCanUndo(undos.current.length > 0);
    current.current = last;
    setDefinition(last);
    setVersion((v) => v + 1);
  }, []);

  const reset = React.useCallback((d: DocumentDefinition) => {
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
