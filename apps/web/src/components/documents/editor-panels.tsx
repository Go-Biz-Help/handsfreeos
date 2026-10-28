'use client';
/**
 * The template editor's side panels: who signs, what can be put on the page, and the settings of what's picked or of
 * the whole template. The Send screen borrows the settings and the word changes.
 */
import {
  DEFAULT_REMIND_AFTER_DAYS,
  DEFAULT_REMIND_EVERY_DAYS,
  DOCUMENT_FIELD_LABELS,
  DOCUMENT_FONTS,
  DOCUMENT_EDITOR_WORDS as E,
  DOCUMENT_SCREEN_WORDS as W,
  documentRoleName,
  FIELD_PROMPTS,
  FILL_SOURCES,
  FILL_SOURCE_KEYS,
  MAX_DOCUMENT_ROLES,
  NO_FILL_TYPES,
  retypedField,
  SENDER_ROLE,
  withoutRole,
  withRoleAdded,
  withRoleChanged,
  withRoleMoved,
  type DocumentEdit,
  type DocumentField,
  type DocumentFieldType,
  type DocumentSettings,
  type FillSource,
} from '@hfos/core';
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  CalendarCheck,
  CheckSquare,
  SquareChevronDown,
  Hash,
  Mail,
  Phone,
  Plus,
  Signature,
  TextCursorInput,
  Trash2,
  Type,
  User,
  AlignLeft,
  PenLine,
  Replace,
  type LucideIcon,
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { roleColour, typesFor, type DefinitionEditor, type Tool } from './editor-state';

export const FIELD_ICONS: Readonly<Record<DocumentFieldType, LucideIcon>> = {
  signature: Signature,
  initials: PenLine,
  date_signed: CalendarCheck,
  name: User,
  email: Mail,
  phone: Phone,
  text: TextCursorInput,
  long_text: AlignLeft,
  number: Hash,
  date: Calendar,
  checkbox: CheckSquare,
  choice: SquareChevronDown,
};

export const SENDER_LABEL = E.sender;

export function PanelTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {children}
      </h3>
      {aside}
    </div>
  );
}

const Dot = ({ colour }: { colour: string }) => (
  <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: colour }} />
);

// ---------- who signs ----------

