import {
  coveredBy,
  DOCUMENT_EDITOR_WORDS as E,
  DOCUMENT_FIELD_LABELS,
  DOCUMENT_FONTS,
  documentRoleColour,
  documentRoleName,
  FIELD_PROMPTS,
  fieldTypesFor,
  FILL_SOURCE_KEYS,
  FILL_SOURCES,
  MAX_DOCUMENT_ROLES,
  movedBox,
  newDocumentField,
  newDocumentTextBox,
  NO_FILL_TYPES,
  retypedField,
  SENDER_ROLE,
  typeOverLine,
  withEdit,
  withField,
  withoutPick,
  withoutRole,
  withRoleAdded,
  withRoleChanged,
  withRoleMoved,
  type DocumentEdit,
  type DocumentField,
  type DocumentFieldType,
  type DocumentPick,
  type DocumentRoleKind,
  type DocumentValueInput,
  type FillSource,
} from '@hfos/core';
import * as React from 'react';
import { PanResponder, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ArrowDown,
  ArrowUp,
  Calendar,
  CalendarCheck,
  Hash,
  Mail,
  PenLine,
  Phone,
  Plus,
  Replace,
  Signature,
  SlidersHorizontal,
  SquareCheck,
  SquareChevronDown,
  TextAlignStart,
  TextCursorInput,
  Trash,
  Type,
  Undo2,
  User,
  Users,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useColors } from '@/theme';

import type { PageLine, PagesSource } from './calls';
import type { DefinitionEditor, Tool } from './editor-state';
import {
  boxStyle,
  EditView,
  FieldView,
  PdfPagesView,
  usePagePictures,
  type PageLayer,
} from './pages';

/**
 * The template editor's pages on the phone (docs/documents.md, part 3, answer 24b), doing what the web's editor does
 * with a finger: pick what goes on the page from Add a field, then tap where it goes; tap the PDF's own words to type
 * over them (26c), or tap a blank spot for new words. A tap on something picks it; picked, it moves with a drag and
 * resizes from its corner, and a second tap opens its settings. Each drag is one change for Undo.
 *
 * The Send screen uses it with the fields fixed, for one customer's own word changes (27a).
 */

export const FIELD_ICONS = {
  signature: Signature,
  initials: PenLine,
  date_signed: CalendarCheck,
  name: User,
  email: Mail,
  phone: Phone,
  text: TextCursorInput,
  long_text: TextAlignStart,
  number: Hash,
  date: Calendar,
  checkbox: SquareCheck,
  choice: SquareChevronDown,
} as const satisfies Record<DocumentFieldType, unknown>;

/** How far a nudge moves or resizes, as a fraction of the page. */
const NUDGE = 0.005;
/** A finger moves this far, in pixels, before it's a drag and not a tap. */
const SLOP = 4;
/** The corner a picked item resizes from: the touch area, and the square drawn in it. */
const HANDLE = 28;
const HANDLE_DRAWN = 12;

type Box = { x: number; y: number; w: number; h: number };
type Sheets = 'palette' | 'roles' | 'picked' | null;

