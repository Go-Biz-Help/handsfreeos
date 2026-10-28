'use client';
/**
 * The pages of a template as the editor works on them: fields to place, move and resize, and the PDF's own words to
 * type over (answer 26c). The Send screen uses it too, with the fields fixed, for one customer's own changes (27a).
 *
 * A click on the page does what the tool picked says; with no tool, it picks what's under it. A picked item moves
 * by dragging it and resizes from its corner; each drag is one change for Undo.
 */
import {
  coveredBy,
  DOCUMENT_FIELD_LABELS,
  typeOverLine,
  type DocumentEdit,
  type DocumentField,
  type DocumentValueInput,
} from '@hfos/core';
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { coloursUnder, textRuns, type TextRun } from '@/lib/documents/pdf';
import { cn } from '@/lib/utils';
import {
  moved,
  newField,
  newTextBox,
  roleColour,
  updateEdit,
  updateField,
  type DefinitionEditor,
  type Selected,
  type Tool,
} from './editor-state';
import { boxStyle, EditView, PdfPages, ValueView, type DrawnPage } from './pdf-pages';

interface Drag {
  readonly kind: 'field' | 'edit';
  readonly id: string;
  readonly how: 'move' | 'resize';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly start: { x: number; y: number; w: number; h: number };
  moved: boolean;
}

export function EditorCanvas({
  source,
  editor,
  selected,
  onSelect,
  tool,
  onToolDone,
  role,
  fieldsEditable = true,
  editable = true,
  values,
  testId,
}: {
  source: string | null;
  editor: DefinitionEditor;
  selected: Selected;
  onSelect: (s: Selected) => void;
  tool: Tool;
  onToolDone: () => void;
  /** Who a new field is for. */
  role: string;
  /** False on the Send screen: the fields stay where the template has them. */
  fieldsEditable?: boolean;
  /** False for someone who can only look. */
  editable?: boolean;
  /** What's filled in, shown on the fields (the Send screen). */
  values?: Readonly<Record<string, DocumentValueInput>>;
  testId?: string;
}) {
  const d = editor.definition;
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const [runs, setRuns] = useState<Record<number, TextRun[]>>({});
  const drag = useRef<Drag | null>(null);

  const onDrawn = useCallback(({ index, canvas, page }: DrawnPage) => {
    canvases.current.set(index, canvas);
    void textRuns(page)
      .then((found) => setRuns((was) => ({ ...was, [index]: found })))
      .catch(() => {
        // No words to pick on this page: it can still have text boxes.
      });
  }, []);

  function startDrag(
    e: ReactPointerEvent<HTMLElement>,
    kind: 'field' | 'edit',
    item: { id: string; x: number; y: number; w: number; h: number },
    how: 'move' | 'resize',
  ) {
    if (!editable || (kind === 'field' && !fieldsEditable)) return;
    e.stopPropagation();
    const layer = (
      e.currentTarget.closest('[data-layer]') as HTMLElement | null
    )?.getBoundingClientRect();
    if (!layer) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect({ kind, id: item.id });
    drag.current = {
      kind,
      id: item.id,
      how,
      x: e.clientX,
      y: e.clientY,
      width: layer.width,
      height: layer.height,
      start: { x: item.x, y: item.y, w: item.w, h: item.h },
      moved: false,
    };
  }

  function onMove(e: ReactPointerEvent<HTMLElement>) {
    const g = drag.current;
    if (!g) return;
    const dx = (e.clientX - g.x) / g.width;
    const dy = (e.clientY - g.y) / g.height;
    if (!g.moved && Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) < 3) return;
    g.moved = true;
    const to = moved(g.start, g.how, dx, dy);
    editor.preview((def) =>
      g.kind === 'field'
        ? updateField(def, g.id, (f) => ({ ...f, ...to }))
        : updateEdit(def, g.id, (x) => ({ ...x, ...to })),
    );
  }

  function onUp() {
    const g = drag.current;
    drag.current = null;
    if (g?.moved) editor.commit();
  }

  function place(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    if (!tool || tool.kind === 'words') return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    const page = d.pages[index];
    if (!page) return;
    if (tool.kind === 'field') {
      const f = newField(tool.type, role, page, index, at);
      editor.change((def) => ({ ...def, fields: [...def.fields, f] }));
      onSelect({ kind: 'field', id: f.id });
    } else {
      const t = newTextBox(page, index, at);
      editor.change((def) => ({ ...def, edits: [...def.edits, t] }));
      onSelect({ kind: 'edit', id: t.id });
    }
    onToolDone();
  }

  function typeOver(run: TextRun, index: number) {
    const canvas = canvases.current.get(index);
    const colours = canvas
      ? coloursUnder(canvas, run)
      : { background: '#ffffff', color: '#000000' };
    const edit = typeOverLine(index, run, colours);
    editor.change((def) => ({ ...def, edits: [...def.edits, edit] }));
    onSelect({ kind: 'edit', id: edit.id });
    onToolDone();
  }

  return (
    <PdfPages
      source={source}
      pages={d.pages}
      onDrawn={onDrawn}
      testId={testId}
      layer={({ index, scale }) => (
        <div
          data-layer
          className={cn('absolute inset-0', tool && tool.kind !== 'words' && 'cursor-crosshair')}
          onPointerDown={(e) => {
            if (tool && tool.kind !== 'words') place(e, index);
            else if (e.target === e.currentTarget) onSelect(null);
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {d.edits
            .filter((x) => x.page === index)
            .map((x) => (
              <EditBox
                key={x.id}
                edit={x}
                scale={scale}
                picked={selected?.kind === 'edit' && selected.id === x.id}
                editable={editable}
                onPointerDown={(e, how) => startDrag(e, 'edit', x, how)}
              />
            ))}
          {d.fields
            .filter((f) => f.page === index)
            .map((f) => (
              <FieldBox
                key={f.id}
                field={f}
                colour={roleColour(d, f.role)}
                roleLabel={d.roles.find((r) => r.key === f.role)?.label ?? 'You, before sending'}
                scale={scale}
                value={values?.[f.id] ?? d.presets[f.id]}
                picked={selected?.kind === 'field' && selected.id === f.id}
                movable={editable && fieldsEditable}
                onPointerDown={(e, how) => startDrag(e, 'field', f, how)}
              />
            ))}
          {tool?.kind === 'words'
            ? (runs[index] ?? [])
                .filter((run) => !d.edits.some((x) => x.page === index && coveredBy(run, x)))
                .map((run, i) => (
                  <button
                    key={i}
                    type="button"
                    className="absolute rounded-[2px] bg-accent/10 outline outline-1 outline-accent/40 hover:bg-accent/25"
                    style={boxStyle(run)}
                    title={`Type over “${run.text}”`}
                    aria-label={`Type over “${run.text}”`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      typeOver(run, index);
                    }}
                    data-testid="word-run"
                  />
                ))
            : null}
        </div>
      )}
    />
  );
}

