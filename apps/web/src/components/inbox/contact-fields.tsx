'use client';
import {
  CONTACT_EDIT_WORDS,
  joinName,
  nameProblem,
  noteProblem,
  splitName,
  THREAD_NOTE_WORDS,
} from '@hfos/core';
import { Check, Pencil, UserPlus } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import { cn } from '@/lib/utils';

/**
 * One line of the customer, edited where it is read (M10 step 15, continued).
 *
 * Click the value, type over it, and it saves when you leave it. Enter saves, Escape puts back what was there.
 * Blur saves too, because in an inbox the way you leave a field is by clicking the next thing — a dialog's
 * "Cancel unless you press Save" would lose the edit every time.
 *
 * `onSave` is given the new text and answers whether it stuck; a false puts the old value back, so a number the
 * server rejects does not sit in the panel looking saved.
 */
export function InlineField({
  icon: Icon,
  label,
  value,
  empty,
  placeholder,
  type = 'text',
  disabled,
  onSave,
  testId,
  className,
}: {
  icon: typeof Pencil;
  /** What editing this does, for a screen reader: the field itself shows the value. */
  label: string;
  value: string;
  /** Shown in place of a value nobody has filled in; clicking it starts the edit. */
  empty: string;
  placeholder: string;
  type?: 'text' | 'tel' | 'email';
  disabled?: boolean;
  onSave: (next: string) => Promise<boolean>;
  testId?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  // Escape blurs the input to leave it, which would otherwise be taken for "leaving the field" and save.
  const cancelled = useRef(false);

  function start() {
    if (disabled) return;
    setDraft(value);
    cancelled.current = false;
    setEditing(true);
  }

  async function commit() {
    // Disabling a focused input blurs it in some browsers, which would land back here mid-save.
    if (cancelled.current || busy) return;
    const next = draft.trim();
    if (next === value.trim()) return setEditing(false);
    setBusy(true);
    const ok = await onSave(next);
    setBusy(false);
    // A rejected edit stays open with what was typed still there, so it can be fixed rather than retyped.
    if (ok) setEditing(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled.current = true;
      setDraft(value);
      setEditing(false);
    }
  }

  if (editing)
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Icon className="h-3.5 w-3.5 flex-none text-text-2" strokeWidth={1.5} />
        <Input
          autoFocus
          inputSize="sm"
          type={type}
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => void commit()}
          data-testid={testId ? `${testId}-input` : undefined}
        />
      </div>
    );

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      className={cn(
        'group -mx-1.5 flex items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left text-[13px] text-text-2',
        disabled ? 'cursor-default' : 'hover:bg-card-2',
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      <span className={cn('truncate', !value && 'text-text-3')}>{value || empty}</span>
      {disabled ? null : busy ? (
        <Check className="h-3 w-3 flex-none opacity-50" strokeWidth={2} />
      ) : (
        <Pencil
          className="h-3 w-3 flex-none opacity-0 transition-opacity group-hover:opacity-60"
          strokeWidth={1.75}
        />
      )}
    </button>
  );
}

/**
 * The note box under the customer, in the panel beside their conversation.
 *
 * A note is an `activity` of kind `note` on the customer, so it lands on their timeline and shows inline in the
 * thread — `message-log.tsx` has folded notes in since the phone put them there. The web could read them and not
 * write them; this is the other half.
 */
export function NoteBox({
  workspaceId,
  personId,
  onAdded,
}: {
  workspaceId: string;
  personId: string;
  onAdded: () => void;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    const problem = noteProblem(body);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/activity.log', {
          body: { workspaceId, kind: 'note', body: body.trim(), personId },
        }),
      );
      setBody('');
      toast.success(CONTACT_EDIT_WORDS.noteAdded);
      onAdded();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        className="min-h-[60px] text-[13px]"
        placeholder={CONTACT_EDIT_WORDS.notePlaceholder}
        aria-label={THREAD_NOTE_WORDS.add}
        value={body}
        invalid={!!error}
        onChange={(e) => {
          setBody(e.target.value);
          if (error) setError(null);
        }}
        // Ctrl/Cmd+Enter sends, the way the composer above it does.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void add();
          }
        }}
        data-testid="note-body"
      />
      <FieldError>{error}</FieldError>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-3">{THREAD_NOTE_WORDS.explain}</span>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={!body.trim()}
          onClick={() => void add()}
          data-testid="note-save"
        >
          {CONTACT_EDIT_WORDS.noteSave}
        </Button>
      </div>
    </div>
  );
}

/**
 * Naming an unknown number, in the panel rather than through a dialog.
 *
 * Most of the time all anybody knows at this point is a name — the number is already in front of them, and it is
 * what the conversation is. So the panel asks for the one thing it is missing and creates the customer with the
 * number attached. Everything else (address, company, tags) is a click further on, in the full form.
 *
 * A number that turns out to belong to somebody already is not an error worth a dialog: it means link, not add,
 * so the duplicate is reported where the link button already is.
 */
export function AddPersonInline({
  workspaceId,
  phone,
  email,
  defaultName,
  onCreated,
  onMoreDetails,
}: {
  workspaceId: string;
  /** The number this conversation is with, or nothing for a website chat with no number. */
  phone: string | null;
  email: string | null;
  /** What a website chat's visitor called themselves, if anything. */
  defaultName?: string;
  onCreated: (personId: string) => void;
  onMoreDetails: () => void;
}) {
  const [name, setName] = useState(defaultName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    const problem = nameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/person.create', {
          body: {
            workspaceId,
            ...splitName(name),
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
          },
        }),
      );
      toast.success(CONTACT_EDIT_WORDS.added(joinName(splitName(name))));
      onCreated(out.personId);
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'duplicate') setError(CONTACT_EDIT_WORDS.duplicate);
      else {
        const fe = fieldErrors(e);
        if (fe.firstName || fe.phone || fe.email)
          setError(fe.firstName ?? fe.phone ?? fe.email ?? null);
        else toast.error(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        inputSize="sm"
        aria-label={CONTACT_EDIT_WORDS.addTitle}
        placeholder={CONTACT_EDIT_WORDS.namePlaceholder}
        value={name}
        invalid={!!error}
        onChange={(e) => {
          setName(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void add();
          }
        }}
        data-testid="inline-person-name"
      />
      <FieldError>{error}</FieldError>
      <Button size="sm" loading={busy} onClick={() => void add()} data-testid="inline-person-save">
        <UserPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
        {CONTACT_EDIT_WORDS.addSave}
      </Button>
      <button
        type="button"
        onClick={onMoreDetails}
        className="self-start text-[12.5px] font-medium text-accent-text hover:underline"
        data-testid="inline-person-more"
      >
        {CONTACT_EDIT_WORDS.moreDetails}
      </button>
    </div>
  );
}