export function PagesEditor({
  workspaceId,
  source,
  sourceKey,
  editor,
  editable = true,
  fieldsEditable = true,
  values,
  header,
  testID,
}: {
  workspaceId: string;
  /** Whose pages are drawn; null before the template has its PDF. */
  source: PagesSource | null;
  /** Changes with the PDF, so its pages are drawn again. */
  sourceKey: string;
  editor: DefinitionEditor;
  /** False for someone who can only look. */
  editable?: boolean;
  /** False on the Send screen: the fields stay where the template has them. */
  fieldsEditable?: boolean;
  /** What's filled in, shown on the fields (the Send screen). */
  values?: Readonly<Record<string, DocumentValueInput>>;
  header?: React.ReactNode;
  testID?: string;
}) {
  const d = editor.definition;
  const insets = useSafeAreaInsets();
  const { pictures, want, failed, retry } = usePagePictures(workspaceId, source, sourceKey);
  const [chosenRole, setRole] = React.useState(() => d.roles[0]?.key ?? SENDER_ROLE);
  const [tool, setTool] = React.useState<Tool>(null);
  const [chosen, setPicked] = React.useState<DocumentPick>(null);
  const [sheet, setSheet] = React.useState<Sheets>(null);
  const [dragging, setDragging] = React.useState(false);

  // Undo, or a role taken off, can take away what was chosen.
  const role =
    chosenRole === SENDER_ROLE || d.roles.some((r) => r.key === chosenRole)
      ? chosenRole
      : (d.roles[0]?.key ?? SENDER_ROLE);
  const pickedField =
    chosen?.kind === 'field' ? d.fields.find((f) => f.id === chosen.id) : undefined;
  const pickedEdit = chosen?.kind === 'edit' ? d.edits.find((x) => x.id === chosen.id) : undefined;
  const picked: DocumentPick = pickedField || pickedEdit ? chosen : null;

  function place(index: number, at: { x: number; y: number }) {
    const page = d.pages[index];
    if (!tool || tool.kind === 'words' || !page) {
      setPicked(null);
      return;
    }
    if (tool.kind === 'field') {
      const f = newDocumentField(tool.type, role, page, index, at);
      editor.change((def) => ({ ...def, fields: [...def.fields, f] }));
      setPicked({ kind: 'field', id: f.id });
    } else {
      const t = newDocumentTextBox(page, index, at);
      editor.change((def) => ({ ...def, edits: [...def.edits, t] }));
      setPicked({ kind: 'edit', id: t.id });
      setSheet('picked');
    }
    setTool(null);
  }

  function typeOver(index: number, line: PageLine) {
    const edit = typeOverLine(index, line, line);
    editor.change((def) => ({ ...def, edits: [...def.edits, edit] }));
    setPicked({ kind: 'edit', id: edit.id });
    setTool(null);
    setSheet('picked');
  }

  function drag(kind: 'field' | 'edit', id: string, to: Box) {
    editor.preview((def) =>
      kind === 'field'
        ? withField(def, id, (f) => ({ ...f, ...to }))
        : withEdit(def, id, (x) => ({ ...x, ...to })),
    );
  }

  function removePicked() {
    if (!picked) return;
    editor.change((def) => withoutPick(def, picked));
    setPicked(null);
    setSheet(null);
  }

  const layer = ({ index, width, height, scale }: PageLayer) => {
    const placing = !!tool && tool.kind !== 'words';
    const items = (kind: 'field' | 'edit', item: Box & { id: string }) => ({
      box: item,
      size: { width, height },
      picked: picked?.kind === kind && picked.id === item.id,
      onPick: () => setPicked({ kind, id: item.id }),
      onOpen: () => setSheet('picked'),
      onDrag: (to: Box) => drag(kind, item.id, to),
      onDrop: () => editor.commit(),
      onDragging: setDragging,
    });
    const edits = d.edits.filter((x) => x.page === index);
    const fields = d.fields.filter((f) => f.page === index);
    const pickedHere = [...edits, ...fields].find((x) => x.id === picked?.id);
    return (
      <>
        {edits.map((x) =>
          editable && !placing ? (
            <React.Fragment key={x.id}>
              <EditView edit={x} scale={scale} />
              <ItemBox
                {...items('edit', x)}
                label={x.original ? `${E.changedWords}: ${x.original}` : E.addedWords}
                testID="edit-box"
                outline
              />
            </React.Fragment>
          ) : (
            <EditView key={x.id} edit={x} scale={scale} />
          ),
        )}
        {fields.map((f) => {
          const view = (
            <FieldView
              field={f}
              colour={documentRoleColour(d, f.role)}
              scale={scale}
              value={values?.[f.id] ?? d.presets[f.id]}
              picked={picked?.kind === 'field' && picked.id === f.id}
            />
          );
          const name = `${f.label || DOCUMENT_FIELD_LABELS[f.type]}, ${documentRoleName(d, f.role)}`;
          return editable && fieldsEditable && !placing ? (
            <ItemBox key={f.id} {...items('field', f)} label={name} testID="field-box">
              {view}
            </ItemBox>
          ) : (
            <View
              key={f.id}
              pointerEvents="none"
              style={boxStyle(f)}
              accessibilityLabel={name}
              testID="field-box"
            >
              {view}
            </View>
          );
        })}
        {pickedHere && editable && !placing ? (
          <ResizeHandle
            {...items(picked!.kind, pickedHere)}
            testID="picked-resize"
            label={E.phone.resize}
          />
        ) : null}
        {tool?.kind === 'words'
          ? (pictures[index]?.lines ?? [])
              .filter((line) => !d.edits.some((x) => x.page === index && coveredBy(line, x)))
              .map((line, i) => (
                <WordLine key={i} line={line} onPress={() => typeOver(index, line)} />
              ))
          : null}
      </>
    );
  };

  const hint = !tool
    ? null
    : tool.kind === 'words'
      ? E.phone.hintWords
      : tool.kind === 'textbox'
        ? E.phone.hintTextbox
        : E.phone.hintField(DOCUMENT_FIELD_LABELS[tool.type]);

  return (
    <View className="flex-1" testID={testID}>
      <PdfPagesView
        pages={d.pages}
        pictures={pictures}
        onWant={want}
        failed={failed}
        onRetry={retry}
        header={header}
        layer={layer}
        onPagePress={editable ? place : undefined}
        scrollEnabled={!dragging}
        testID="editor-pages"
      />
      {editable ? (
        <View
          className="gap-2 border-t border-border bg-card px-3 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          testID="editor-bar"
        >
          {hint ? (
            <View className="flex-row items-center gap-3">
              <Text className="min-w-0 flex-1 text-[13px] text-accent-text" testID="tool-hint">
                {hint}
              </Text>
              <Button
                variant="secondary"
                size="md"
                onPress={() => setTool(null)}
                testID="tool-stop"
              >
                {E.phone.stop}
              </Button>
            </View>
          ) : picked ? (
            <>
              <Text className="text-[12.5px] text-text-3">{E.phone.hintPicked}</Text>
              <View className="flex-row items-center gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  icon={SlidersHorizontal}
                  className="flex-1"
                  onPress={() => setSheet('picked')}
                  testID="picked-settings"
                >
                  {E.phone.settings}
                </Button>
                <Button
                  variant="ghostDanger"
                  size="md"
                  icon={Trash}
                  accessibilityLabel={pickedEdit?.original ? E.putBack : E.takeOff}
                  onPress={removePicked}
                  testID="picked-remove"
                />
                <UndoButton editor={editor} />
                <Button size="md" onPress={() => setPicked(null)} testID="picked-done">
                  {E.phone.done}
                </Button>
              </View>
            </>
          ) : (
            <View className="flex-row items-center gap-2">
              <Button
                variant="secondary"
                size="md"
                icon={fieldsEditable ? Plus : Replace}
                className="flex-1"
                onPress={() => setSheet('palette')}
                testID="editor-add"
              >
                {fieldsEditable ? E.phone.addField : E.phone.changeWords}
              </Button>
              {fieldsEditable ? (
                <Button
                  variant="secondary"
                  size="md"
                  icon={Users}
                  onPress={() => setSheet('roles')}
                  testID="editor-roles"
                >
                  {E.whoSigns}
                </Button>
              ) : null}
              <UndoButton editor={editor} />
            </View>
          )}
        </View>
      ) : null}

      <Sheet
        open={sheet === 'palette'}
        onClose={() => setSheet(null)}
        title={fieldsEditable ? E.phone.pickKind : E.phone.changeWords}
        scroll
        testID="palette-sheet"
      >
        <Palette
          editor={editor}
          role={role}
          onRole={setRole}
          fields={fieldsEditable}
          onTool={(t) => {
            setPicked(null);
            setTool(t);
            setSheet(null);
          }}
        />
      </Sheet>
      <Sheet
        open={sheet === 'roles'}
        onClose={() => setSheet(null)}
        title={E.whoSigns}
        scroll
        testID="roles-sheet"
      >
        <RolesSheet editor={editor} />
      </Sheet>
      <Sheet
        open={sheet === 'picked' && !!picked}
        onClose={() => setSheet(null)}
        title={
          pickedField
            ? DOCUMENT_FIELD_LABELS[pickedField.type]
            : pickedEdit?.original
              ? E.changedWords
              : E.addedWords
        }
        scroll
        testID="picked-sheet"
      >
        {pickedField ? (
          <FieldSettings editor={editor} field={pickedField} onRemove={removePicked} />
        ) : pickedEdit ? (
          <EditSettings editor={editor} edit={pickedEdit} onRemove={removePicked} />
        ) : null}
      </Sheet>
    </View>
  );
}