function Handle({ onPointerDown }: { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void }) {
  return (
    <span
      aria-hidden
      className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-[2px] border border-white bg-accent shadow-1"
      onPointerDown={onPointerDown}
    />
  );
}

function EditBox({
  edit,
  scale,
  picked,
  editable,
  onPointerDown,
}: {
  edit: DocumentEdit;
  scale: number;
  picked: boolean;
  editable: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, how: 'move' | 'resize') => void;
}) {
  return (
    <>
      <EditView edit={edit} scale={scale} />
      <div
        role="button"
        tabIndex={-1}
        aria-label={edit.original ? `Changed words: ${edit.original}` : 'Added words'}
        className={cn(
          'absolute touch-none',
          editable && 'cursor-move',
          picked
            ? 'outline outline-2 outline-accent'
            : 'outline-dashed outline-1 outline-accent/50 hover:outline-accent',
        )}
        style={boxStyle(edit)}
        onPointerDown={(e) => onPointerDown(e, 'move')}
        data-testid="edit-box"
      >
        {picked && editable ? <Handle onPointerDown={(e) => onPointerDown(e, 'resize')} /> : null}
      </div>
    </>
  );
}

function FieldBox({
  field,
  colour,
  roleLabel,
  scale,
  value,
  picked,
  movable,
  onPointerDown,
}: {
  field: DocumentField;
  colour: string;
  roleLabel: string;
  scale: number;
  value: DocumentValueInput | undefined;
  picked: boolean;
  movable: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, how: 'move' | 'resize') => void;
}) {
  const name = field.label || DOCUMENT_FIELD_LABELS[field.type];
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={`${name}, for ${roleLabel}`}
      title={`${name} · ${roleLabel}`}
      className={cn('absolute touch-none rounded-[3px] border', movable && 'cursor-move')}
      style={{
        ...boxStyle(field),
        borderColor: colour,
        background: value ? `${colour}10` : `${colour}26`,
        boxShadow: picked ? `0 0 0 2px ${colour}` : undefined,
      }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      data-testid="field-box"
      data-field-type={field.type}
    >
      {value ? (
        <ValueView value={value} type={field.type} fontSize={field.fontSize} scale={scale} />
      ) : (
        <span
          className="pointer-events-none flex h-full w-full items-center overflow-hidden whitespace-nowrap px-1 font-medium"
          style={{ color: colour, fontSize: Math.max(8, Math.min(12, field.fontSize * scale)) }}
        >
          {field.type === 'checkbox' ? '' : `${name}${field.required ? ' *' : ''}`}
        </span>
      )}
      {picked && movable ? <Handle onPointerDown={(e) => onPointerDown(e, 'resize')} /> : null}
    </div>
  );
}
