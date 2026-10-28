'use client';
/**
 * The Send screen (docs/documents.md): a template, who it's about, who signs as each role, who gets a copy, what's
 * filled in before it goes, and the words changed for this customer only (answer 27a). `document.prefill` starts it
 * from HandsFreeOS; `document.send` checks it all again and sends each signer their link.
 */
import {
  DOCUMENT_FIELD_LABELS,
  DocumentDefinition,
  SENDER_ROLE,
  SIGNATURE_TYPES,
  valueProblem,
  type DocumentDefinition as Definition,
  type DocumentField,
  type DocumentSettings,
  type DocumentValueInput,
} from '@hfos/core';
import { Plus, Send, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PersonPicker, type PickedPerson } from '@/components/money/person-picker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { DocumentPrefillOut, DocumentSendBody } from '@/lib/api/types';
import { documentFileUrl } from '@/lib/documents/files';
import { EditorCanvas } from './editor-canvas';
import { EditSettings, Palette, SettingsFields, SidePanel, roleName } from './editor-panels';
import { removeItem, useDefinitionEditor, type Selected, type Tool } from './editor-state';

export interface SendAbout {
  readonly kind: 'person' | 'company' | 'lead' | 'custom_record';
  readonly id: string;
  readonly name: string;
}

interface Member {
  readonly id: string;
  readonly fullName: string;
}

type Who = { personId: string | null; userId: string | null; name: string; detail: string };

const aboutInput = (a: SendAbout) =>
  a.kind === 'person'
    ? { personId: a.id }
    : a.kind === 'company'
      ? { companyId: a.id }
      : a.kind === 'lead'
        ? { leadId: a.id }
        : { customRecordId: a.id };