function UndoButton({ editor }: { editor: DefinitionEditor }) {
  return (
    <Button
      variant="ghost"
      size="md"
      icon={Undo2}
      accessibilityLabel={E.undo}
      disabled={!editor.canUndo}
      onPress={editor.undo}
      testID="editor-undo"
    />
  );
}

// ---------- on the page ----------

interface Grab {
  box: Box;
  /** The page on the screen, in pixels. */
  size: { width: number; height: number };
  picked: boolean;
  onPick: () => void;
  onOpen: () => void;
  onDrag: (to: Box) => void;
  onDrop: () => void;
  onDragging: (on: boolean) => void;
}

/**
 * A drag of a picked item: the box it started as, moved or resized by how far the finger has gone in fractions of the
 * page. A finger that barely moves is a tap. The page's scroll stops while it's held, so the drag isn't a scroll.
 */
function useGrab(how: 'move' | 'resize', grab: Grab, onTap: () => void) {
  const latest = React.useRef({ grab, onTap });
  latest.current = { grab, onTap };
  return React.useMemo(() => {
    let start: Box = grab.box;
    let moved = false;
    const end = (release: boolean) => {
      const g = latest.current.grab;
      g.onDragging(false);
      if (moved) g.onDrop();
      else if (release) latest.current.onTap();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const g = latest.current.grab;
        start = { x: g.box.x, y: g.box.y, w: g.box.w, h: g.box.h };
        moved = false;
        g.onDragging(true);
      },
      onPanResponderMove: (_e, gesture) => {
        if (!moved && Math.abs(gesture.dx) + Math.abs(gesture.dy) < SLOP) return;
        moved = true;
        const { size, onDrag } = latest.current.grab;
        onDrag(movedBox(start, how, gesture.dx / size.width, gesture.dy / size.height));
      },
      onPanResponderRelease: () => end(true),
      onPanResponderTerminate: () => end(false),
    });
    // Made once: what changes is read from `latest`.
  }, [how]);
}