export function RolesPanel({
  editor,
  role,
  onRole,
  editable,
}: {
  editor: DefinitionEditor;
  role: string;
  onRole: (role: string) => void;
  editable: boolean;
}) {
  const d = editor.definition;
  const count = (key: string) => d.fields.filter((f) => f.role === key).length;

  function rename(key: string, label: string) {
    editor.change((def) => withRoleChanged(def, key, { label }));
  }
  function setKind(key: string, kind: 'customer' | 'team') {
    editor.change((def) => withRoleChanged(def, key, { kind }));
  }
  function moveRole(key: string, by: -1 | 1) {
    editor.change((def) => withRoleMoved(def, key, by));
  }
  function remove(key: string) {
    const n = count(key);
    const label = d.roles.find((r) => r.key === key)?.label ?? 'them';
    if (n && !window.confirm(E.takeRoleOffAsk(label, n))) return;
    editor.change((def) => withoutRole(def, key));
    if (role === key) onRole(d.roles.find((r) => r.key !== key)?.key ?? SENDER_ROLE);
  }
  function add(kind: 'customer' | 'team') {
    const added = withRoleAdded(d, kind);
    editor.change(() => added.definition);
    onRole(added.key);
  }

  return (
    <div>
      <PanelTitle>Who signs</PanelTitle>
      <div
        className="flex flex-col gap-1.5"
        role="radiogroup"
        aria-label="Who the next field is for"
      >
        {d.roles.map((r, i) => (
          <div
            key={r.key}
            className={cn(
              'rounded-control border px-2 py-1.5',
              role === r.key ? 'border-accent bg-accent-soft/40' : 'border-border bg-card',
            )}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={role === r.key}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onRole(r.key)}
                data-testid={`role-${r.key}`}
              >
                <Dot colour={roleColour(d, r.key)} />
                <span className="truncate text-[13px] font-medium">{r.label}</span>
                <span className="ml-auto flex-none text-[11.5px] text-text-3">{count(r.key)}</span>
              </button>
            </div>
            {editable && role === r.key ? (
              <div className="mt-1.5 flex flex-col gap-1.5">
                <Input
                  inputSize="sm"
                  value={r.label}
                  maxLength={60}
                  aria-label="What they’re called"
                  onChange={(e) => rename(r.key, e.target.value)}
                  data-testid="role-label"
                />
                <div className="flex items-center gap-1">
                  <Select
                    selectSize="sm"
                    value={r.kind}
                    aria-label="Who they are"
                    onChange={(e) => setKind(r.key, e.target.value as 'customer' | 'team')}
                  >
                    <option value="customer">A customer</option>
                    <option value="team">Someone on your team</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Signs earlier"
                    disabled={i === 0}
                    onClick={() => moveRole(r.key, -1)}
                  >
                    <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Signs later"
                    disabled={i === d.roles.length - 1}
                    onClick={() => moveRole(r.key, 1)}
                  >
                    <ArrowDown className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Take ${r.label} off`}
                    disabled={d.roles.length < 2}
                    onClick={() => remove(r.key)}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={role === SENDER_ROLE}
          className={cn(
            'flex items-center gap-2 rounded-control border px-2 py-1.5 text-left',
            role === SENDER_ROLE ? 'border-accent bg-accent-soft/40' : 'border-border bg-card',
          )}
          onClick={() => onRole(SENDER_ROLE)}
          data-testid="role-sender"
        >
          <Dot colour={roleColour(d, SENDER_ROLE)} />
          <span className="truncate text-[13px] font-medium">{SENDER_LABEL}</span>
          <span className="ml-auto flex-none text-[11.5px] text-text-3">{count(SENDER_ROLE)}</span>
        </button>
      </div>
      {editable && d.roles.length < MAX_DOCUMENT_ROLES ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => add('customer')}
            data-testid="role-add-customer"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Customer
          </Button>
          <Button variant="ghost" size="sm" onClick={() => add('team')} data-testid="role-add-team">
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Someone on your team
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------- what can go on the page ----------

export function Palette({
  role,
  roleLabel,
  tool,
  onTool,
  fields = true,
}: {
  role: string;
  roleLabel: string;
  tool: Tool;
  onTool: (tool: Tool) => void;
  /** False on the Send screen: only the words change there. */
  fields?: boolean;
}) {
  const pick = (next: NonNullable<Tool>) =>
    onTool(
      tool &&
        tool.kind === next.kind &&
        (tool.kind !== 'field' || (next.kind === 'field' && tool.type === next.type))
        ? null
        : next,
    );
  const on = (t: NonNullable<Tool>) =>
    !!tool &&
    tool.kind === t.kind &&
    (t.kind !== 'field' || (tool.kind === 'field' && tool.type === t.type));

  return (
    <div className="flex flex-col gap-4">
      {fields ? (
        <div>
          <PanelTitle>Add for {roleLabel}</PanelTitle>
          <div className="grid grid-cols-2 gap-1">
            {typesFor(role).map((type) => {
              const Icon = FIELD_ICONS[type];
              const t = { kind: 'field', type } as const;
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={on(t)}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-control border px-2 text-left text-[12.5px]',
                    on(t)
                      ? 'border-accent bg-accent-soft text-accent-text'
                      : 'border-border bg-card hover:bg-card-2',
                  )}
                  onClick={() => pick(t)}
                  data-testid={`tool-${type}`}
                >
                  <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                  <span className="truncate">{DOCUMENT_FIELD_LABELS[type]}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div>
        <PanelTitle>The PDF’s words</PanelTitle>
        <div className="grid grid-cols-1 gap-1">
          <button
            type="button"
            aria-pressed={on({ kind: 'words' })}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-control border px-2 text-left text-[12.5px]',
              on({ kind: 'words' })
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border bg-card hover:bg-card-2',
            )}
            onClick={() => pick({ kind: 'words' })}
            data-testid="tool-words"
          >
            <Replace className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            Change words
          </button>
          <button
            type="button"
            aria-pressed={on({ kind: 'textbox' })}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-control border px-2 text-left text-[12.5px]',
              on({ kind: 'textbox' })
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border bg-card hover:bg-card-2',
            )}
            onClick={() => pick({ kind: 'textbox' })}
            data-testid="tool-textbox"
          >
            <Type className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            Add words
          </button>
        </div>
      </div>
      {tool ? (
        <p
          className="rounded-control bg-accent-soft px-2.5 py-2 text-[12.5px] text-accent-text"
          data-testid="tool-hint"
        >
          {tool.kind === 'words'
            ? 'Click the words on the page you want to change.'
            : tool.kind === 'textbox'
              ? 'Click where the new words go.'
              : `Click on the page where the ${DOCUMENT_FIELD_LABELS[tool.type].toLowerCase()} goes.`}{' '}
          Press Esc to stop.
        </p>
      ) : null}
    </div>
  );
}

// ---------- what's picked ----------

const FILL_GROUPS = [...new Set(FILL_SOURCE_KEYS.map((k) => FILL_SOURCES[k].group))];

export function FieldSettings({
  editor,
  field,
  onRemove,
}: {
  editor: DefinitionEditor;
  field: DocumentField;
  onRemove: () => void;
}) {
  const id = useId();
  const d = editor.definition;
  const set = (patch: Partial<DocumentField>) =>
    editor.change((def) => ({
      ...def,
      fields: def.fields.map((f) => (f.id === field.id ? { ...f, ...patch } : f)),
    }));

  return (
    <div className="flex flex-col gap-3" data-testid="field-settings">
      <PanelTitle>{DOCUMENT_FIELD_LABELS[field.type]}</PanelTitle>
      <div>
        <Label htmlFor={`${id}-role`}>Who fills it in</Label>
        <Select
          id={`${id}-role`}
          selectSize="sm"
          value={field.role}
          onChange={(e) => set({ role: e.target.value })}
          data-testid="field-role"
        >
          {d.roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
          {typesFor(SENDER_ROLE).includes(field.type) ? (
            <option value={SENDER_ROLE}>{SENDER_LABEL}</option>
          ) : null}
        </Select>
      </div>
      <div>
        <Label htmlFor={`${id}-type`}>Kind</Label>
        <Select
          id={`${id}-type`}
          selectSize="sm"
          value={field.type}
          onChange={(e) => set(retypedField(field, e.target.value as DocumentFieldType))}
        >
          {typesFor(field.role).map((t) => (
            <option key={t} value={t}>
              {DOCUMENT_FIELD_LABELS[t]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`${id}-label`}>What it asks for</Label>
        <Input
          id={`${id}-label`}
          inputSize="sm"
          value={field.label}
          maxLength={80}
          placeholder={FIELD_PROMPTS[field.type]}
          onChange={(e) => set({ label: e.target.value })}
          data-testid="field-label"
        />
      </div>
      {field.type === 'date_signed' ? (
        <p className="text-[12.5px] text-text-3">Fills itself in with the day they sign.</p>
      ) : (
        <label className="flex items-center justify-between gap-2 text-[13px]">
          Has to be filled in
          <Switch
            checked={field.required}
            onChange={(required) => set({ required })}
            label="Has to be filled in"
          />
        </label>
      )}
      {NO_FILL_TYPES.includes(field.type) ? null : (
        <div>
          <Label htmlFor={`${id}-fill`}>Fill in from HandsFreeOS</Label>
          <Select
            id={`${id}-fill`}
            selectSize="sm"
            value={field.fillFrom ?? ''}
            onChange={(e) => set({ fillFrom: (e.target.value || null) as FillSource | null })}
            data-testid="field-fill"
          >
            <option value="">Nothing, they type it</option>
            {FILL_GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {FILL_SOURCE_KEYS.filter((k) => FILL_SOURCES[k].group === g).map((k) => (
                  <option key={k} value={k}>
                    {g}: {FILL_SOURCES[k].label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          {field.fillFrom && field.role !== SENDER_ROLE ? (
            <p className="mt-1 text-[12px] text-text-3">They can change it before they sign.</p>
          ) : null}
        </div>
      )}
      {field.type === 'choice' ? (
        <div>
          <Label htmlFor={`${id}-options`}>Choices, one to a line</Label>
          <Textarea
            id={`${id}-options`}
            className="min-h-20 text-[13px]"
            value={field.options.join('\n')}
            onChange={(e) =>
              set({
                options: e.target.value
                  .split('\n')
                  .map((o) => o.slice(0, 80))
                  .slice(0, 20),
              })
            }
            onBlur={() => set({ options: field.options.map((o) => o.trim()).filter(Boolean) })}
          />
        </div>
      ) : null}
      {field.type === 'signature' ||
      field.type === 'initials' ||
      field.type === 'checkbox' ? null : (
        <div>
          <Label htmlFor={`${id}-size`}>Text size</Label>
          <Input
            id={`${id}-size`}
            inputSize="sm"
            type="number"
            min={6}
            max={36}
            value={field.fontSize}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 6 && n <= 36) set({ fontSize: n });
            }}
          />
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="justify-start text-danger-text"
        onClick={onRemove}
        data-testid="field-remove"
      >
        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
        Take it off
      </Button>
    </div>
  );
}

export function EditSettings({
  editor,
  edit,
  onRemove,
}: {
  editor: DefinitionEditor;
  edit: DocumentEdit;
  onRemove: () => void;
}) {
  const id = useId();
  const set = (patch: Partial<DocumentEdit>) =>
    editor.change((def) => ({
      ...def,
      edits: def.edits.map((x) => (x.id === edit.id ? { ...x, ...patch } : x)),
    }));
  return (
    <div className="flex flex-col gap-3" data-testid="edit-settings">
      <PanelTitle>{edit.original ? 'Changed words' : 'Added words'}</PanelTitle>
      {edit.original ? (
        <p className="rounded-control bg-card-2 px-2.5 py-2 text-[12.5px] text-text-2">
          <span className="text-text-3">Was: </span>
          {edit.original}
        </p>
      ) : null}
      <div>
        <Label htmlFor={`${id}-text`}>{edit.original ? 'Now says' : 'Words'}</Label>
        <Textarea
          id={`${id}-text`}
          className="min-h-20 text-[13px]"
          value={edit.text}
          maxLength={2000}
          autoFocus
          onChange={(e) => set({ text: e.target.value })}
          data-testid="edit-text"
        />
        {edit.original && !edit.text.trim() ? (
          <p className="mt-1 text-[12px] text-text-3">Left empty, the words are taken out.</p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor={`${id}-font`}>Font</Label>
          <Select
            id={`${id}-font`}
            selectSize="sm"
            value={edit.font}
            onChange={(e) => set({ font: e.target.value as DocumentEdit['font'] })}
          >
            {DOCUMENT_FONTS.map((f) => (
              <option key={f} value={f}>
                {{ sans: 'Plain', serif: 'Serif', mono: 'Typewriter' }[f]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor={`${id}-size`}>Size</Label>
          <Input
            id={`${id}-size`}
            inputSize="sm"
            type="number"
            min={4}
            max={72}
            step={0.5}
            value={edit.size}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 4 && n <= 72) set({ size: n });
            }}
          />
        </div>
      </div>
      <label className="flex items-center justify-between gap-2 text-[13px]">
        Bold
        <Switch checked={edit.bold} onChange={(bold) => set({ bold })} label="Bold" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="color"
            className="h-8 w-10 cursor-pointer rounded-control border border-border-strong bg-card"
            value={edit.color}
            onChange={(e) => set({ color: e.target.value })}
          />
          Words
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="color"
            className="h-8 w-10 cursor-pointer rounded-control border border-border-strong bg-card"
            value={edit.background}
            onChange={(e) => set({ background: e.target.value })}
          />
          Behind
        </label>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="justify-start text-danger-text"
        onClick={onRemove}
        data-testid="edit-remove"
      >
        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
        {edit.original ? 'Put the original words back' : 'Take it off'}
      </Button>
    </div>
  );
}

// ---------- how it goes out ----------

export function SettingsFields({
  settings,
  onChange,
  signers,
  message = true,
}: {
  settings: DocumentSettings;
  onChange: (patch: Partial<DocumentSettings>) => void;
  /** How many sign it: the order only matters for two or more. */
  signers: number;
  message?: boolean;
}) {
  const id = useId();
  const reminding = settings.remindAfterDays !== null;
  const days = (value: string, lo: number, hi: number) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  return (
    <div className="flex flex-col gap-3">
      {signers > 1 ? (
        <div>
          <Label>{W.whoSignsWhen}</Label>
          <Segmented
            value={settings.order}
            onChange={(order) => onChange({ order })}
            fill
            ariaLabel={W.whoSignsWhen}
            options={[
              { value: 'order', label: W.inOrder },
              { value: 'together', label: W.together },
            ]}
          />
        </div>
      ) : null}
      <label className="flex items-start justify-between gap-3 text-[13px]">
        <span>
          {W.askCode}
          <span className="block text-[12px] text-text-3">{W.askCodeBody}</span>
        </span>
        <Switch
          checked={settings.askCode}
          onChange={(askCode) => onChange({ askCode })}
          label={W.askCode}
          testId="settings-code"
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        {W.reminders}
        <Switch
          checked={reminding}
          onChange={(on) =>
            onChange(
              on
                ? {
                    remindAfterDays: DEFAULT_REMIND_AFTER_DAYS,
                    remindEveryDays: DEFAULT_REMIND_EVERY_DAYS,
                  }
                : { remindAfterDays: null, remindEveryDays: null },
            )
          }
          label={W.reminders}
        />
      </label>
      {reminding ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor={`${id}-after`} className="text-[12.5px]">
              {W.firstAfter}
            </Label>
            <Input
              id={`${id}-after`}
              inputSize="sm"
              type="number"
              min={1}
              max={30}
              value={settings.remindAfterDays ?? DEFAULT_REMIND_AFTER_DAYS}
              onChange={(e) => {
                const n = days(e.target.value, 1, 30);
                if (n) onChange({ remindAfterDays: n });
              }}
            />
          </div>
          <div>
            <Label htmlFor={`${id}-every`} className="text-[12.5px]">
              {W.thenEvery}
            </Label>
            <Input
              id={`${id}-every`}
              inputSize="sm"
              type="number"
              min={1}
              max={30}
              value={settings.remindEveryDays ?? DEFAULT_REMIND_EVERY_DAYS}
              onChange={(e) => {
                const n = days(e.target.value, 1, 30);
                if (n) onChange({ remindEveryDays: n });
              }}
            />
          </div>
        </div>
      ) : null}
      <div>
        <Label htmlFor={`${id}-expire`}>{W.expireDays}</Label>
        <Input
          id={`${id}-expire`}
          inputSize="sm"
          type="number"
          min={1}
          max={365}
          value={settings.expireDays}
          onChange={(e) => {
            const n = days(e.target.value, 1, 365);
            if (n) onChange({ expireDays: n });
          }}
        />
      </div>
      {message ? (
        <div>
          <Label htmlFor={`${id}-message`}>Note with the link</Label>
          <Textarea
            id={`${id}-message`}
            className="min-h-20 text-[13px]"
            value={settings.message}
            maxLength={2000}
            placeholder="Here’s the agreement we talked about. Let me know if you have questions."
            onChange={(e) => onChange({ message: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

export function SidePanel({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cn('p-3.5', className)}>{children}</Card>;
}

/** The role a field is for, as the editor names it. */
export const roleName = documentRoleName;
