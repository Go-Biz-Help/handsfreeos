'use client';
import { Info, Lock, Plus, X, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** A module's title and what it's for. Skills get their on/off switch on the right. */
export function ModuleHeading({
  title,
  description,
  skill,
}: {
  title: string;
  description: ReactNode;
  skill?: { on: boolean; onChange: (on: boolean) => void; label: string; testId?: string };
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-[-0.005em]">{title}</h2>
        <p className="mt-1 text-[13px] text-text-2">{description}</p>
      </div>
      {skill ? (
        <label className="flex flex-none items-center gap-2 pt-1 text-[13px] font-semibold">
          {skill.on ? 'On' : 'Off'}
          <Switch
            checked={skill.on}
            onChange={skill.onChange}
            label={skill.label}
            testId={skill.testId}
          />
        </label>
      ) : null}
    </div>
  );
}

/** A label over a group of controls inside a module. */
export function GroupLabel({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={cn('mb-2 mt-5 text-[13px] font-medium', className)}>
      {children}
    </div>
  );
}

export function RadioDot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
        on ? 'border-accent' : 'border-border-strong',
        className,
      )}
    >
      {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
    </span>
  );
}

/** A pick-one card: a radio dot, a title and a line under it. Put it in a `role="radiogroup"`. */
export function Choice({
  on,
  onSelect,
  title,
  description,
  badge,
  children,
  compact,
  disabled,
  testId,
  className,
}: {
  on: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Beside the title ("Recommended"). */
  badge?: ReactNode;
  /** Under the description (a warning line). Nothing interactive: this is a button. */
  children?: ReactNode;
  /** The rail's smaller rows. */
  compact?: boolean;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-[9px] border text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        compact ? 'px-2.5 py-[7px]' : 'px-[13px] py-[11px]',
        on
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
          : 'border-border-strong bg-card enabled:hover:bg-card-2',
        className,
      )}
    >
      <RadioDot on={on} className="mt-px" />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
          {title}
          {badge}
        </span>
        {description ? <span className="text-xs text-text-2">{description}</span> : null}
        {children}
      </span>
    </button>
  );
}

/** A quiet grey note. */
export function Note({
  icon: Icon = Info,
  children,
  className,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2',
        className,
      )}
    >
      <Icon className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

const CALLOUT = {
  info: 'bg-accent-soft text-accent-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
} as const;

export function Callout({
  tone = 'info',
  icon: Icon = Info,
  children,
  className,
  testId,
}: {
  tone?: keyof typeof CALLOUT;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-start gap-2.5 rounded-menu px-3.5 py-3 text-[13px] leading-[1.45]',
        CALLOUT[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A rule that can't be switched off ("Always"). */
export function Locked({ children = 'Always' }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-text-3">
      <Lock className="h-3 w-3" strokeWidth={1.75} />
      {children}
    </span>
  );
}

/** A small pill: a choice, a topic, a person. Removable with its ×, or marked as always on. */
export function Chip({
  children,
  size = 'sm',
  tone = 'plain',
  onRemove,
  removeLabel,
  locked,
  title,
  avatar,
  testId,
}: {
  children: ReactNode;
  size?: 'sm' | 'md';
  /** `bad`: an answer that rules a lead out. */
  tone?: 'plain' | 'bad';
  onRemove?: () => void;
  removeLabel?: string;
  /** Always on: a lock instead of the ×. */
  locked?: boolean;
  title?: string;
  avatar?: ReactNode;
  testId?: string;
}) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border',
        size === 'md' ? 'h-[30px] text-[13px]' : 'h-[26px] text-[12.5px]',
        onRemove || locked ? (size === 'md' ? 'pl-2.5 pr-1.5' : 'pl-[9px] pr-[5px]') : 'px-2.5',
        tone === 'bad'
          ? 'border-transparent bg-danger-soft text-danger-text'
          : 'border-border bg-card-2 text-text',
      )}
    >
      {avatar}
      <span className="truncate">{children}</span>
      {locked ? (
        <Lock aria-hidden className="h-3 w-3 flex-none text-text-3" strokeWidth={1.75} />
      ) : null}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-current opacity-70 hover:bg-card-3 hover:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          <X className="h-3 w-3" strokeWidth={2} />
        </button>
      ) : null}
    </span>
  );
}

/**
 * A chip whose words can be changed: clicking them turns it into a box. Enter or leaving the box keeps the
 * change (on Enter a refused value stays for fixing), Escape puts it back. The × still removes it.
 */
