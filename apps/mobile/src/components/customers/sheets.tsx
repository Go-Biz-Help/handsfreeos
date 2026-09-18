import { FILE_WORDS, TASK_WORDS, type TagRef } from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Camera, Check, Images, Plus } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The sheets a record opens: a note, its tags, its details, a new task and where a photo comes from. Each lifts above
 * the keyboard with the kit's `useKeyboardHeight` (step 14's fix, moved into the kit here because every screen with a
 * box at the bottom needs it).
 */

export const RECORD_SHEET_WORDS = {
  note: {
    title: (name: string) => `A note about ${name}`,
    placeholder: 'Add a note for the team…',
    save: 'Add note',
    saved: 'Note added. It shows on their timeline.',
    onlyTeam: 'Only your team sees notes.',
  },
  tags: {
    title: 'Tags',
    /** The canvas's line under the tags. */
    explain:
      'Adding or removing a tag changes only that tag, so two people tagging at once both keep theirs.',
    none: 'No tags yet.',
    save: 'Done',
  },
  edit: {
    title: 'Edit details',
    save: 'Save',
    nothing: 'Nothing changed.',
    saved: 'Saved.',
    /** What the field-merge rules mean, in the person's words. */
    merge: 'Only what you change is sent, so a teammate’s other changes stay.',
  },
  task: {
    title: 'New task',
    placeholder: 'Call about the estimate',
    save: 'Add task',
    saved: 'Task added.',
    due: 'Due',
    noDue: 'No due date',
    today: 'Today',
    tomorrow: 'Tomorrow',
    week: 'Next week',
    assign: 'For',
    me: 'Me',
    anyone: 'Anyone',
  },
  photo: {
    title: 'Add a photo',
    camera: FILE_WORDS.takePhoto,
    library: FILE_WORDS.chooseFromLibrary,
    added: 'Photo added. It uploads on its own.',
    noCamera: 'HandsFreeOS needs the camera to take a photo. Turn it on in Settings.',
  },
} as const;

export function NoteSheet({
  open,
  name,
  onClose,
  onSave,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
  onSave: (body: string) => void | Promise<void>;
}) {
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const keyboard = useKeyboardHeight();
  React.useEffect(() => {
    if (open) setBody('');
  }, [open]);
  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(body.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RECORD_SHEET_WORDS.note.title(name)}
      description={RECORD_SHEET_WORDS.note.onlyTeam}
      testID="note-sheet"
    >
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        <Input
          value={body}
          onChangeText={setBody}
          placeholder={RECORD_SHEET_WORDS.note.placeholder}
          multiline
          autoFocus
          className="h-28 py-3"
          testID="note-body"
        />
        <Button onPress={() => void save()} loading={busy} testID="note-save">
          {RECORD_SHEET_WORDS.note.save}
        </Button>
      </View>
    </Sheet>
  );
}