/** Something placed on the page: a tap picks it; picked, it drags, and another tap opens its settings. */
function ItemBox({
  label,
  testID,
  outline,
  children,
  ...grab
}: Grab & {
  label: string;
  testID: string;
  /** Word changes show their edge, since they look like the page. */
  outline?: boolean;
  children?: React.ReactNode;
}) {
  const colors = useColors();
  const move = useGrab('move', grab, grab.onOpen);
  const edge = outline
    ? {
        borderWidth: grab.picked ? 2 : 1,
        borderStyle: grab.picked ? ('solid' as const) : ('dashed' as const),
        borderColor: grab.picked ? colors.accent : `${colors.accent}80`,
      }
    : null;
  if (!grab.picked)
    return (
      <Pressable
        style={[boxStyle(grab.box), edge]}
        onPress={grab.onPick}
        role="button"
        accessibilityLabel={label}
        testID={testID}
      >
        {children}
      </Pressable>
    );
  return (
    <View
      style={[boxStyle(grab.box), edge]}
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: true }}
      accessibilityHint={E.phone.hintPicked}
      testID={testID}
      {...move.panHandlers}
    >
      {children}
    </View>
  );
}

/** The picked item's corner, to resize it from. It sits on the page, not in the item, so a small one keeps it. */
function ResizeHandle({ label, testID, ...grab }: Grab & { label: string; testID: string }) {
  const colors = useColors();
  const resize = useGrab('resize', grab, () => undefined);
  const { box, size } = grab;
  return (
    <View
      style={{
        position: 'absolute',
        left: (box.x + box.w) * size.width - HANDLE / 2,
        top: (box.y + box.h) * size.height - HANDLE / 2,
        width: HANDLE,
        height: HANDLE,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityLabel={label}
      testID={testID}
      {...resize.panHandlers}
    >
      <View
        style={{
          width: HANDLE_DRAWN,
          height: HANDLE_DRAWN,
          borderRadius: 2,
          borderWidth: 1,
          borderColor: '#ffffff',
          backgroundColor: colors.accent,
        }}
      />
    </View>
  );
}

/** A line of the PDF's words that can be typed over. */
function WordLine({ line, onPress }: { line: PageLine; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      style={({ pressed }) => [
        boxStyle(line),
        {
          borderRadius: 2,
          borderWidth: 1,
          borderColor: `${colors.accent}66`,
          backgroundColor: `${colors.accent}${pressed ? '40' : '1a'}`,
        },
      ]}
      onPress={onPress}
      role="button"
      accessibilityLabel={`Type over “${line.text}”`}
      testID="word-line"
    />
  );
}

// ---------- the sheets ----------

const Dot = ({ colour }: { colour: string }) => (
  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colour }} />
);

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Label>{label}</Label>
      {children}
    </View>
  );
}

