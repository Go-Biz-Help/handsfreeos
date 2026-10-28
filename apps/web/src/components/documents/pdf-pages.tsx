'use client';
/**
 * A document's pages, drawn from its PDF, each with a layer on top for what's placed on it: fields, the words typed
 * over, what was filled in. Positions are fractions of the page (core's definition.ts), so the layer is laid out in
 * percentages and only a font size needs the scale (pixels per point).
 *
 * Each page is drawn when it comes near the screen and again when the column changes width. Until then, and when
 * the PDF can't be read, the page is a white sheet of the right shape, so what's on top still lands where it goes.
 */
import {
  documentDay,
  type DocumentEdit,
  type DocumentPage,
  type DocumentValueInput,
} from '@hfos/core';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  EDIT_FONT_FAMILIES,
  openPdf,
  renderPage,
  type PdfDocument,
  type PdfPage,
} from '@/lib/documents/pdf';
import { cn } from '@/lib/utils';

export interface PageLayer {
  readonly index: number;
  /** Pixels per point at the width it's drawn. */
  readonly scale: number;
  readonly size: DocumentPage;
}

export interface DrawnPage {
  readonly index: number;
  readonly canvas: HTMLCanvasElement;
  readonly page: PdfPage;
}

/** A box on the page from its fractions. */
export const boxStyle = (b: { x: number; y: number; w: number; h: number }): CSSProperties => ({
  left: `${b.x * 100}%`,
  top: `${b.y * 100}%`,
  width: `${b.w * 100}%`,
  height: `${b.h * 100}%`,
});

export function PdfPages({
  source,
  pages,
  layer,
  maxWidth = 880,
  onDrawn,
  onDocument,
  className,
  testId,
}: {
  /** A short-lived link to the PDF, or its bytes. Null draws blank pages. */
  source: string | ArrayBuffer | null;
  pages: readonly DocumentPage[];
  layer?: (page: PageLayer) => ReactNode;
  maxWidth?: number;
  onDrawn?: (drawn: DrawnPage) => void;
  onDocument?: (doc: PdfDocument) => void;
  className?: string;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const onDocumentRef = useRef(onDocument);
  onDocumentRef.current = onDocument;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(maxWidth, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);

  useEffect(() => {
    if (!source) {
      setDoc(null);
      return;
    }
    let live = true;
    let opened: PdfDocument | null = null;
    setFailed(false);
    openPdf(source)
      .then((d) => {
        opened = d;
        if (!live) return void d.loadingTask.destroy();
        setDoc(d);
        onDocumentRef.current?.(d);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      void opened?.loadingTask.destroy();
    };
  }, [source]);

  return (
    <div
      ref={box}
      className={cn('flex w-full flex-col items-center gap-4', className)}
      data-testid={testId}
    >
      {failed ? (
        <p role="alert" className="text-[13px] text-danger-text">
          The PDF didn’t open. Refresh the page to try again.
        </p>
      ) : null}
      {width > 0
        ? pages.map((size, index) => (
            <PageView
              key={index}
              index={index}
              count={pages.length}
              size={size}
              width={width}
              doc={doc}
              layer={layer}
              onDrawn={onDrawn}
            />
          ))
        : null}
    </div>
  );
}

function PageView({
  index,
  count,
  size,
  width,
  doc,
  layer,
  onDrawn,
}: {
  index: number;
  count: number;
  size: DocumentPage;
  width: number;
  doc: PdfDocument | null;
  layer?: (page: PageLayer) => ReactNode;
  onDrawn?: (drawn: DrawnPage) => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const onDrawnRef = useRef(onDrawn);
  onDrawnRef.current = onDrawn;
  const height = Math.round((width * size.height) / size.width);

  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      {
        rootMargin: '800px 0px',
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !near || !canvas.current) return;
    let live = true;
    let cancel: (() => void) | null = null;
    const timer = setTimeout(() => {
      void doc
        .getPage(index + 1)
        .then((page) => {
          if (!live || !canvas.current) return;
          const task = renderPage(page, canvas.current, width);
          cancel = task.cancel;
          return task.done.then(() => {
            if (!live || !canvas.current) return;
            setDrawn(true);
            onDrawnRef.current?.({ index, canvas: canvas.current, page });
          });
        })
        .catch(() => {
          // The white sheet stays: what's on it still lines up.
        });
    }, 60);
    return () => {
      live = false;
      clearTimeout(timer);
      cancel?.();
    };
  }, [doc, near, index, width]);

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        ref={sheet}
        className="relative overflow-hidden border border-border bg-white shadow-1"
        style={{ width, height }}
        data-testid={`document-page-${index}`}
      >
        <canvas
          ref={canvas}
          aria-hidden
          className={cn(
            'absolute inset-0 h-full w-full transition-opacity',
            drawn ? 'opacity-100' : 'opacity-0',
          )}
        />
        {layer ? (
          <div className="absolute inset-0">
            {layer({ index, scale: width / size.width, size })}
          </div>
        ) : null}
      </div>
      {count > 1 ? (
        <span className="text-[11.5px] text-text-3">
          Page {index + 1} of {count}
        </span>
      ) : null}
    </div>
  );
}

/** Words typed over the PDF (answer 26c): the old ones covered in the paper's colour, the new ones written on it. */
export function EditView({ edit, scale }: { edit: DocumentEdit; scale: number }) {
  return (
    <div
      className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap break-words leading-[1.15]"
      style={{
        ...boxStyle(edit),
        background: edit.background,
        color: edit.color,
        fontFamily: EDIT_FONT_FAMILIES[edit.font],
        fontWeight: edit.bold ? 700 : 400,
        fontSize: edit.size * scale,
      }}
    >
      {edit.text}
    </div>
  );
}

/** What was filled in a field, drawn the way the signed copy draws it. */
export function ValueView({
  value,
  type,
  fontSize,
  scale,
}: {
  value: DocumentValueInput;
  type: string;
  fontSize: number;
  scale: number;
}) {
  if (value.kind === 'signature')
    return (
      <img
        src={value.image}
        alt={`Signed by ${value.name}`}
        className="h-full w-full object-contain"
      />
    );
  if (value.kind === 'check')
    return value.checked ? (
      <X className="h-full w-full text-[#111827]" strokeWidth={2.5} aria-label="Ticked" />
    ) : null;
  const text = value.kind === 'date' ? documentDay(value.date) : value.text;
  return (
    <span
      className={cn(
        'block h-full w-full overflow-hidden px-[2px] leading-[1.2] text-[#111827]',
        type === 'long_text'
          ? 'whitespace-pre-wrap break-words'
          : 'flex items-center whitespace-nowrap',
      )}
      style={{ fontFamily: EDIT_FONT_FAMILIES.sans, fontSize: fontSize * scale }}
    >
      {text}
    </span>
  );
}
