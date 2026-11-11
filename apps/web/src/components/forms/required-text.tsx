'use client';
import { useState, type InputHTMLAttributes } from 'react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * A box whose words the form can't do without: a question, a choice, a button's words. The editor applies an op on
 * every keystroke and the form's parse refuses an empty one ("Write the question."), so selecting it all and
 * pressing Backspace was refused and left the last letter behind. This lets the box be emptied: nothing is sent
 * while it's empty, so the form keeps its last words until the first letter of the new ones goes through as usual.
 *
 * `holdKey` is what the box is for (the question's id, the choice's id), so an emptied box doesn't carry over to the
 * next one. An undo, or a change from anywhere else, shows the new words over the emptied box.
 */
export function useRequiredText(
  holdKey: string,
  value: string,
  save: (text: string) => void,
): {
  /** What the box shows. */
  readonly value: string;
  /** The box is empty, so the form is still keeping `kept`. */
  readonly empty: boolean;
  readonly kept: string;
  readonly onChange: (text: string) => void;
} {
  const [held, setHeld] = useState<{ key: string; from: string; text: string } | null>(null);
  const holding = held !== null && held.key === holdKey && held.from === value;
  return {
    value: holding ? held.text : value,
    empty: holding,
    kept: value.trim(),
    onChange: (text) => {
      if (text.trim()) {
        setHeld(null);
        save(text);
      } else setHeld({ key: holdKey, from: value, text });
    },
  };
}

/** The line under an emptied box, so it's plain the old words stay until new ones are typed. */
export function keptHint(kept: string): string {
  return `Type the new words. Until you do, the form keeps “${kept}”.`;
}

/** A labelled box (one line, or `rows` lines) that can be emptied to retype it. */
export function RequiredField({
  label,
  id,
  hint,
  holdKey,
  value,
  onSave,
  disabled,
  rows,
  maxLength,
  testId,
}: {
  label: string;
  id: string;
  hint?: string;
  holdKey: string;
  value: string;
  onSave: (text: string) => void;
  disabled?: boolean;
  /** A box of several lines. */
  rows?: number;
  maxLength?: number;
  testId?: string;
}) {
  const text = useRequiredText(holdKey, value, onSave);
  const shared = {
    id,
    value: text.value,
    disabled,
    maxLength,
    placeholder: text.empty ? text.kept : undefined,
    'data-testid': testId,
  };
  return (
    <Field label={label} htmlFor={id} hint={text.empty ? keptHint(text.kept) : hint}>
      {rows ? (
        <Textarea {...shared} rows={rows} onChange={(e) => text.onChange(e.target.value)} />
      ) : (
        <Input {...shared} onChange={(e) => text.onChange(e.target.value)} />
      )}
    </Field>
  );
}

/** A bare one-line box that can be emptied to retype it; the words the form keeps show faintly in it meanwhile. */
export function RequiredInput({
  holdKey,
  value,
  onSave,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'placeholder'> & {
  holdKey: string;
  value: string;
  onSave: (text: string) => void;
}) {
  const text = useRequiredText(holdKey, value, onSave);
  return (
    <Input
      {...props}
      value={text.value}
      placeholder={text.empty ? text.kept : undefined}
      onChange={(e) => text.onChange(e.target.value)}
    />
  );
}
