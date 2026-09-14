'use client';
import { render, smsSegments, templateVars, type TemplateVariable } from '@hfos/core';
import { AlertTriangle, Braces, Eye, Search } from 'lucide-react';
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CustomerPicker } from '@/components/calendar/customer-picker';
import { Button } from '@/components/ui/button';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { useEditor } from './editor-context';

const SOURCE_LABELS: Record<string, string> = {
  person: 'Customer',
  lead: 'Lead',
  appointment: 'Appointment',
  conversation: 'Conversation',
  business: 'Business',
  links: 'Links',
  workflow: 'Workflow',
  ai: 'AI results',
};

/** The `{{` a caret sits in: where it starts and what's been typed after it. */
function openTag(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('{{');
  if (open < 0 || before.lastIndexOf('}}') > open) return null;
  const query = before.slice(open + 2);
  if (query.length > 40 || /[\n{}|]/.test(query)) return null;
  return { start: open, query: query.trim().toLowerCase() };
}

/**
 * A message field that knows the workflow's variables. Typing `{{` (or "Insert a detail") opens a list of
 * the details known at this step; the preview fills them in for the sample customer, and flags a variable
 * the step can't use or one that's blank for that customer.
 */
export function VariableField({
  id: idProp,
  label,
  value,
  onChange,
  variables,
  multiline,
  rows = 4,
  error,
  hint,
  maxLength,
  placeholder,
  preview,
  testId,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** What this step can use (core's `variablesAt`). */
  variables: readonly TemplateVariable[];
  multiline?: boolean;
  rows?: number;
  error?: string | null;
  hint?: ReactNode;
  maxLength?: number;
  placeholder?: string;
  /** Show a live preview: a text bubble with the segment count, or an email body. */
  preview?: 'sms' | 'email' | 'plain';
  testId?: string;
}) {
  const { values, timeZone, sample, readOnly } = useEditor();
  const auto = useId();
  const id = idProp ?? auto;
  const field = () => document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  const [tag, setTag] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);

  const known = useMemo(() => new Set(variables.map((v) => v.path)), [variables]);
  const matches = useMemo(() => {
    if (!tag) return [];
    return variables.filter(
      (v) => !tag.query || v.path.includes(tag.query) || v.label.toLowerCase().includes(tag.query),
    );
  }, [tag, variables]);
  const groups = useMemo(() => {
    const out: { source: string; items: TemplateVariable[] }[] = [];
    for (const v of matches) {
      const g = out.find((x) => x.source === v.source);
      if (g) g.items.push(v);
      else out.push({ source: v.source, items: [v] });
    }
    return out;
  }, [matches]);
  const flat = groups.flatMap((g) => g.items);

  const unknown = templateVars(value).filter((v) => !v.valid || !known.has(v.path));
  const rendered = useMemo(() => render(value, values, { timeZone }), [value, values, timeZone]);
  const blank = rendered.missing.filter((p) => known.has(p));

  const sync = (text: string, caret: number | null) => {
    const next = caret === null ? null : openTag(text, caret);
    setTag(next);
    setActive(0);
  };

  function insert(v: TemplateVariable) {
    const el = field();
    if (!el || !tag) return;
    const caret = el.selectionStart ?? value.length;
    let rest = value.slice(caret);
    if (rest.startsWith('}}')) rest = rest.slice(2);
    const token = `{{${v.path}}}`;
    const next = value.slice(0, tag.start) + token + rest;
    onChange(next);
    setTag(null);
    const at = tag.start + token.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  function openPicker() {
    const el = field();
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const next = `${value.slice(0, caret)}{{${value.slice(caret)}`;
    onChange(next);
    setTag({ start: caret, query: '' });
    setActive(0);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret + 2, caret + 2);
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!tag || !flat.length) {
      if (tag && e.key === 'Escape') setTag(null);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + flat.length) % flat.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insert(flat[active]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setTag(null);
    }
  }

  const shared = {
    id,
    value,
    maxLength,
    placeholder,
    readOnly,
    'aria-invalid': !!error || undefined,
    'aria-describedby': error ? `${id}-error` : undefined,
    'data-testid': testId,
    onKeyDown,
    onBlur: () => setTimeout(() => setTag(null), 150),
    onClick: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
      sync(e.currentTarget.value, e.currentTarget.selectionStart),
    onKeyUp: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
        sync(e.currentTarget.value, e.currentTarget.selectionStart);
    },
  };

  const seg = preview === 'sms' ? smsSegments(rendered.text) : null;
  const segLabel = seg
    ? (() => {
        const single = seg.encoding === 'gsm7' ? 160 : 70;
        const parts = Math.max(1, seg.segments);
        const limit = parts === 1 ? single : parts * seg.perSegment;
        return `${seg.units} of ${limit} · ${parts} ${parts === 1 ? 'text' : 'texts'}`;
      })()
    : null;

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        {multiline ? (
          <Textarea
            rows={rows}
            invalid={!!error}
            className="text-[14px] leading-[1.6]"
            {...shared}
            onChange={(e) => {
              onChange(e.target.value);
              sync(e.target.value, e.target.selectionStart);
            }}
          />
        ) : (
          <Input
            inputSize="sm"
            invalid={!!error}
            {...shared}
            onChange={(e) => {
              onChange(e.target.value);
              sync(e.target.value, e.target.selectionStart);
            }}
          />
        )}
        {tag ? (
          <div
            className="absolute left-0 right-0 top-full z-40 mt-1 rounded-[10px] border border-border bg-card p-1.5 shadow-2"
            data-testid="variable-picker"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex items-center gap-1.5 border-b border-border px-1.5 pb-1.5 pt-1 text-xs text-text-3">
              <Search className="h-3.5 w-3.5" strokeWidth={1.5} />
              {tag.query ? `Details matching “${tag.query}”` : 'Type to search the details'}
            </div>
            <div className="max-h-[240px] overflow-y-auto" role="listbox" aria-label="Details">
              {groups.map((g) => (
                <div key={g.source}>
                  <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
                    {SOURCE_LABELS[g.source] ?? g.source}
                  </div>
                  {g.items.map((v) => {
                    const i = flat.indexOf(v);
                    return (
                      <button
                        key={v.path}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        data-testid={`variable-${v.path}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => insert(v)}
                        className={cn(
                          'flex min-h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px]',
                          i === active ? 'bg-accent-soft' : 'hover:bg-card-2',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{v.label}</span>
                        <span className="font-mono text-[11.5px] text-text-3">{v.path}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {!flat.length ? (
                <div className="px-2 py-2 text-[13px] text-text-3">No detail matches.</div>
              ) : null}
            </div>
            <div className="mt-1 border-t border-border px-2 pb-0.5 pt-1.5 text-xs text-text-3">
              Only details known at this step are listed.
            </div>
          </div>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {readOnly ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="h-[26px] px-1.5 text-xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openPicker}
          >
            <Braces className="h-3.5 w-3.5" strokeWidth={1.5} />
            Insert a detail
          </Button>
        )}
        <span className="flex-1" />
        {segLabel ? (
          <span
            className="whitespace-nowrap text-xs tabular-nums text-text-3"
            data-testid="segment-counter"
          >
            {segLabel}
          </span>
        ) : null}
      </div>
      {error ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : hint ? (
        <Hint>{hint}</Hint>
      ) : null}
      {unknown.map((v) => (
        <Flag key={v.raw} testId="variable-unknown">
          {v.valid ? `{{${v.path}}} isn’t available in this step.` : `{{${v.raw}}} isn’t a detail.`}
        </Flag>
      ))}
      {preview ? (
        <div className="mt-3.5">
          <PreviewLabel />
          {preview === 'sms' ? (
            <div
              className="max-w-full self-start whitespace-pre-wrap break-words rounded-2xl rounded-bl-[5px] bg-card-2 px-[13px] py-2.5 text-[13px] leading-[1.45]"
              data-testid="message-preview"
            >
              {rendered.text || ' '}
            </div>
          ) : (
            <div
              className="whitespace-pre-wrap break-words rounded-[10px] border border-border bg-card-2 px-3 py-2.5 text-[13px] leading-[1.5]"
              data-testid="message-preview"
            >
              {rendered.text || ' '}
            </div>
          )}
          {blank.map((p) => (
            <Flag key={p} testId="variable-blank">
              {`{{${p}}} is blank for ${sample?.fullName ?? 'this customer'}. Without a default, the step is skipped for them.`}
            </Flag>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Flag({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      className="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-warning-text"
      data-testid={testId}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      <span>{children}</span>
    </p>
  );
}

/** "Preview for Mike Johnson (test contact)", with Change to pick another customer. */
export function PreviewLabel() {
  const { sample, setSample, workspaceId, readOnly } = useEditor();
  const [picking, setPicking] = useState(false);
  async function pick(id: string) {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/person.get', { body: { workspaceId, personId: id } }),
      );
      const p = out.person;
      setSample({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        fullName: p.fullName,
        email: p.email,
        phone: p.phone,
        city: p.address?.city ?? null,
      });
      setPicking(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  return (
    <>
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
        <Eye className="h-4 w-4 text-text-3" strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate" data-testid="preview-for">
          {sample ? `Preview for ${sample.fullName} (test contact)` : 'Preview with sample details'}
        </span>
        {readOnly ? null : (
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            className="text-xs font-medium text-accent-text hover:underline"
          >
            {picking ? 'Done' : 'Change'}
          </button>
        )}
      </div>
      {picking ? (
        <div className="mb-2">
          <CustomerPicker
            workspaceId={workspaceId}
            value={null}
            onChange={(c) => {
              if (c) void pick(c.id);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
