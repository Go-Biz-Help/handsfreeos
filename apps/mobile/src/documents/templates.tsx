import {
  addPlacedFields,
  DOCUMENT_EDITOR_WORDS as E,
  DOCUMENT_SCREEN_WORDS as W,
  DocumentDefinition,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import {
  Archive,
  Check,
  Copy,
  Ellipsis,
  FileText,
  FileUp,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
} from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { useLiveAnswer } from '@/lib/live-answer';

import {
  documentCalls,
  pdfProblem,
  pickPdf,
  useManagesTemplates,
  useSendsDocuments,
  type DocumentIssueRow,
  type DocumentTemplateGetOut,
  type DocumentTemplateRow,
  type PickedPdf,
} from './calls';
import { PagesEditor } from './editor';
import { useDefinitionEditor } from './editor-state';
import { SettingsFields } from './send';

/**
 * Templates on the phone (docs/documents.md, part 3, answer 24b), as the web has them: the list in use or archived, a
 * new one from a PDF picked from the phone's files, and one template's editor. The editor saves itself a moment after
 * each change, with the revision it started from, so two people never quietly write over each other; leaving the
 * screen saves what's left. Like the rest of Documents, it all needs signal.
 */

const templateHref = (workspaceId: string, templateId: string) =>
  businessHref(workspaceId, `documents/templates/${templateId}`) as Href;

/** How long after a change the editor saves it. */
const HOLD_MS = 900;

function templateBadge(t: { archivedAt: string | null; ready: boolean }) {
  return t.archivedAt
    ? { tone: 'gray' as const, label: W.archived }
    : t.ready
      ? { tone: 'ok' as const, label: W.ready }
      : { tone: 'pending' as const, label: W.notReady };
}

// ---------- the list ----------

export function TemplateList({ workspaceId }: { workspaceId: string }) {
  const canManage = useManagesTemplates();
  const calls = React.useMemo(() => documentCalls(workspaceId), [workspaceId]);
  const [archived, setArchived] = React.useState(false);
  const [making, setMaking] = React.useState(false);
  const load = React.useCallback(() => calls.templateList(archived), [calls, archived]);
  const answer = useLiveAnswer(load, `${workspaceId}:${archived}`, E.phone.templatesNeedSignal);
  const rows = answer.data ?? [];

  return (
    <>
      {canManage ? (
        <Button icon={Plus} onPress={() => setMaking(true)} testID="template-new">
          {E.newTemplate}
        </Button>
      ) : null}
      <Segmented
        value={archived ? 'archived' : 'live'}
        onChange={(v) => setArchived(v === 'archived')}
        label={W.templates}
        options={[
          { value: 'live', label: W.inUse, testID: 'templates-live' },
          { value: 'archived', label: W.archived, testID: 'templates-archived' },
        ]}
      />
      {answer.data ? (
        rows.length ? (
          <List testID="templates">
            {rows.map((t) => (
              <TemplateRow key={t.id} workspaceId={workspaceId} row={t} />
            ))}
          </List>
        ) : (
          <View className="gap-1 px-1 py-6" testID="templates-empty">
            <Text className="text-[15px] font-medium">
              {archived ? W.nothingArchived : W.noTemplates}
            </Text>
            <Text className="text-[13px] text-text-2">
              {archived ? W.nothingArchivedBody : canManage ? E.phone.makeOne : W.askForTemplates}
            </Text>
          </View>
        )
      ) : answer.loading ? null : (
        <Text className="py-10 text-center text-[13px] text-text-3" testID="templates-missing">
          {answer.error}
        </Text>
      )}
      <NewTemplateSheet workspaceId={workspaceId} open={making} onClose={() => setMaking(false)} />
    </>
  );
}

function TemplateRow({ workspaceId, row }: { workspaceId: string; row: DocumentTemplateRow }) {
  const badge = templateBadge(row);
  return (
    <ListRow
      icon={FileText}
      label={row.name}
      detail={[
        row.hasPdf ? W.pages(row.pageCount) : W.noPdf,
        row.roles.map((r) => r.label).join(', '),
        W.fields(row.fieldCount),
        row.documentsOut ? W.out(row.documentsOut) : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      end={<Badge variant={badge.tone}>{badge.label}</Badge>}
      endWords={badge.label}
      onPress={() => router.push(templateHref(workspaceId, row.id))}
      testID="template-row"
    />
  );
}

/** A new template: its name, and its PDF if they have it now, then straight into the editor to place the fields. */
function NewTemplateSheet({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const calls = React.useMemo(() => documentCalls(workspaceId), [workspaceId]);
  const [name, setName] = React.useState('');
  const [file, setFile] = React.useState<PickedPdf | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function choose() {
    try {
      const picked = await pickPdf();
      if (!picked) return;
      const wrong = pdfProblem(picked);
      if (wrong) {
        setError(wrong);
        return;
      }
      setError(null);
      setFile(picked);
      if (!name.trim()) setName(picked.name.replace(/\.pdf$/i, '').slice(0, 120));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function create() {
    if (busy) return;
    if (!name.trim()) {
      setError(E.nameIt);
      return;
    }
    setBusy(true);
    setError(null);
    let templateId: string | null = null;
    try {
      const made = await calls.templateCreate(name.trim());
      templateId = made.templateId;
      if (file) await calls.uploadTemplatePdf(made.templateId, file, made.revision);
      close();
      router.push(templateHref(workspaceId, made.templateId));
    } catch (e) {
      if (templateId) {
        // The template is made; its PDF can be added again from the editor.
        toast.error(errorMessage(e));
        close();
        router.push(templateHref(workspaceId, templateId));
        return;
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    onClose();
    setName('');
    setFile(null);
    setError(null);
  }

  return (
    <Sheet
      open={open}
      onClose={() => !busy && close()}
      title={E.newTemplate}
      description={E.newTemplateBody}
      testID="template-new-sheet"
    >
      <View className="gap-3">
        <View className="gap-1.5">
          <Button
            variant="secondary"
            icon={FileUp}
            onPress={() => void choose()}
            disabled={busy}
            testID="template-new-file"
          >
            {file ? file.name : E.choosePdf}
          </Button>
          <Text className="text-[12.5px] text-text-3">{E.pdfLater}</Text>
        </View>
        <View className="gap-1.5">
          <Label>{E.phone.name}</Label>
          <Input
            value={name}
            maxLength={120}
            placeholder={E.namePlaceholder}
            onChangeText={setName}
            invalid={!!error}
            testID="template-new-name"
          />
          <FieldError>{error}</FieldError>
        </View>
        <Button loading={busy} onPress={() => void create()} testID="template-new-create">
          {E.makeIt}
        </Button>
        <Button variant="ghost" disabled={busy} onPress={close}>
          {E.phone.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

// ---------- one template ----------

export function TemplateScreen({ templateId }: { templateId: string }) {
  const { business } = useBusiness();
  const calls = React.useMemo(() => documentCalls(business.id), [business.id]);
  const load = React.useCallback(() => calls.templateGet(templateId), [calls, templateId]);
  const answer = useLiveAnswer(load, `${business.id}:${templateId}`, E.phone.templatesNeedSignal);
  const back = businessHref(business.id, 'documents?tab=templates') as Href;
  // The first answer starts the editor; after that the editor keeps its own (a reload would lose what's unsaved).
  const [first, setFirst] = React.useState<DocumentTemplateGetOut | null>(null);
  React.useEffect(() => {
    if (answer.data && answer.data.id === templateId) setFirst((was) => was ?? answer.data);
  }, [answer.data, templateId]);

  if (!first)
    return (
      <Screen title={E.phone.templateTitle} leading="back" back={back} testID="template">
        {answer.loading ? null : (
          <Text className="py-10 text-center text-[13px] text-text-3" testID="template-missing">
            {answer.error}
          </Text>
        )}
      </Screen>
    );
  return <TemplateBody key={first.id} workspaceId={business.id} initial={first} back={back} />;
}

type Asking = 'more' | 'rename' | 'settings' | { swap: PickedPdf } | null;

export function TemplateBody({
  workspaceId,
  initial,
  back,
}: {
  workspaceId: string;
  initial: DocumentTemplateGetOut;
  back?: Href;
}) {
  const calls = React.useMemo(() => documentCalls(workspaceId), [workspaceId]);
  const canManage = useManagesTemplates();
  const canSend = useSendsDocuments();
  const templateId = initial.id;
  const [archived, setArchived] = React.useState(!!initial.archivedAt);
  const editable = canManage && !archived;
  const editor = useDefinitionEditor(DocumentDefinition.parse(initial.definition));
  const d = editor.definition;
  const [name, setName] = React.useState(initial.name);
  const [revision, setRevision] = React.useState(initial.revision);
  const [issues, setIssues] = React.useState<readonly DocumentIssueRow[]>(initial.issues);
  const [source, setSource] = React.useState(initial.source);
  const [saving, setSaving] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [placing, setPlacing] = React.useState(false);
  const [asking, setAsking] = React.useState<Asking>(null);
  const [renaming, setRenaming] = React.useState(initial.name);
  const [busy, setBusy] = React.useState<string | null>(null);
  const pagesSource = React.useMemo(() => ({ templateId }), [templateId]);
  const revisionRef = React.useRef(revision);
  revisionRef.current = revision;
  const inFlight = React.useRef(false);
  // What to do once a sheet has gone: the file picker can't open over one on iOS.
  const afterSheet = React.useRef<(() => void) | null>(null);

  const save = React.useCallback(async (): Promise<boolean> => {
    if (!editable || conflict || inFlight.current) return false;
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
      const out = await calls.templateSave(templateId, revisionRef.current, sent);
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
  }, [editable, conflict, editor, calls, templateId]);

  // A moment after each change, and again if one came in while it saved.
  React.useEffect(() => {
    if (!editor.dirty || saving) return;
    const timer = setTimeout(() => void save(), HOLD_MS);
    return () => clearTimeout(timer);
  }, [editor.version, editor.dirty, saving, save]);

  // Leaving with a change not yet saved saves it on the way out.
  const leaving = React.useRef({ dirty: editor.dirty, save });
  leaving.current = { dirty: editor.dirty, save };
  React.useEffect(
    () => () => {
      if (leaving.current.dirty) void leaving.current.save();
    },
    [],
  );

  async function reloadFromServer() {
    const got = await calls.templateGet(templateId);
    editor.reset(DocumentDefinition.parse(got.definition));
    setRevision(got.revision);
    revisionRef.current = got.revision;
    setIssues(got.issues);
    setSource(got.source);
    setName(got.name);
    setArchived(!!got.archivedAt);
    setConflict(false);
  }

  async function choosePdf() {
    try {
      const picked = await pickPdf();
      if (!picked) return;
      if (source) setAsking({ swap: picked });
      else await addPdf(picked);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function addPdf(picked: PickedPdf) {
    if (uploading) return;
    setUploading(true);
    try {
      if (editor.dirty) await save();
      const out = await calls.uploadTemplatePdf(templateId, picked, revisionRef.current);
      await reloadFromServer();
      toast.show(E.pdfAdded(out.removedFields + out.removedEdits, !!source));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  /**
   * "Place fields for me" (answer 4a): the worker finds the lines, boxes and labels on the PDF and the AI says which
   * are fields and whose; they go on as one change Undo takes back. Fields already there stay as they are.
   */
  async function placeForMe() {
    if (!source || placing) return;
    setPlacing(true);
    try {
      const fields = await calls.placeFields(templateId, editor.definition.roles);
      let placed = { added: 0, skipped: 0 };
      editor.change((def) => {
        const r = addPlacedFields(def, fields);
        placed = { added: r.added, skipped: r.skipped };
        return r.definition;
      });
      if (placed.added)
        toast.show(E.placed(placed.added), {
          action: { label: E.undo, onPress: () => editor.undo() },
        });
      else toast.show(placed.skipped ? E.placedAlready : E.placedNone);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPlacing(false);
    }
  }

  async function run(what: 'archive' | 'restore' | 'duplicate') {
    setBusy(what);
    try {
      if (what === 'duplicate') {
        if (editor.dirty) await save();
        const out = await calls.templateDuplicate(templateId);
        toast.show(E.copied);
        router.replace(templateHref(workspaceId, out.templateId));
        return;
      }
      if (what === 'archive') {
        if (editor.dirty) await save();
        await calls.templateArchive(templateId);
        setArchived(true);
        toast.show(E.archivedDone);
      } else {
        await calls.templateRestore(templateId);
        setArchived(false);
        toast.show(E.restored);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function rename() {
    const next = renaming.trim();
    if (!next || next === name) {
      setAsking(null);
      setRenaming(name);
      return;
    }
    setBusy('rename');
    try {
      await calls.templateRename(templateId, next);
      setName(next);
      setAsking(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const ready = !!source && issues.length === 0 && !problem;
  const badge = templateBadge({ archivedAt: archived ? 'yes' : null, ready });
  const saveState = !editable
    ? null
    : saving || uploading
      ? E.saving
      : problem
        ? problem
        : editor.dirty
          ? E.unsaved
          : E.saved;

  const head = (
    <Card className="gap-2.5 p-4" testID="template-head">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge variant={badge.tone} testID="template-badge">
          {badge.label}
        </Badge>
        {initial.documentsOut ? (
          <Text className="text-[12.5px] text-text-3">{W.out(initial.documentsOut)}</Text>
        ) : null}
        {saveState ? (
          <View className="ml-auto flex-row items-center gap-1">
            {saveState === E.saved ? <Icon as={Check} className="size-3.5 text-text-3" /> : null}
            <Text
              className={problem ? 'text-[12.5px] text-danger-text' : 'text-[12.5px] text-text-3'}
              testID="save-state"
            >
              {saveState}
            </Text>
          </View>
        ) : null}
      </View>
      {conflict ? (
        <View className="gap-2 rounded-menu bg-warning-soft px-3 py-2.5" testID="template-conflict">
          <Text className="text-[13px] text-warning-text">{E.conflict}</Text>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onPress={() => void reloadFromServer().catch((e) => toast.error(errorMessage(e)))}
            testID="template-load-theirs"
          >
            {E.loadTheirs}
          </Button>
        </View>
      ) : null}
      {source ? (
        issues.length ? (
          <View className="gap-1.5" testID="template-issues">
            <Text className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {E.phone.issuesTitle}
            </Text>
            {issues.map((i, n) => (
              <Text
                key={n}
                className="rounded-control bg-warning-soft px-2.5 py-2 text-[13px] text-warning-text"
              >
                {i.message}
              </Text>
            ))}
          </View>
        ) : (
          <Text className="text-[13px] text-text-2">{E.readyNothing}</Text>
        )
      ) : null}
      {source && !d.fields.length && editable ? (
        <Text className="text-[13px] text-text-2" testID="template-no-fields">
          {E.phone.noFields}
        </Text>
      ) : null}
      {!canManage ? <Text className="text-[13px] text-text-3">{E.ownersChange}</Text> : null}
      {source ? (
        <View className="flex-row flex-wrap gap-2 pt-0.5">
          {canSend && ready && !editor.dirty && !archived ? (
            <Button
              size="sm"
              icon={Send}
              onPress={() =>
                router.push(
                  businessHref(workspaceId, `documents/send?template=${templateId}`) as Href,
                )
              }
              testID="template-send"
            >
              {W.sendIt}
            </Button>
          ) : null}
          {editable ? (
            <Button
              variant="secondary"
              size="sm"
              icon={Sparkles}
              loading={placing}
              disabled={conflict}
              onPress={() => void placeForMe()}
              testID="template-place-fields"
            >
              {placing ? E.placing : E.placeForMe}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon={SlidersHorizontal}
            onPress={() => setAsking('settings')}
            testID="template-settings"
          >
            {E.whenSent}
          </Button>
        </View>
      ) : null}
    </Card>
  );

  const P = E.phone;
  return (
    <Screen
      title={name}
      leading="back"
      back={back}
      scroll={false}
      testID="template"
      trailing={
        canManage ? (
          <Button
            variant="ghost"
            size="md"
            icon={Ellipsis}
            accessibilityLabel={P.more}
            onPress={() => setAsking('more')}
            testID="template-more"
          />
        ) : undefined
      }
    >
      {source ? (
        <PagesEditor
          workspaceId={workspaceId}
          source={pagesSource}
          sourceKey={source.fileId}
          editor={editor}
          editable={editable && !conflict}
          header={head}
          testID="template-pages"
        />
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="gap-3 p-3 pb-8">
          {head}
          <Card className="items-center gap-3 px-5 py-10" testID="template-pdf-add">
            <Icon as={FileUp} className="size-7 text-text-3" />
            <Text className="text-center text-[15px] font-semibold">{E.addPdfTitle}</Text>
            <Text className="text-center text-[13px] text-text-2">{E.addPdfBody}</Text>
            {editable ? (
              <Button
                icon={FileUp}
                loading={uploading}
                onPress={() => void choosePdf()}
                testID="template-pdf-pick"
              >
                {E.choosePdf}
              </Button>
            ) : null}
          </Card>
        </ScrollView>
      )}

      <Sheet
        open={asking === 'more'}
        onClose={() => setAsking(null)}
        onClosed={() => {
          const next = afterSheet.current;
          afterSheet.current = null;
          next?.();
        }}
        title={name}
        testID="template-more-sheet"
      >
        <List>
          {editable ? (
            <ListRow
              icon={Pencil}
              label={P.rename}
              chevron={false}
              onPress={() => {
                setRenaming(name);
                afterSheet.current = () => setAsking('rename');
                setAsking(null);
              }}
              testID="template-rename"
            />
          ) : null}
          {editable && source ? (
            <ListRow
              icon={FileUp}
              label={E.swapPdf}
              chevron={false}
              onPress={() => {
                afterSheet.current = () => void choosePdf();
                setAsking(null);
              }}
              testID="template-swap"
            />
          ) : null}
          <ListRow
            icon={Copy}
            label={E.makeCopy}
            chevron={false}
            disabled={busy !== null}
            onPress={() => {
              setAsking(null);
              void run('duplicate');
            }}
            testID="template-copy"
          />
          {archived ? (
            <ListRow
              icon={RotateCcw}
              label={E.restore}
              chevron={false}
              disabled={busy !== null}
              onPress={() => {
                setAsking(null);
                void run('restore');
              }}
              testID="template-restore"
            />
          ) : (
            <ListRow
              icon={Archive}
              label={E.archive}
              chevron={false}
              danger
              disabled={busy !== null}
              onPress={() => {
                setAsking(null);
                void run('archive');
              }}
              testID="template-archive"
            />
          )}
        </List>
      </Sheet>

      <Sheet
        open={asking === 'rename'}
        onClose={() => busy !== 'rename' && setAsking(null)}
        title={P.rename}
        testID="template-rename-sheet"
      >
        <View className="gap-3">
          <Input
            value={renaming}
            maxLength={120}
            autoFocus
            accessibilityLabel={P.name}
            onChangeText={setRenaming}
            onSubmitEditing={() => void rename()}
            testID="template-name-input"
          />
          <Button
            loading={busy === 'rename'}
            onPress={() => void rename()}
            testID="template-name-save"
          >
            {P.saveName}
          </Button>
        </View>
      </Sheet>

      <Sheet
        open={asking === 'settings'}
        onClose={() => setAsking(null)}
        title={E.whenSent}
        scroll
        testID="template-settings-sheet"
      >
        {editable ? (
          <SettingsFields
            settings={d.settings}
            signers={d.roles.length}
            onChange={(patch) =>
              editor.change((def) => ({ ...def, settings: { ...def.settings, ...patch } }))
            }
          />
        ) : (
          <Text className="text-[13px] text-text-2">{E.ownersChange}</Text>
        )}
      </Sheet>

      <Sheet
        open={typeof asking === 'object' && asking !== null}
        onClose={() => setAsking(null)}
        title={E.swapPdf}
        description={E.swapAsk}
        testID="template-swap-sheet"
      >
        <View className="gap-3">
          <Button
            icon={FileUp}
            onPress={() => {
              const picked = typeof asking === 'object' && asking ? asking.swap : null;
              setAsking(null);
              if (picked) void addPdf(picked);
            }}
            testID="template-swap-go"
          >
            {E.swapPdf}
          </Button>
          <Button variant="ghost" onPress={() => setAsking(null)}>
            {P.cancel}
          </Button>
        </View>
      </Sheet>
    </Screen>
  );
}
