'use client';
/**
 * A document template (docs/documents.md): its PDF, who signs it, the fields placed for each of them, the PDF's words
 * typed over (answer 26c), and how it goes out. Saves itself a moment after each change, sending the whole
 * definition with the revision it started from, so two people never quietly write over each other.
 */
import { DocumentDefinition, SENDER_ROLE, type DocumentDefinition as Definition } from '@hfos/core';
import {
  ArrowLeft,
  Archive,
  Check,
  Copy,
  FileUp,
  Loader2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Send,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { DocumentIssueRow, DocumentTemplateGetOut } from '@/lib/api/types';
import { documentFileUrl, uploadTemplatePdf } from '@/lib/documents/files';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { EditorCanvas } from './editor-canvas';
import {
  EditSettings,
  FieldSettings,
  Palette,
  PanelTitle,
  RolesPanel,
  SettingsFields,
  SidePanel,
  roleName,
} from './editor-panels';
import {
  moved,
  removeItem,
  updateEdit,
  updateField,
  useDefinitionEditor,
  type Selected,
  type Tool,
} from './editor-state';

const HOLD_MS = 900;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function TemplateEditor({
  workspaceId,
  initial,
  canManage,
}: {
  workspaceId: string;
  initial: DocumentTemplateGetOut;
  canManage: boolean;
}) {
  const router = useRouter();
  const templateId = initial.id;
  const archived = !!initial.archivedAt;
  const editable = canManage && !archived;
  const editor = useDefinitionEditor(DocumentDefinition.parse(initial.definition));
  const d = editor.definition;
  const [revision, setRevision] = useState(initial.revision);
  const [issues, setIssues] = useState<readonly DocumentIssueRow[]>(initial.issues);
  const [source, setSource] = useState(initial.source);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<Selected>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [role, setRole] = useState<string>(d.roles[0]?.key ?? SENDER_ROLE);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const inFlight = useRef(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!source) return setSourceUrl(null);
    let live = true;
    documentFileUrl(source)
      .then((u) => live && setSourceUrl(u))
      .catch((e: unknown) => live && toast.error(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [source]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!editable || conflict) return false;
    if (inFlight.current) return false;
    const sent = editor.definition;
    const parsed = DocumentDefinition.safeParse(sent);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'Some of the template needs attention.');
      return false;
    }
    setProblem(null);
    inFlight.current = true;
    setSaving(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/document_template.save', {
          body: {
            workspaceId,
            templateId,
            baseRevision: revisionRef.current,
            definition: sent as never,
          },
        }),
      );
      setRevision(out.revision);
      revisionRef.current = out.revision;
      setIssues(out.issues);
      editor.markSaved(sent);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'revision_conflict') setConflict(true);
      else toast.error(errorMessage(e));
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [editable, conflict, editor, workspaceId, templateId]);

  // A moment after each change, and again if one came in while it saved.
  useEffect(() => {
    if (!editor.dirty || saving) return;
    const timer = setTimeout(() => void save(), HOLD_MS);
    return () => clearTimeout(timer);
  }, [editor.version, editor.dirty, saving, save]);

  // Leaving with a change not yet saved: the browser asks first.
  useEffect(() => {
    if (!editor.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editor.dirty]);

  const remove = useCallback(() => {
    if (!selected) return;
    editor.change((def) => removeItem(def, selected));
    setSelected(null);
  }, [editor, selected]);

  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'z' &&
        !e.shiftKey &&
        !isTyping(e.target)
      ) {
        e.preventDefault();
        editor.undo();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === 'Escape') {
        if (tool) setTool(null);
        else setSelected(null);
        return;
      }
      if (!selected) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove();
        return;
      }
      const step = e.shiftKey ? 0.01 : 0.002;
      const by = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }[e.key];
      if (!by) return;
      e.preventDefault();
      editor.change((def) =>
        selected.kind === 'field'
          ? updateField(def, selected.id, (f) => moved(f, 'move', by[0]!, by[1]!))
          : updateEdit(def, selected.id, (x) => moved(x, 'move', by[0]!, by[1]!)),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, editor, selected, tool, remove]);

  async function reloadFromServer() {
    const got = unwrap(
      await apiBrowser().POST('/v1/queries/document_template.get', {
        body: { workspaceId, templateId },
      }),
    );
    editor.reset(DocumentDefinition.parse(got.definition));
    setRevision(got.revision);
    revisionRef.current = got.revision;
    setIssues(got.issues);
    setSource(got.source);
    setConflict(false);
    setSelected(null);
  }

  async function addPdf(picked: File | undefined) {
    if (!picked || uploading) return;
    if (
      source &&
      !window.confirm(
        'Swap the PDF for this one? Fields and word changes on pages it doesn’t have come off.',
      )
    )
      return;
    setUploading(true);
    try {
      if (editor.dirty) await save();
      const out = await uploadTemplatePdf(workspaceId, templateId, picked, revisionRef.current);
      await reloadFromServer();
      const off = out.removedFields + out.removedEdits;
      toast.success(
        off
          ? `PDF added. ${off === 1 ? 'One thing' : `${off} things`} on pages it doesn’t have came off.`
          : source
            ? 'PDF swapped.'
            : 'PDF added. Now put fields on it for each signer.',
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  }

  async function run(path: 'archive' | 'restore' | 'duplicate') {
    try {
      if (path === 'duplicate') {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/document_template.duplicate', {
            body: { workspaceId, templateId },
          }),
        );
        toast.success('Copied. You’re in the copy now.');
        router.push(`/app/w/${workspaceId}/documents/templates/${out.templateId}`);
        return;
      }
      if (path === 'archive') {
        unwrap(
          await apiBrowser().POST('/v1/commands/document_template.archive', {
            body: { workspaceId, templateId },
          }),
        );
        toast.success('Archived. Documents already sent aren’t touched.');
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/document_template.restore', {
            body: { workspaceId, templateId },
          }),
        );
        toast.success('Restored.');
      }
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const field = selected?.kind === 'field' ? d.fields.find((f) => f.id === selected.id) : undefined;
  const edit = selected?.kind === 'edit' ? d.edits.find((x) => x.id === selected.id) : undefined;
  const ready = !!source && issues.length === 0 && !problem;
  // Below 1536px the page gets the room: the tools, what's picked (in place of who signs) and the settings share
  // the left.
  const wide = useMatches('(min-width: 1536px)');
  const roles = (
    <SidePanel>
      <RolesPanel
        editor={editor}
        role={role}
        onRole={(r) => {
          setRole(r);
          if (
            tool?.kind === 'field' &&
            r === SENDER_ROLE &&
            ['signature', 'initials', 'date_signed'].includes(tool.type)
          )
            setTool(null);
        }}
        editable={editable}
      />
    </SidePanel>
  );
  const palette = editable ? (
    <SidePanel>
      <Palette role={role} roleLabel={roleName(d, role)} tool={tool} onTool={setTool} />
    </SidePanel>
  ) : null;
  const item =
    field && editable ? (
      <SidePanel>
        <FieldSettings editor={editor} field={field} onRemove={remove} />
      </SidePanel>
    ) : edit && editable ? (
      <SidePanel>
        <EditSettings editor={editor} edit={edit} onRemove={remove} />
      </SidePanel>
    ) : null;
  const about = (
    <>
      <SidePanel>
        <PanelTitle>Before it can go out</PanelTitle>
        {issues.length ? (
          <ul className="flex flex-col gap-1.5" data-testid="template-issues">
            {issues.map((i, n) => (
              <li
                key={n}
                className="rounded-control bg-warning-soft px-2.5 py-2 text-[12.5px] text-warning-text"
              >
                {i.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-2">Nothing. It’s ready to send.</p>
        )}
      </SidePanel>
      <SidePanel>
        <PanelTitle>When it’s sent</PanelTitle>
        {editable ? (
          <SettingsFields
            settings={d.settings}
            signers={d.roles.length}
            onChange={(patch) =>
              editor.change((def: Definition) => ({
                ...def,
                settings: { ...def.settings, ...patch },
              }))
            }
          />
        ) : (
          <p className="text-[13px] text-text-2">Owners and admins change templates.</p>
        )}
      </SidePanel>
    </>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="template-editor">
      <div className="flex flex-col gap-2">
        <Link
          href={`/app/w/${workspaceId}/documents?tab=templates`}
          className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-text-3 hover:text-text-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Templates
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <TemplateName
            workspaceId={workspaceId}
            templateId={templateId}
            name={initial.name}
            editable={editable}
          />
          {archived ? (
            <Badge>Archived</Badge>
          ) : ready ? (
            <Badge variant="ok">Ready to send</Badge>
          ) : (
            <Badge variant="pending">Not ready yet</Badge>
          )}
          {initial.documentsOut ? (
            <span className="text-[12.5px] text-text-3">
              {initial.documentsOut} out for signing
            </span>
          ) : null}
          <span className="text-[12.5px] text-text-3" data-testid="save-state">
            {!editable ? null : saving ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                Saving
              </span>
            ) : problem ? (
              <span className="text-danger-text">{problem}</span>
            ) : editor.dirty ? (
              'Unsaved changes'
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5" strokeWidth={1.75} />
                Saved
              </span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {editable ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={editor.undo}
                disabled={!editor.canUndo}
                aria-label="Undo"
              >
                <Undo2 className="h-4 w-4" strokeWidth={1.75} />
                Undo
              </Button>
            ) : null}
            {canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="More"
                    data-testid="template-more"
                  >
                    <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {editable && source ? (
                    <DropdownMenuItem onSelect={() => file.current?.click()}>
                      <FileUp className="h-4 w-4" strokeWidth={1.75} />
                      Swap the PDF
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => void run('duplicate')}>
                    <Copy className="h-4 w-4" strokeWidth={1.75} />
                    Make a copy
                  </DropdownMenuItem>
                  {archived ? (
                    <DropdownMenuItem onSelect={() => void run('restore')}>
                      <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                      Restore
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onSelect={() => void run('archive')}
                      data-testid="template-archive"
                    >
                      <Archive className="h-4 w-4" strokeWidth={1.75} />
                      Archive
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {ready && !editor.dirty && !archived ? (
              <ButtonLink
                variant="primary"
                size="sm"
                href={`/app/w/${workspaceId}/documents/send?template=${templateId}`}
                data-testid="template-send"
              >
                <Send className="h-4 w-4" strokeWidth={1.75} />
                Send it
              </ButtonLink>
            ) : (
              <Button size="sm" disabled title={issues[0]?.message ?? problem ?? 'Saving first'}>
                <Send className="h-4 w-4" strokeWidth={1.75} />
                Send it
              </Button>
            )}
          </div>
        </div>
        {conflict ? (
          <div className="flex flex-wrap items-center gap-3 rounded-card bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text">
            Someone saved this template in the meantime, so your last change wasn’t saved.
            <Button size="sm" variant="secondary" onClick={() => void reloadFromServer()}>
              Load their changes
            </Button>
          </div>
        ) : null}
        <input
          ref={file}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => void addPdf(e.target.files?.[0])}
          data-testid="template-pdf-input"
        />
      </div>

      {!source ? (
        <PdfDrop
          busy={uploading}
          editable={editable}
          onPick={() => file.current?.click()}
          onFile={(f) => void addPdf(f)}
        />
      ) : (
        <div
          className={cn(
            'grid items-start gap-4',
            wide
              ? 'grid-cols-[232px_minmax(0,1fr)_280px]'
              : 'grid-cols-1 lg:grid-cols-[264px_minmax(0,1fr)]',
          )}
        >
          <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
            {wide ? (
              <>
                {roles}
                {palette}
              </>
            ) : (
              <>
                {item ?? roles}
                {palette}
                {item ? null : about}
              </>
            )}
          </aside>

          <div className="min-w-0">
            <EditorCanvas
              source={sourceUrl}
              editor={editor}
              selected={selected}
              onSelect={setSelected}
              tool={tool}
              onToolDone={() => setTool(null)}
              role={role}
              editable={editable}
              testId="template-pages"
            />
          </div>

          {wide ? (
            <aside className="flex flex-col gap-4 lg:sticky lg:top-4">{item ?? about}</aside>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PdfDrop({
  busy,
  editable,
  onPick,
  onFile,
}: {
  busy: boolean;
  editable: boolean;
  onPick: () => void;
  onFile: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <Card
      className={cn(
        'flex flex-col items-center gap-3 border-dashed px-6 py-14 text-center',
        over && 'border-accent bg-accent-soft/40',
      )}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f && editable) onFile(f);
      }}
      data-testid="template-pdf-drop"
    >
      <FileUp className="h-7 w-7 text-text-3" strokeWidth={1.5} />
      <div className="text-[15px] font-semibold">Add the PDF this template is made from</div>
      <p className="max-w-[420px] text-[13px] text-text-2">
        Your contract, agreement or form, as a PDF up to 25 MB. Then you put fields on it for each
        person who signs, and you can change any of its words.
      </p>
      {editable ? (
        <Button onClick={onPick} loading={busy} data-testid="template-pdf-pick">
          <FileUp className="h-4 w-4" strokeWidth={1.75} />
          Choose a PDF
        </Button>
      ) : null}
    </Card>
  );
}

function TemplateName({
  workspaceId,
  templateId,
  name,
  editable,
}: {
  workspaceId: string;
  templateId: string;
  name: string;
  editable: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);

  async function rename() {
    const next = value.trim();
    if (!next || next === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/document_template.rename', {
          body: { workspaceId, templateId, name: next },
        }),
      );
      setEditing(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (editing)
    return (
      <span className="flex items-center gap-2">
        <Input
          value={value}
          autoFocus
          className="max-w-sm"
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void rename();
            if (e.key === 'Escape') {
              setEditing(false);
              setValue(name);
            }
          }}
          data-testid="template-name-input"
        />
        <Button size="sm" onClick={() => void rename()} loading={busy} aria-label="Save the name">
          <Check className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <h1
        className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em]"
        data-testid="template-name"
      >
        {name}
      </h1>
      {editable ? (
        <Button variant="ghost" size="icon" aria-label="Rename" onClick={() => setEditing(true)}>
          <Pencil className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      ) : null}
    </span>
  );
}