export function SendDocument({
  workspaceId,
  templates,
  templateId: initialTemplate,
  about: initialAbout,
  fromDocumentId,
  members,
}: {
  workspaceId: string;
  templates: readonly { id: string; name: string }[];
  templateId: string | null;
  about: SendAbout | null;
  fromDocumentId: string | null;
  members: readonly Member[];
}) {
  const [templateId, setTemplateId] = useState(
    initialTemplate ?? (templates.length === 1 ? templates[0]!.id : ''),
  );
  const [about, setAbout] = useState<SendAbout | null>(initialAbout);
  const [prefill, setPrefill] = useState<DocumentPrefillOut | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    setPrefill(null);
    setFailed(null);
    if (!templateId || !about) return;
    let live = true;
    apiBrowser()
      .POST('/v1/queries/document.prefill', {
        body: {
          workspaceId,
          templateId,
          about: aboutInput(about),
          ...(fromDocumentId ? { fromDocumentId } : {}),
        },
      })
      .then((r) => live && setPrefill(unwrap(r)))
      .catch((e: unknown) => live && setFailed(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, templateId, about, fromDocumentId]);

  return (
    <div className="flex flex-col gap-4" data-testid="send-document">
      <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
        <div>
          <Label htmlFor="send-template">Template</Label>
          {templates.length ? (
            <Select
              id="send-template"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              data-testid="send-template"
            >
              <option value="">Pick one</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-[13px] text-text-2">
              No template is ready to send yet. An owner or admin makes them under Documents →
              Templates.
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="send-about">Who it’s for</Label>
          {about ? (
            <div className="flex h-10 items-center gap-2 rounded-control border border-border bg-card-2 px-3">
              <span
                className="min-w-0 flex-1 truncate text-[14px] font-medium"
                data-testid="send-about"
              >
                {about.name}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAbout(null)}
                disabled={!!fromDocumentId}
              >
                Change
              </Button>
            </div>
          ) : (
            <PersonPicker
              workspaceId={workspaceId}
              id="send-about"
              onPick={(p) => setAbout({ kind: 'person', id: p.id, name: p.fullName })}
            />
          )}
        </div>
      </Card>
      {failed ? (
        <p role="alert" className="text-[13px] text-danger-text">
          {failed}
        </p>
      ) : null}
      {templateId && about && !prefill && !failed ? (
        <p className="text-[13px] text-text-3" aria-live="polite">
          Filling it in…
        </p>
      ) : null}
      {prefill && about ? (
        <SendForm
          key={`${prefill.templateId}:${about.id}`}
          workspaceId={workspaceId}
          prefill={prefill}
          about={about}
          fromDocumentId={fromDocumentId}
          members={members}
        />
      ) : null}
    </div>
  );
}

function SendForm({
  workspaceId,
  prefill,
  about,
  fromDocumentId,
  members,
}: {
  workspaceId: string;
  prefill: DocumentPrefillOut;
  about: SendAbout;
  fromDocumentId: string | null;
  members: readonly Member[];
}) {
  const router = useRouter();
  const base = useMemo(() => DocumentDefinition.parse(prefill.definition), [prefill.definition]);
  const editor = useDefinitionEditor(base);
  const d = editor.definition;
  const [name, setName] = useState(prefill.name);
  const [message, setMessage] = useState(prefill.message);
  const [settings, setSettings] = useState<DocumentSettings>(base.settings);
  const [values, setValues] = useState<Record<string, DocumentValueInput>>(
    prefill.presets as Record<string, DocumentValueInput>,
  );
  const [signers, setSigners] = useState<Record<string, Who | null>>(() =>
    Object.fromEntries(
      prefill.signers.map((s) => [
        s.roleKey,
        s.personId || s.userId
          ? {
              personId: s.personId,
              userId: s.userId,
              name: s.name,
              detail: s.email ?? s.phone ?? '',
            }
          : null,
      ]),
    ),
  );
  // Signing in person, with the team now (answer 13a): no link at their turn; Sign now on the document hands it over.
  const [inPerson, setInPerson] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(prefill.signers.map((s) => [s.roleKey, s.inPerson])),
  );
  const [copies, setCopies] = useState<Who[]>(
    prefill.copies.map((c) => ({
      personId: c.personId,
      userId: c.userId,
      name: c.name,
      detail: '',
    })),
  );
  const [addingCopy, setAddingCopy] = useState<'person' | 'team' | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prefill.source) return;
    let live = true;
    documentFileUrl(prefill.source)
      .then((u) => live && setSourceUrl(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [prefill.source]);

  /** What the team fills in or checks before it goes: their own part, and what HandsFreeOS filled in for signers. */
  const fillable = useMemo(
    () =>
      d.fields
        .filter(
          (f) =>
            f.type !== 'date_signed' &&
            !SIGNATURE_TYPES.includes(f.type) &&
            (f.role === SENDER_ROLE || f.fillFrom !== null || f.id in prefill.presets),
        )
        .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x),
    // Which fields are listed is fixed by the template; what's in them changes as they're typed.
    [d.fields, prefill.presets],
  );

  function setValue(id: string, v: DocumentValueInput | null) {
    setValues((was) => {
      const next = { ...was };
      if (v) next[id] = v;
      else delete next[id];
      return next;
    });
  }

  async function send() {
    if (busy) return;
    setError(null);
    const missing = d.roles.find((r) => !signers[r.key]);
    if (missing) {
      setError(`Pick who signs as ${missing.label}.`);
      return;
    }
    for (const f of fillable.filter((x) => x.role === SENDER_ROLE)) {
      const p = valueProblem(f, values[f.id] as never);
      if (p) {
        setError(p);
        return;
      }
    }
    setBusy(true);
    try {
      const body: DocumentSendBody = {
        workspaceId,
        templateId: prefill.templateId,
        about: aboutInput(about),
        name: name.trim() || prefill.name,
        signers: d.roles.map((r) => {
          const who = signers[r.key]!;
          return who.userId
            ? { roleKey: r.key, userId: who.userId }
            : { roleKey: r.key, personId: who.personId!, inPerson: !!inPerson[r.key] };
        }),
        copies: copies.map((c) => (c.userId ? { userId: c.userId } : { personId: c.personId! })),
        values: values as DocumentSendBody['values'],
        edits: d.edits as DocumentSendBody['edits'],
        message: message.trim(),
        settings: {
          order: settings.order,
          askCode: settings.askCode,
          remindAfterDays: settings.remindAfterDays,
          remindEveryDays: settings.remindEveryDays,
          expireDays: settings.expireDays,
        },
        ...(fromDocumentId ? { replacesDocumentId: fromDocumentId } : {}),
      };
      const out = unwrap(await apiBrowser().POST('/v1/commands/document.send', { body }));
      toast.success(
        out.signers.filter((s) => s.kind === 'signer').length > 1
          ? 'Sent. Each signer gets their own link.'
          : 'Sent. Their link is on its way.',
      );
      router.push(`/app/w/${workspaceId}/documents/${out.documentId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const edit = selected?.kind === 'edit' ? d.edits.find((x) => x.id === selected.id) : undefined;
  const changedWords = d.edits.length - base.edits.length;

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        {prefill.issues.length ? (
          <Card className="flex flex-col gap-1.5 p-4">
            {prefill.issues.map((i, n) => (
              <p
                key={n}
                className="rounded-control bg-warning-soft px-2.5 py-2 text-[13px] text-warning-text"
              >
                {i.message}
              </p>
            ))}
          </Card>
        ) : null}

        <Card className="flex flex-col gap-3 p-4">
          <Field
            label="What it’s called"
            htmlFor="send-name"
            hint="On their email and text, and on their Files."
          >
            <Input
              id="send-name"
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </Card>

        <Card className="flex flex-col gap-3 p-4" data-testid="send-signers">
          <h2 className="text-[15px] font-semibold">Who signs</h2>
          {d.roles.map((r, i) => {
            const who = signers[r.key];
            return (
              <div key={r.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`signer-${r.key}`} className="mb-0">
                  {settings.order === 'order' && d.roles.length > 1 ? `${i + 1}. ` : ''}
                  {r.label}
                </Label>
                {who ? (
                  <div className="flex items-center gap-2 rounded-control border border-border bg-card-2 px-3 py-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px] font-medium">{who.name}</span>
                      {who.detail ? (
                        <span className="truncate text-[12px] text-text-3">{who.detail}</span>
                      ) : null}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSigners((s) => ({ ...s, [r.key]: null }))}
                    >
                      Change
                    </Button>
                  </div>
                ) : r.kind === 'team' ? (
                  <Select
                    id={`signer-${r.key}`}
                    value=""
                    onChange={(e) => {
                      const m = members.find((x) => x.id === e.target.value);
                      if (m)
                        setSigners((s) => ({
                          ...s,
                          [r.key]: { personId: null, userId: m.id, name: m.fullName, detail: '' },
                        }));
                    }}
                  >
                    <option value="">Pick someone on your team</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.fullName}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <PersonPicker
                    workspaceId={workspaceId}
                    id={`signer-${r.key}`}
                    onPick={(p: PickedPerson) =>
                      setSigners((s) => ({
                        ...s,
                        [r.key]: {
                          personId: p.id,
                          userId: null,
                          name: p.fullName,
                          detail: p.email ?? p.phone ?? '',
                        },
                      }))
                    }
                  />
                )}
                {who && r.kind === 'customer' ? (
                  <label className="flex items-start gap-2.5 text-[13px] text-text-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-accent"
                      checked={!!inPerson[r.key]}
                      onChange={(e) => setInPerson((m) => ({ ...m, [r.key]: e.target.checked }))}
                      data-testid={`signer-in-person-${r.key}`}
                    />
                    <span>
                      <span className="font-medium text-text">With you now.</span> No link goes to
                      them: they sign on your phone or computer with Sign now on the document.
                    </span>
                  </label>
                ) : null}
              </div>
            );
          })}
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <span className="text-[13px] font-medium">Gets a signed copy</span>
            {copies.map((c, i) => (
              <div
                key={`${c.personId ?? c.userId}`}
                className="flex items-center gap-2 text-[13.5px]"
              >
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Take ${c.name} off the copies`}
                  onClick={() => setCopies((was) => was.filter((_, n) => n !== i))}
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </div>
            ))}
            {addingCopy === 'person' ? (
              <PersonPicker
                workspaceId={workspaceId}
                id="copy-person"
                autoFocus
                onPick={(p) => {
                  setCopies((was) => [
                    ...was,
                    { personId: p.id, userId: null, name: p.fullName, detail: p.email ?? '' },
                  ]);
                  setAddingCopy(null);
                }}
              />
            ) : addingCopy === 'team' ? (
              <Select
                value=""
                autoFocus
                onChange={(e) => {
                  const m = members.find((x) => x.id === e.target.value);
                  if (m)
                    setCopies((was) => [
                      ...was,
                      { personId: null, userId: m.id, name: m.fullName, detail: '' },
                    ]);
                  setAddingCopy(null);
                }}
              >
                <option value="">Pick someone on your team</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.fullName}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="flex flex-wrap gap-1">
                <Button variant="ghost" size="sm" onClick={() => setAddingCopy('person')}>
                  <Plus className="h-4 w-4" strokeWidth={1.75} />A customer
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAddingCopy('team')}>
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  Someone on your team
                </Button>
              </div>
            )}
          </div>
        </Card>

        {fillable.length ? (
          <Card className="flex flex-col gap-3 p-4" data-testid="send-values">
            <div>
              <h2 className="text-[15px] font-semibold">Filled in before it goes</h2>
              <p className="text-[12.5px] text-text-3">
                Your part, and what HandsFreeOS filled in for them. They can change what’s theirs
                before they sign.
              </p>
            </div>
            {fillable.map((f) => (
              <ValueInput
                key={f.id}
                field={f}
                who={roleName(d, f.role)}
                value={values[f.id] ?? null}
                onChange={(v) => setValue(f.id, v)}
              />
            ))}
          </Card>
        ) : null}

        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-[15px] font-semibold">The note and the settings</h2>
          <Field label="Note with the link" htmlFor="send-message">
            <Textarea
              id="send-message"
              className="min-h-20"
              value={message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
              data-testid="send-message"
            />
          </Field>
          <SettingsFields
            settings={settings}
            signers={d.roles.length}
            message={false}
            onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
          />
        </Card>

        {error ? (
          <p role="alert" className="text-[13px] text-danger-text" data-testid="send-error">
            {error}
          </p>
        ) : null}
        <Button
          size="lg"
          loading={busy}
          disabled={prefill.issues.length > 0}
          onClick={() => void send()}
          data-testid="send-submit"
        >
          <Send className="h-4 w-4" strokeWidth={1.75} />
          Send it
        </Button>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <SidePanel className="flex flex-col gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Change the words for {about.name} only</h2>
            <p className="text-[12.5px] text-text-3">
              The template stays as it is.{' '}
              {changedWords > 0
                ? `${changedWords} ${changedWords === 1 ? 'change' : 'changes'} so far.`
                : ''}
            </p>
          </div>
          <Palette role={SENDER_ROLE} roleLabel="" tool={tool} onTool={setTool} fields={false} />
          {edit ? (
            <EditSettings
              editor={editor}
              edit={edit}
              onRemove={() => {
                if (selected) editor.change((def: Definition) => removeItem(def, selected));
                setSelected(null);
              }}
            />
          ) : null}
        </SidePanel>
        <EditorCanvas
          source={sourceUrl}
          editor={editor}
          selected={selected}
          onSelect={setSelected}
          tool={tool}
          onToolDone={() => setTool(null)}
          role={SENDER_ROLE}
          fieldsEditable={false}
          values={values}
          testId="send-pages"
        />
      </div>
    </div>
  );
}