/** What can go on the page: a field for whoever's chosen, or the PDF's words. */
function Palette({
  editor,
  role,
  onRole,
  fields,
  onTool,
}: {
  editor: DefinitionEditor;
  role: string;
  onRole: (role: string) => void;
  fields: boolean;
  onTool: (tool: NonNullable<Tool>) => void;
}) {
  const d = editor.definition;
  const roles = [...d.roles.map((r) => r.key), SENDER_ROLE];
  return (
    <View className="gap-4 pb-2">
      {fields ? (
        <>
          <Section label={E.whoFillsIn}>
            <View className="flex-row flex-wrap gap-1.5" testID="palette-roles">
              {roles.map((key) => (
                <FilterChip
                  key={key}
                  label={documentRoleName(d, key)}
                  on={role === key}
                  onPress={() => onRole(key)}
                  icon={<Dot colour={documentRoleColour(d, key)} />}
                  testID={`role-${key}`}
                />
              ))}
            </View>
          </Section>
          <Section label={E.addFor(documentRoleName(d, role))}>
            <View className="flex-row flex-wrap gap-1.5">
              {fieldTypesFor(role).map((type) => (
                <FilterChip
                  key={type}
                  label={DOCUMENT_FIELD_LABELS[type]}
                  on={false}
                  onPress={() => onTool({ kind: 'field', type })}
                  icon={<Icon as={FIELD_ICONS[type]} className="size-4 text-text-2" />}
                  testID={`tool-${type}`}
                />
              ))}
            </View>
          </Section>
        </>
      ) : (
        <Text className="text-[13px] text-text-2">{E.templateStays}</Text>
      )}
      <Section label={E.pdfWords}>
        <View className="flex-row flex-wrap gap-1.5">
          <FilterChip
            label={E.changeWords}
            on={false}
            onPress={() => onTool({ kind: 'words' })}
            icon={<Icon as={Replace} className="size-4 text-text-2" />}
            testID="tool-words"
          />
          <FilterChip
            label={E.addWords}
            on={false}
            onPress={() => onTool({ kind: 'textbox' })}
            icon={<Icon as={Type} className="size-4 text-text-2" />}
            testID="tool-textbox"
          />
        </View>
      </Section>
    </View>
  );
}