export function EditableChip({
  value,
  onRename,
  onRemove,
  editLabel,
  removeLabel,
  maxLength,
  testId,
}: {
  value: string;
  /** Returns whether it was changed. */
  onRename: (next: string) => boolean;
  onRemove?: () => void;
  editLabel: string;
  removeLabel?: string;
  maxLength?: number;
  testId?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const closed = useRef(false);
  const finish = (keep: boolean, stayIfRefused: boolean) => {
    if (closed.current) return;
    const v = (text ?? '').trim();
    if (keep && v && v !== value && !onRename(v) && stayIfRefused) return;
    closed.current = true;
    setText(null);
  };
  if (text !== null)
    return (
      <input
        autoFocus
        aria-label={editLabel}
        value={text}
        maxLength={maxLength}
        data-testid={testId ? `${testId}-input` : undefined}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false, false);
          }
        }}
        onBlur={() => finish(true, false)}
        className="h-[26px] w-44 rounded-full border border-accent bg-card px-2.5 text-[12.5px] text-text placeholder:text-placeholder focus:outline-none focus:ring-[3px] focus:ring-ring"
      />
    );
  return (
    <Chip onRemove={onRemove} removeLabel={removeLabel} testId={testId}>
      <button
        type="button"
        aria-label={editLabel}
        title="Click to change"
        onClick={() => {
          closed.current = false;
          setText(value);
        }}
        className="max-w-full cursor-text truncate rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        {value}
      </button>
    </Chip>
  );
}

/**
 * "+ Add a choice": a dashed pill that turns into a box. Enter adds (a refused value stays for fixing),
 * Escape or leaving the box ends it.
 */
export function AddChip({
  label,
  placeholder,
  onAdd,
  maxLength,
  size = 'sm',
  testId,
}: {
  label: string;
  placeholder: string;
  /** Returns whether it was added. */
  onAdd: (value: string) => boolean;
  maxLength?: number;
  size?: 'sm' | 'md';
  testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const closed = useRef(false);
  const height = size === 'md' ? 'h-[30px] text-[13px]' : 'h-[26px] text-[12.5px]';
  const finish = (keep: boolean, stayIfRefused: boolean) => {
    if (closed.current) return;
    const v = value.trim();
    if (keep && v && !onAdd(v) && stayIfRefused) return;
    closed.current = true;
    setValue('');
    setEditing(false);
  };
  if (editing)
    return (
      <input
        autoFocus
        aria-label={label}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        data-testid={testId ? `${testId}-input` : undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const v = value.trim();
            if (v && onAdd(v)) setValue('');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false, false);
          }
        }}
        onBlur={() => finish(true, false)}
        className={cn(
          'w-44 rounded-full border border-accent bg-card px-2.5 text-text placeholder:text-placeholder focus:outline-none focus:ring-[3px] focus:ring-ring',
          height,
        )}
      />
    );
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => {
        closed.current = false;
        setEditing(true);
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-dashed border-border-strong px-[9px] text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        height,
      )}
    >
      <Plus className="h-3 w-3" strokeWidth={2} />
      {label}
    </button>
  );
}

/**
 * A text setting that edits the draft as you type (one Undo step per field). A value the settings refuse
 * is kept in the box with the reason under it, and leaving the box goes back to the last good value.
 */
export function DraftText({
  id,
  label,
  hint,
  value,
  onChange,
  multiline,
  rows = 3,
  maxLength,
  placeholder,
  ariaLabel,
  className,
  inputClassName,
  testId,
}: {
  id: string;
  label?: string;
  hint?: ReactNode;
  value: string;
  /** Returns why the value was refused, or null. */
  onChange: (next: string) => string | null;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  /** When there's no visible label. */
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
  testId?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const props = {
    id,
    value: text ?? value,
    maxLength,
    placeholder,
    'aria-label': label ? undefined : ariaLabel,
    'aria-describedby': error ? `${id}-error` : undefined,
    'data-testid': testId,
    invalid: !!error,
    onBlur: () => {
      setText(null);
      setError(null);
    },
  };
  const change = (next: string) => {
    setText(next);
    setError(onChange(next));
  };
  return (
    <div className={className}>
      {label ? <Label htmlFor={id}>{label}</Label> : null}
      {multiline ? (
        <Textarea
          {...props}
          rows={rows}
          className={cn('min-h-0', inputClassName)}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <Input {...props} className={inputClassName} onChange={(e) => change(e.target.value)} />
      )}
      {error ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : hint ? (
        <Hint>{hint}</Hint>
      ) : null}
    </div>
  );
}