/** One field filled in on the Send screen, the way its kind is typed. */
function ValueInput({
  field,
  who,
  value,
  onChange,
}: {
  field: DocumentField;
  who: string;
  value: DocumentValueInput | null;
  onChange: (v: DocumentValueInput | null) => void;
}) {
  const id = `value-${field.id}`;
  const label = `${field.label || DOCUMENT_FIELD_LABELS[field.type]}${field.role === SENDER_ROLE ? '' : ` (${who})`}`;
  const text = value?.kind === 'text' ? value.text : value?.kind === 'date' ? value.date : '';
  const problem = field.role === SENDER_ROLE && value ? valueProblem(field, value as never) : null;
  if (field.type === 'checkbox')
    return (
      <label className="flex items-center gap-2.5 text-[13.5px]">
        <input
          type="checkbox"
          className="h-[18px] w-[18px] accent-accent"
          checked={value?.kind === 'check' && value.checked}
          onChange={(e) => onChange(e.target.checked ? { kind: 'check', checked: true } : null)}
        />
        {label}
      </label>
    );
  const set = (t: string) =>
    onChange(
      t.trim()
        ? field.type === 'date'
          ? { kind: 'date', date: t }
          : { kind: 'text', text: t }
        : null,
    );
  return (
    <Field
      label={`${label}${field.required && field.role === SENDER_ROLE ? ' *' : ''}`}
      htmlFor={id}
      error={problem}
    >
      {field.type === 'long_text' ? (
        <Textarea
          id={id}
          className="min-h-16"
          value={text}
          maxLength={5000}
          onChange={(e) => set(e.target.value)}
        />
      ) : field.type === 'choice' ? (
        <Select id={id} value={text} onChange={(e) => set(e.target.value)}>
          <option value="">Pick one</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text'}
          inputMode={
            field.type === 'number' ? 'decimal' : field.type === 'phone' ? 'tel' : undefined
          }
          value={text}
          maxLength={500}
          onChange={(e) => set(e.target.value)}
          data-testid="send-value"
        />
      )}
    </Field>
  );
}