/** Who signs, in their order: what each is called, who they are, and taking one off with their fields. */
function RolesSheet({ editor }: { editor: DefinitionEditor }) {
  const d = editor.definition;
  const [asking, setAsking] = React.useState<string | null>(null);
  const count = (key: string) => d.fields.filter((f) => f.role === key).length;

  function remove(key: string) {
    if (count(key) && asking !== key) {
      setAsking(key);
      return;
    }
    setAsking(null);
    editor.change((def) => withoutRole(def, key));
  }
  const add = (kind: DocumentRoleKind) =>
    editor.change((def) => withRoleAdded(def, kind).definition);

  return (
    <View className="gap-3 pb-2" testID="roles">
      {d.roles.map((r, i) => (
        <View key={r.key} className="gap-2 rounded-menu border border-border p-3">
          <View className="flex-row items-center gap-2">
            <Text className="w-4 text-[13px] text-text-3">{i + 1}</Text>
            <Dot colour={documentRoleColour(d, r.key)} />
            <Input
              value={r.label}
              maxLength={60}
              accessibilityLabel={E.roleLabel}
              onChangeText={(label) =>
                editor.change((def) => withRoleChanged(def, r.key, { label }))
              }
              className="h-10 flex-1"
              testID={`role-label-${r.key}`}
            />
          </View>
          <Segmented
            value={r.kind}
            onChange={(kind) => editor.change((def) => withRoleChanged(def, r.key, { kind }))}
            label={E.roleKind}
            options={[
              { value: 'customer', label: E.kindCustomer },
              { value: 'team', label: E.kindTeam },
            ]}
          />
          <View className="flex-row items-center gap-1">
            <View className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              icon={ArrowUp}
              accessibilityLabel={E.signsEarlier}
              disabled={i === 0}
              onPress={() => editor.change((def) => withRoleMoved(def, r.key, -1))}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={ArrowDown}
              accessibilityLabel={E.signsLater}
              disabled={i === d.roles.length - 1}
              onPress={() => editor.change((def) => withRoleMoved(def, r.key, 1))}
            />
            <Button
              variant="ghostDanger"
              size="sm"
              icon={Trash}
              accessibilityLabel={E.takeRoleOff(r.label)}
              disabled={d.roles.length < 2}
              onPress={() => remove(r.key)}
              testID={`role-remove-${r.key}`}
            />
          </View>
          {asking === r.key ? (
            <View className="gap-2 rounded-control bg-danger-soft p-2.5">
              <Text className="text-[13px] text-danger-text">
                {E.takeRoleOffAsk(r.label, count(r.key))}
              </Text>
              <View className="flex-row gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  onPress={() => remove(r.key)}
                  testID="role-remove-yes"
                >
                  {E.takeRoleOff(r.label)}
                </Button>
                <Button variant="ghost" size="sm" onPress={() => setAsking(null)}>
                  {E.phone.stop}
                </Button>
              </View>
            </View>
          ) : null}
        </View>
      ))}
      {d.roles.length < MAX_DOCUMENT_ROLES ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={Plus}
            onPress={() => add('customer')}
            testID="role-add-customer"
          >
            {E.addCustomer}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={Plus}
            onPress={() => add('team')}
            testID="role-add-team"
          >
            {E.addTeam}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const FILL_GROUPS = [...new Set(FILL_SOURCE_KEYS.map((k) => FILL_SOURCES[k].group))];

/** Moving and resizing by steps, for a finger that can't drag finely or a screen reader. */
function Nudges({ box, onChange }: { box: Box; onChange: (to: Box) => void }) {
  const by = (how: 'move' | 'resize', dx: number, dy: number) =>
    onChange(movedBox(box, how, dx, dy));
  const nudge = (label: string, how: 'move' | 'resize', dx: number, dy: number) => (
    <Button
      key={label}
      variant="secondary"
      size="sm"
      onPress={() => by(how, dx, dy)}
      testID={`nudge-${label.toLowerCase()}`}
    >
      {label}
    </Button>
  );
  const P = E.phone;
  return (
    <>
      <Section label={P.move}>
        <View className="flex-row flex-wrap gap-1.5">
          {nudge(P.up, 'move', 0, -NUDGE)}
          {nudge(P.down, 'move', 0, NUDGE)}
          {nudge(P.left, 'move', -NUDGE, 0)}
          {nudge(P.right, 'move', NUDGE, 0)}
        </View>
      </Section>
      <Section label={P.resize}>
        <View className="flex-row flex-wrap gap-1.5">
          {nudge(P.wider, 'resize', NUDGE, 0)}
          {nudge(P.narrower, 'resize', -NUDGE, 0)}
          {nudge(P.taller, 'resize', 0, NUDGE)}
          {nudge(P.shorter, 'resize', 0, -NUDGE)}
        </View>
      </Section>
    </>
  );
}

/** A number kept as typed until it's one the setting takes. */
function NumberInput({
  value,
  lo,
  hi,
  onChange,
  label,
  testID,
}: {
  value: number;
  lo: number;
  hi: number;
  onChange: (n: number) => void;
  label: string;
  testID?: string;
}) {
  const [typed, setTyped] = React.useState(String(value));
  const ok = (t: string) => {
    const n = Number(t);
    return t.trim() && Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  React.useEffect(() => {
    // Undo puts back another number.
    setTyped((t) => (ok(t) === value ? t : String(value)));
  }, [value]);
  return (
    <Input
      value={typed}
      keyboardType="decimal-pad"
      maxLength={4}
      accessibilityLabel={label}
      invalid={ok(typed) === null}
      onChangeText={(t) => {
        setTyped(t);
        const n = ok(t);
        if (n !== null) onChange(n);
      }}
      testID={testID}
    />
  );
}

function FieldSettings({
  editor,
  field,
  onRemove,
}: {
  editor: DefinitionEditor;
  field: DocumentField;
  onRemove: () => void;
}) {
  const d = editor.definition;
  const set = (patch: Partial<DocumentField>) =>
    editor.change((def) => withField(def, field.id, (f) => ({ ...f, ...patch })));
  const roles = [
    ...d.roles.map((r) => r.key),
    ...(fieldTypesFor(SENDER_ROLE).includes(field.type) ? [SENDER_ROLE] : []),
  ];
  const [choices, setChoices] = React.useState(field.options.join('\n'));

  return (
    <View className="gap-4 pb-2" testID="field-settings">
      <Section label={E.whoFillsIn}>
        <View className="flex-row flex-wrap gap-1.5">
          {roles.map((key) => (
            <FilterChip
              key={key}
              label={documentRoleName(d, key)}
              on={field.role === key}
              onPress={() => set({ role: key })}
              icon={<Dot colour={documentRoleColour(d, key)} />}
              testID={`field-role-${key}`}
            />
          ))}
        </View>
      </Section>
      <Section label={E.kind}>
        <View className="flex-row flex-wrap gap-1.5">
          {fieldTypesFor(field.role).map((t) => (
            <FilterChip
              key={t}
              label={DOCUMENT_FIELD_LABELS[t]}
              on={field.type === t}
              onPress={() => set(retypedField(field, t))}
              testID={`field-type-${t}`}
            />
          ))}
        </View>
      </Section>
      <Section label={E.asksFor}>
        <Input
          value={field.label}
          maxLength={80}
          placeholder={FIELD_PROMPTS[field.type]}
          onChangeText={(label) => set({ label })}
          testID="field-label"
        />
      </Section>
      {field.type === 'date_signed' ? (
        <Text className="text-[12.5px] text-text-3">{E.dateSignedNote}</Text>
      ) : (
        <View className="flex-row items-center gap-3">
          <Text className="min-w-0 flex-1 text-[14px]">{E.required}</Text>
          <Switch
            checked={field.required}
            onCheckedChange={(required) => set({ required })}
            label={E.required}
            testID="field-required"
          />
        </View>
      )}
      {NO_FILL_TYPES.includes(field.type) ? null : (
        <Section label={E.fillFrom}>
          <View className="gap-2" testID="field-fill">
            <View className="flex-row flex-wrap gap-1.5">
              <FilterChip
                label={E.fillNothing}
                on={!field.fillFrom}
                onPress={() => set({ fillFrom: null })}
                testID="field-fill-none"
              />
            </View>
            {FILL_GROUPS.map((g) => (
              <View key={g} className="gap-1">
                <Text className="text-[12px] text-text-3">{g}</Text>
                <View className="flex-row flex-wrap gap-1.5">
                  {FILL_SOURCE_KEYS.filter((k) => FILL_SOURCES[k].group === g).map((k) => (
                    <FilterChip
                      key={k}
                      label={FILL_SOURCES[k].label}
                      on={field.fillFrom === k}
                      onPress={() => set({ fillFrom: k as FillSource })}
                      testID={`field-fill-${k}`}
                    />
                  ))}
                </View>
              </View>
            ))}
            {field.fillFrom && field.role !== SENDER_ROLE ? (
              <Text className="text-[12.5px] text-text-3">{E.fillCanChange}</Text>
            ) : null}
          </View>
        </Section>
      )}
      {field.type === 'choice' ? (
        <Section label={E.choices}>
          <Input
            value={choices}
            multiline
            className="h-28 py-3"
            onChangeText={(t) => {
              setChoices(t);
              set({
                options: t
                  .split('\n')
                  .map((o) => o.trim().slice(0, 80))
                  .filter(Boolean)
                  .slice(0, 20),
              });
            }}
            testID="field-choices"
          />
        </Section>
      ) : null}
      {field.type === 'signature' ||
      field.type === 'initials' ||
      field.type === 'checkbox' ? null : (
        <Section label={E.textSize}>
          <NumberInput
            value={field.fontSize}
            lo={6}
            hi={36}
            label={E.textSize}
            onChange={(fontSize) => set({ fontSize })}
            testID="field-size"
          />
        </Section>
      )}
      <Nudges box={field} onChange={(to) => set(to)} />
      <Button
        variant="ghostDanger"
        size="md"
        icon={Trash}
        className="self-start"
        onPress={onRemove}
        testID="field-remove"
      >
        {E.takeOff}
      </Button>
    </View>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A colour, typed as #RRGGBB beside a swatch of it. */
function ColourInput({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  testID?: string;
}) {
  const colors = useColors();
  const [typed, setTyped] = React.useState(value);
  React.useEffect(() => {
    setTyped((t) => (t.toLowerCase() === value.toLowerCase() ? t : value));
  }, [value]);
  return (
    <View className="min-w-0 flex-1 gap-1.5">
      <Label>{label}</Label>
      <View className="flex-row items-center gap-2">
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: colors.borderStrong,
            backgroundColor: HEX.test(typed) ? typed : value,
          }}
        />
        <Input
          value={typed}
          maxLength={7}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={label}
          accessibilityHint={E.phone.colourHint}
          invalid={!HEX.test(typed)}
          onChangeText={(t) => {
            const hex = t.startsWith('#') ? t : `#${t}`;
            setTyped(hex);
            if (HEX.test(hex)) onChange(hex.toLowerCase());
          }}
          className="h-10 flex-1"
          testID={testID}
        />
      </View>
    </View>
  );
}

function EditSettings({
  editor,
  edit,
  onRemove,
}: {
  editor: DefinitionEditor;
  edit: DocumentEdit;
  onRemove: () => void;
}) {
  const set = (patch: Partial<DocumentEdit>) =>
    editor.change((def) => withEdit(def, edit.id, (x) => ({ ...x, ...patch })));
  return (
    <View className="gap-4 pb-2" testID="edit-settings">
      {edit.original ? (
        <Text className="rounded-control bg-card-2 px-2.5 py-2 text-[13px] text-text-2">
          <Text className="text-[13px] text-text-3">{E.was}</Text>
          {edit.original}
        </Text>
      ) : null}
      <Section label={edit.original ? E.nowSays : E.words}>
        <Input
          value={edit.text}
          maxLength={2000}
          multiline
          autoFocus
          className="h-24 py-3"
          onChangeText={(text) => set({ text })}
          testID="edit-text"
        />
        {edit.original && !edit.text.trim() ? (
          <Text className="text-[12.5px] text-text-3">{E.emptyTakesOut}</Text>
        ) : null}
      </Section>
      <Section label={E.font}>
        <Segmented
          value={edit.font}
          onChange={(font) => set({ font })}
          label={E.font}
          options={DOCUMENT_FONTS.map((f) => ({ value: f, label: E.fonts[f] }))}
          testID="edit-font"
        />
      </Section>
      <View className="flex-row items-end gap-3">
        <View className="min-w-0 flex-1 gap-1.5">
          <Label>{E.size}</Label>
          <NumberInput
            value={edit.size}
            lo={4}
            hi={72}
            label={E.size}
            onChange={(size) => set({ size })}
            testID="edit-size"
          />
        </View>
        <View className="h-12 flex-row items-center gap-3">
          <Text className="text-[14px]">{E.bold}</Text>
          <Switch
            checked={edit.bold}
            onCheckedChange={(bold) => set({ bold })}
            label={E.bold}
            testID="edit-bold"
          />
        </View>
      </View>
      <View className="flex-row gap-3">
        <ColourInput
          label={E.wordsColour}
          value={edit.color}
          onChange={(color) => set({ color })}
          testID="edit-colour"
        />
        <ColourInput
          label={E.behindColour}
          value={edit.background}
          onChange={(background) => set({ background })}
          testID="edit-behind"
        />
      </View>
      <Nudges box={edit} onChange={(to) => set(to)} />
      <Button
        variant="ghostDanger"
        size="md"
        icon={Trash}
        className="self-start"
        onPress={onRemove}
        testID="edit-remove"
      >
        {edit.original ? E.putBack : E.takeOff}
      </Button>
    </View>
  );
}
