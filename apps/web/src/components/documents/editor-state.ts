'use client';
/**
 * The template editor's hold on one definition (core's definition.ts), and what the Send screen uses for one
 * customer's own changes (27a). A change is a function of the whole definition; the one before it is kept so Undo
 * puts it back. A drag shows as it moves (`preview`) and becomes one change when it's let go (`commit`).
 */
import {
  DOCUMENT_FIELD_TYPES,
  SENDER_ROLE,
  newEditId,
  newFieldId,
  type DocumentDefinition,
  type DocumentEdit,
  type DocumentField,
  type DocumentFieldType,
  type DocumentPage,
} from '@hfos/core';
import { useCallback, useRef, useState } from 'react';

export type Selected = { readonly kind: 'field' | 'edit'; readonly id: string } | null;
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

// ---------- what's placed ----------

/** A new field's size in points, before it's dragged to fit. */
const FIELD_SIZES: Readonly<Record<DocumentFieldType, readonly [number, number]>> = {
  signature: [170, 42],
  initials: [64, 36],
  date_signed: [110, 20],
  name: [170, 20],
  email: [190, 20],
  phone: [130, 20],
  text: [170, 20],
  long_text: [260, 64],
  number: [90, 20],
  date: [110, 20],
  checkbox: [16, 16],
  choice: [150, 20],
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 100_000) / 100_000;

/** A box of `w`×`h` points centred where the page was clicked, kept on the page. */
export function boxAt(
  page: DocumentPage,
  pageIndex: number,
  at: { x: number; y: number },
  size: readonly [number, number],
) {
  const w = clamp(size[0] / page.width, 0.005, 1);
  const h = clamp(size[1] / page.height, 0.005, 1);
  return {
    page: pageIndex,
    x: round(clamp(at.x - w / 2, 0, 1 - w)),
    y: round(clamp(at.y - h / 2, 0, 1 - h)),
    w: round(w),
    h: round(h),
  };
}

export function newField(
  type: DocumentFieldType,
  role: string,
  page: DocumentPage,
  pageIndex: number,
  at: { x: number; y: number },
): DocumentField {
  return {
    id: newFieldId(),
    type,
    role,
    ...boxAt(page, pageIndex, at, FIELD_SIZES[type]),
    required: type !== 'checkbox',
    label: '',
    fillFrom: null,
    options: type === 'choice' ? ['Yes', 'No'] : [],
    fontSize: 11,
  };
}

export function newTextBox(
  page: DocumentPage,
  pageIndex: number,
  at: { x: number; y: number },
): DocumentEdit {
  return {
    id: newEditId(),
    ...boxAt(page, pageIndex, at, [180, 18]),
    text: '',
    original: '',
    size: 11,
    font: 'sans',
    bold: false,
    color: '#000000',
    background: '#ffffff',
  };
}

/** Moves or resizes a box by a change in fractions of the page, kept on it. */
export function moved<T extends { x: number; y: number; w: number; h: number }>(
  box: T,
  how: 'move' | 'resize',
  dx: number,
  dy: number,
): T {
  if (how === 'move')
    return {
      ...box,
      x: round(clamp(box.x + dx, 0, 1 - box.w)),
      y: round(clamp(box.y + dy, 0, 1 - box.h)),
    };
  return {
    ...box,
    w: round(clamp(box.w + dx, 0.005, 1 - box.x)),
    h: round(clamp(box.h + dy, 0.005, 1 - box.y)),
  };
}

export const updateField = (
  d: DocumentDefinition,
  id: string,
  fn: (f: DocumentField) => DocumentField,
) => ({
  ...d,
  fields: d.fields.map((f) => (f.id === id ? fn(f) : f)),
});
export const updateEdit = (
  d: DocumentDefinition,
  id: string,
  fn: (e: DocumentEdit) => DocumentEdit,
) => ({
  ...d,
  edits: d.edits.map((e) => (e.id === id ? fn(e) : e)),
});
export const removeItem = (d: DocumentDefinition, s: NonNullable<Selected>): DocumentDefinition =>
  s.kind === 'field'
    ? { ...d, fields: d.fields.filter((f) => f.id !== s.id), presets: withoutKey(d.presets, s.id) }
    : { ...d, edits: d.edits.filter((e) => e.id !== s.id) };

function withoutKey<T>(o: Record<string, T>, key: string): Record<string, T> {
  if (!(key in o)) return o;
  const { [key]: _gone, ...rest } = o;
  return rest;
}

/** Field types a role can have: the business before it sends never signs. */
export const typesFor = (role: string): readonly DocumentFieldType[] =>
  role === SENDER_ROLE
    ? DOCUMENT_FIELD_TYPES.filter(
        (t) => t !== 'signature' && t !== 'initials' && t !== 'date_signed',
      )
    : DOCUMENT_FIELD_TYPES;

/** Each signer's colour on the page, in their order; the business's own is slate. */
const ROLE_COLOURS = [
  '#2563eb',
  '#db2777',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#65a30d',
  '#c026d3',
  '#0d9488',
];
export function roleColour(definition: DocumentDefinition, role: string): string {
  if (role === SENDER_ROLE) return '#475569';
  const i = definition.roles.findIndex((r) => r.key === role);
  return ROLE_COLOURS[(i < 0 ? 0 : i) % ROLE_COLOURS.length]!;
}

/** A role key that isn't taken: `customer_2`, `team_1`. */
export function newRoleKey(definition: DocumentDefinition, kind: 'customer' | 'team'): string {
  for (let n = 1; ; n++) {
    const key = n === 1 && kind === 'team' ? 'team' : `${kind}_${n}`;
    if (!definition.roles.some((r) => r.key === key)) return key;
  }
}