export function TagSheet({
  open,
  tags,
  chosen,
  onClose,
  onSave,
}: {
  open: boolean;
  tags: readonly TagRef[];
  chosen: readonly TagRef[];
  onClose: () => void;
  onSave: (ids: readonly string[]) => void | Promise<void>;
}) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setIds(chosen.map((t) => t.id));
  }, [open, chosen]);
  const toggle = (id: string) =>
    setIds((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RECORD_SHEET_WORDS.tags.title}
      description={RECORD_SHEET_WORDS.tags.explain}
      testID="tag-sheet"
    >
      <View className="gap-2">
        {tags.length === 0 ? (
          <Text className="py-4 text-center text-[13px] text-text-3">
            {RECORD_SHEET_WORDS.tags.none}
          </Text>
        ) : (
          <ScrollView className="max-h-80" contentContainerClassName="gap-1">
            {tags.map((t) => (
              <Pressable
                key={t.id}
                role="checkbox"
                accessibilityState={{ checked: ids.includes(t.id) }}
                onPress={() => toggle(t.id)}
                className="min-h-12 flex-row items-center gap-3 rounded-menu px-2"
                testID={`tag-row-${t.name}`}
              >
                <View className="size-[9px] rounded-full" style={{ backgroundColor: t.color }} />
                <Text className="min-w-0 flex-1 text-[15px]">{t.name}</Text>
                {ids.includes(t.id) ? (
                  <Icon as={Check} className="size-5 text-accent-text" />
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        )}
        <Button
          onPress={() => {
            setBusy(true);
            void Promise.resolve(onSave(ids)).finally(() => {
              setBusy(false);
              onClose();
            });
          }}
          loading={busy}
          testID="tag-save"
        >
          {RECORD_SHEET_WORDS.tags.save}
        </Button>
      </View>
    </Sheet>
  );
}

export interface Field {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly keyboard?: 'default' | 'phone-pad' | 'email-address';
  readonly multiline?: boolean;
}

/** The details sheet: every field the phone may edit, saving only what changed. */
export function EditSheet({
  open,
  fields,
  onClose,
  onSave,
}: {
  open: boolean;
  fields: readonly Field[];
  onClose: () => void;
  onSave: (values: Readonly<Record<string, string>>) => void | Promise<void>;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const keyboard = useKeyboardHeight();
  React.useEffect(() => {
    if (open) setValues(Object.fromEntries(fields.map((f) => [f.key, f.value])));
  }, [open, fields]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RECORD_SHEET_WORDS.edit.title}
      description={RECORD_SHEET_WORDS.edit.merge}
      testID="edit-sheet"
    >
      <ScrollView
        className="max-h-[420px]"
        contentContainerClassName="gap-3"
        keyboardShouldPersistTaps="handled"
      >
        {fields.map((f) => (
          <View key={f.key} className="gap-1">
            <Text className="text-[13px] font-medium">{f.label}</Text>
            <Input
              value={values[f.key] ?? ''}
              onChangeText={(v) => setValues((all) => ({ ...all, [f.key]: v }))}
              keyboardType={f.keyboard ?? 'default'}
              autoCapitalize={f.keyboard === 'email-address' ? 'none' : 'sentences'}
              multiline={f.multiline}
              className={cn(f.multiline && 'h-24 py-3')}
              testID={`edit-${f.key}`}
            />
          </View>
        ))}
      </ScrollView>
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="pt-3">
        <Button
          onPress={() => {
            setBusy(true);
            void Promise.resolve(onSave(values)).finally(() => {
              setBusy(false);
              onClose();
            });
          }}
          loading={busy}
          testID="edit-save"
        >
          {RECORD_SHEET_WORDS.edit.save}
        </Button>
      </View>
    </Sheet>
  );
}

export interface TaskDraft {
  readonly title: string;
  readonly dueAt: string | null;
  readonly allDay: boolean;
  readonly assigneeUserId: string | null;
}

const startOfDay = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

/** A new task on a record: a title, when it's due (a few plain choices) and who it's for. */
export function TaskSheet({
  open,
  members,
  myUserId,
  onClose,
  onSave,
}: {
  open: boolean;
  members: readonly { readonly id: string; readonly fullName: string }[];
  myUserId: string;
  onClose: () => void;
  onSave: (task: TaskDraft) => void | Promise<void>;
}) {
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState<'none' | 'today' | 'tomorrow' | 'week'>('today');
  const [assignee, setAssignee] = React.useState<string | null>(myUserId);
  const [busy, setBusy] = React.useState(false);
  const keyboard = useKeyboardHeight();
  React.useEffect(() => {
    if (open) {
      setTitle('');
      setDue('today');
      setAssignee(myUserId);
    }
  }, [open, myUserId]);
  const dueAt =
    due === 'none' ? null : startOfDay(due === 'today' ? 0 : due === 'tomorrow' ? 1 : 7);
  const w = RECORD_SHEET_WORDS.task;
  return (
    <Sheet open={open} onClose={onClose} title={w.title} testID="task-sheet">
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder={w.placeholder}
          autoFocus
          testID="task-title"
        />
        <Text className="text-[13px] font-medium">{w.due}</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {(
            [
              ['today', w.today],
              ['tomorrow', w.tomorrow],
              ['week', w.week],
              ['none', w.noDue],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              role="radio"
              accessibilityState={{ selected: due === key }}
              onPress={() => setDue(key)}
              className={cn(
                'min-h-11 justify-center rounded-full px-3.5',
                due === key ? 'bg-accent' : 'border border-border-strong bg-card',
              )}
              testID={`task-due-${key}`}
            >
              <Text
                className={cn('text-[13px] font-medium', due === key ? 'text-white' : 'text-text')}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text className="text-[13px] font-medium">{w.assign}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-1.5"
        >
          {[{ id: myUserId, fullName: w.me }, ...members.filter((m) => m.id !== myUserId)].map(
            (m) => (
              <Pressable
                key={m.id}
                role="radio"
                accessibilityState={{ selected: assignee === m.id }}
                onPress={() => setAssignee(m.id)}
                className={cn(
                  'min-h-11 justify-center rounded-full px-3.5',
                  assignee === m.id ? 'bg-accent' : 'border border-border-strong bg-card',
                )}
                testID={`task-for-${m.id}`}
              >
                <Text
                  className={cn(
                    'text-[13px] font-medium',
                    assignee === m.id ? 'text-white' : 'text-text',
                  )}
                >
                  {m.fullName}
                </Text>
              </Pressable>
            ),
          )}
        </ScrollView>
        <Button
          disabled={!title.trim()}
          loading={busy}
          onPress={() => {
            if (!title.trim()) return;
            setBusy(true);
            void Promise.resolve(
              onSave({ title, dueAt, allDay: true, assigneeUserId: assignee }),
            ).finally(() => {
              setBusy(false);
              onClose();
            });
          }}
          testID="task-save"
        >
          {w.save}
        </Button>
      </View>
    </Sheet>
  );
}

/** Where a photo comes from: the camera, or the phone's library (the canvas's two rows). */
export function PhotoSheet({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (source: 'camera' | 'library') => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RECORD_SHEET_WORDS.photo.title}
      testID="photo-sheet"
    >
      <View className="gap-1">
        <Pressable
          role="button"
          onPress={() => onPick('camera')}
          className="min-h-14 flex-row items-center gap-3 rounded-menu px-2"
          testID="photo-camera"
        >
          <Icon as={Camera} className="size-5 text-text-2" />
          <Text className="text-[15px]">{RECORD_SHEET_WORDS.photo.camera}</Text>
        </Pressable>
        <Pressable
          role="button"
          onPress={() => onPick('library')}
          className="min-h-14 flex-row items-center gap-3 rounded-menu px-2"
          testID="photo-library"
        >
          <Icon as={Images} className="size-5 text-text-2" />
          <Text className="text-[15px]">{RECORD_SHEET_WORDS.photo.library}</Text>
        </Pressable>
        <Text className="px-2 pt-1 text-[12.5px] text-text-3">{FILE_WORDS.limits}</Text>
      </View>
    </Sheet>
  );
}

/** "New task" on an empty list, and the words the task list says. */
export const TASK_LIST_WORDS = TASK_WORDS;
export const NEW_TASK_ICON = Plus;
