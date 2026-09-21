import {
  closedBanner,
  clockTime,
  CONTACT_EDIT_WORDS,
  CONVERSATION_ACTIONS,
  handBackQuestion,
  handedLine,
  handlingHow,
  handlingTitle,
  handoffWhy,
  memberLabel,
  NEEDS_A_PERSON,
  notCustomerBanner,
  snoozedBanner,
  snoozeOptions,
  whoTookOver,
  type ConversationShape,
  type HandlingView,
  type SnoozeOption,
  type TeammateStatus,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { RECORD_SHEET_WORDS } from '@/components/customers/sheets';
import { useAiColors } from '@/components/drafts';
import {
  AlarmClock,
  ArrowRight,
  Check,
  ChevronRight,
  CircleCheck,
  Clock,
  MailOpen,
  Phone,
  Sparkles,
  StickyNote,
  Tag,
  Undo2,
  UserPen,
  UserPlus,
  UserRound,
  Users,
  X,
} from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import type { NoteEntry } from '@/inbox/thread-entries';
import { useColors } from '@/theme';

import { Words } from './composer';

type UserRef = { readonly id: string; readonly fullName: string };

/**
 * Who handles the conversation, under its top bar: "Ava is handling this. Each reply waits for an OK." with Take over;
 * "You took over" with Hand back; "Needs a person" with the teammate's reason and Take it.
 */
export function HandlingBanner({
  view,
  c,
  teammateName,
  teammateStatus,
  myUserId,
  timeZone,
  busy,
  onTakeOver,
  onHandBack,
}: {
  view: HandlingView;
  c: ConversationShape;
  teammateName: string;
  teammateStatus: TeammateStatus | null;
  myUserId: string;
  timeZone: string;
  busy: 'take' | 'back' | null;
  onTakeOver: () => void;
  onHandBack: () => void;
}) {
  const ai = useAiColors();
  if (view === 'ai')
    return (
      <View
        role="alert"
        className="mx-3 mt-2.5 flex-row items-center gap-2.5 rounded-menu py-2 pl-3 pr-2"
        style={{ backgroundColor: ai.soft }}
        testID="handling-ai"
      >
        <Sparkles size={16} color={ai.text} strokeWidth={1.5} />
        <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px]" style={{ color: ai.text }}>
          <Text className="text-[13.5px] font-semibold" style={{ color: ai.text }}>
            {`${handlingTitle(teammateName, 'phone')}.`}
          </Text>
          {` ${handlingHow(teammateStatus)}`}
        </Text>
        <Button
          variant="secondary"
          size="md"
          loading={busy === 'take'}
          onPress={onTakeOver}
          testID="take-over"
        >
          {CONVERSATION_ACTIONS.takeOver}
        </Button>
      </View>
    );
  if (view === 'person')
    return (
      <View
        role="alert"
        className="mx-3 mt-2.5 flex-row items-center gap-2.5 rounded-menu bg-card-2 py-2 pl-3 pr-2"
        testID="handling-person"
      >
        <Icon as={UserRound} className="size-4 text-text-2" />
        <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">
          <Text className="text-[13.5px] font-semibold">
            {`${whoTookOver(c.takenOverBy, myUserId)} took over.`}
          </Text>
          {` ${teammateName} stays quiet until someone hands it back.`}
        </Text>
        <Button
          variant="secondary"
          size="md"
          loading={busy === 'back'}
          onPress={onHandBack}
          testID="hand-back"
        >
          {CONVERSATION_ACTIONS.handBack}
        </Button>
      </View>
    );
  if (view === 'needs_person') {
    const why = handoffWhy(c.handoffReason, teammateName);
    return (
      <View
        role="alert"
        className="mx-3 mt-2.5 flex-row items-start gap-2.5 rounded-menu bg-warning-soft py-2.5 pl-3 pr-2"
        testID="handling-needs-person"
      >
        <Icon as={UserRound} className="mt-0.5 size-4 text-warning-text" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[13.5px] leading-[19px] text-warning-text">
            <Text className="text-[13.5px] font-semibold text-warning-text">{`${NEEDS_A_PERSON}.`}</Text>
            {` ${handedLine(teammateName, c.assignee, myUserId, c.needsPersonSince, timeZone)}`}
          </Text>
          {why ? (
            <Text className="text-xs text-warning-text" testID="handoff-why">{`Why: ${why}.`}</Text>
          ) : null}
          {c.handoffNote ? (
            <Text className="text-xs text-text" testID="handoff-note">
              {`${teammateName}’s note: “${c.handoffNote}”`}
            </Text>
          ) : null}
        </View>
        <Button
          variant="secondary"
          size="md"
          loading={busy === 'take'}
          onPress={onTakeOver}
          testID="take-it"
        >
          {CONVERSATION_ACTIONS.takeIt}
        </Button>
      </View>
    );
  }
  return null;
}

/** Not a customer yet, snoozed, or closed, with its one action. */
export function StatusBanner({
  c,
  who,
  timeZone,
  onReopen,
}: {
  c: ConversationShape;
  who: string;
  timeZone: string;
  onReopen: () => void;
}) {
  if (c.status === 'snoozed' && c.snoozedUntil) {
    const b = snoozedBanner(c.snoozedUntil, who, timeZone);
    return (
      <Strip testID="snoozed-banner" action={b.action} onAction={onReopen}>
        <Words parts={b.parts} className="text-[13.5px] leading-[19px] text-text-2" />
      </Strip>
    );
  }
  if (c.status === 'closed') {
    const b = closedBanner(who);
    return (
      <Strip testID="closed-banner" action={b.action} onAction={onReopen}>
        <Text className="text-[13.5px] leading-[19px] text-text-2">{b.text}</Text>
      </Strip>
    );
  }
  if (!c.person && c.channel !== 'chat') {
    const b = notCustomerBanner(c.counterpartDisplay, c.channel);
    return (
      <Strip testID="not-customer-banner">
        <Words parts={b.parts} className="text-[13.5px] leading-[19px] text-text-2" />
      </Strip>
    );
  }
  return null;
}

function Strip({
  children,
  action,
  onAction,
  testID,
}: {
  children: React.ReactNode;
  action?: string;
  onAction?: () => void;
  testID: string;
}) {
  return (
    <View
      className="mx-3 mt-2.5 min-h-11 flex-row items-center gap-2 rounded-menu bg-card-2 py-1.5 pl-3 pr-1.5"
      testID={testID}
    >
      <View className="min-w-0 flex-1">{children}</View>
      {action && onAction ? (
        <Button variant="secondary" size="md" onPress={onAction} testID={`${testID}-action`}>
          {action}
        </Button>
      ) : null}
    </View>
  );
}

/** A note about the customer, in the thread. */
export function NoteCard({ note }: { note: NoteEntry }) {
  return (
    <View
      className="mt-2 w-full gap-1 self-start rounded-[14px] border border-border bg-warning-soft px-3.5 py-2.5"
      testID={`note-${note.id}`}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon as={StickyNote} className="size-3.5 text-warning-text" />
        <Text className="text-xs font-medium text-warning-text">
          {`Note${note.author ? ` · ${note.author}` : ''} · ${clockTime(note.occurredAt)}`}
        </Text>
      </View>
      <Text selectable className="text-[14.5px] leading-[21px]">
        {note.body}
      </Text>
    </View>
  );
}

function SheetRow({
  icon,
  label,
  detail,
  onPress,
  testID,
  tint,
}: {
  icon: LucideIcon | React.ReactNode;
  label: string;
  detail?: string | null;
  onPress: () => void;
  testID?: string;
  tint?: string;
}) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      testID={testID}
      className="min-h-12 flex-row items-center gap-3 rounded-menu px-2 active:bg-card-2"
    >
      {typeof icon === 'function' || (typeof icon === 'object' && icon && 'render' in icon) ? (
        <Icon as={icon as LucideIcon} className="size-5 text-text-2" />
      ) : (
        (icon as React.ReactNode)
      )}
      <Text className="min-w-0 flex-1 text-[15px]" style={tint ? { color: tint } : undefined}>
        {label}
      </Text>
      {detail ? <Text className="text-[13px] text-text-3">{detail}</Text> : null}
      <Icon as={ChevronRight} className="size-4 text-text-3" />
    </Pressable>
  );
}

/**
 * Details and actions (the "…" in the top bar), as the web's sheet at phone width: Call, Assign, Hand to the teammate,
 * Snooze and Close (or Reopen), Mark as unread, and — since the web's panel learned to change the customer from
 * inside the conversation — Edit details, Tags, the open lead's stage and next action, and Add a note.
 *
 * A row is passed null when this conversation cannot do it: no customer yet, or no open lead to move.
 */
export function ActionsSheet({
  open,
  onClose,
  c,
  canCall,
  canHandToAi,
  teammateName,
  assigneeShort,
  onCall,
  onAssign,
  onHandToAi,
  onSnooze,
  onCloseConversation,
  onReopen,
  onMarkUnread,
  onNote,
  onEditPerson,
  onTags,
  onStage,
  onNextAction,
  onAddPerson,
  stageName,
}: {
  open: boolean;
  onClose: () => void;
  c: ConversationShape;
  canCall: boolean;
  canHandToAi: boolean;
  teammateName: string;
  assigneeShort: string | null;
  onCall: () => void;
  onAssign: () => void;
  onHandToAi: () => void;
  onSnooze: () => void;
  onCloseConversation: () => void;
  onReopen: () => void;
  onMarkUnread: () => void;
  onNote: (() => void) | null;
  onEditPerson: (() => void) | null;
  onTags: (() => void) | null;
  /** Null when this customer has no open lead to move. */
  onStage: (() => void) | null;
  onNextAction: (() => void) | null;
  /** Naming a number nobody has linked. Null once there is a customer. */
  onAddPerson: (() => void) | null;
  /** Where the open lead stands, shown beside its row the way the assignee is. */
  stageName: string | null;
}) {
  const ai = useAiColors();
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={CONVERSATION_ACTIONS.details}
      testID="conversation-actions"
    >
      <View className="mt-2 gap-0.5">
        {canCall ? (
          <SheetRow
            icon={Phone}
            label={CONVERSATION_ACTIONS.call}
            onPress={run(onCall)}
            testID="sheet-call"
          />
        ) : null}
        <SheetRow
          icon={Users}
          label={CONVERSATION_ACTIONS.assign}
          detail={assigneeShort ?? CONVERSATION_ACTIONS.nobody}
          onPress={run(onAssign)}
          testID="sheet-assign"
        />
        {canHandToAi ? (
          <SheetRow
            icon={<Sparkles size={20} color={ai.text} strokeWidth={1.5} />}
            label={CONVERSATION_ACTIONS.handTo(teammateName)}
            onPress={run(onHandToAi)}
            testID="sheet-hand-to-ai"
          />
        ) : null}
        {c.status === 'open' ? (
          <>
            <SheetRow
              icon={AlarmClock}
              label={CONVERSATION_ACTIONS.snooze}
              onPress={run(onSnooze)}
              testID="sheet-snooze"
            />
            <SheetRow
              icon={CircleCheck}
              label={CONVERSATION_ACTIONS.closeConversation}
              onPress={run(onCloseConversation)}
              testID="sheet-close"
            />
          </>
        ) : (
          <SheetRow
            icon={Undo2}
            label={CONVERSATION_ACTIONS.reopen}
            onPress={run(onReopen)}
            testID="sheet-reopen"
          />
        )}
        <SheetRow
          icon={MailOpen}
          label={CONVERSATION_ACTIONS.markUnread}
          onPress={run(onMarkUnread)}
          testID="sheet-mark-unread"
        />
        {onNote ? (
          <SheetRow
            icon={StickyNote}
            label={NOTE_WORDS.add}
            onPress={run(onNote)}
            testID="sheet-note"
          />
        ) : null}
        {onEditPerson ? (
          <SheetRow
            icon={UserPen}
            label={RECORD_SHEET_WORDS.edit.title}
            onPress={run(onEditPerson)}
            testID="sheet-edit-person"
          />
        ) : null}
        {onTags ? (
          <SheetRow
            icon={Tag}
            label={CONTACT_EDIT_WORDS.tags}
            onPress={run(onTags)}
            testID="sheet-tags"
          />
        ) : null}
        {onStage ? (
          <SheetRow
            icon={ArrowRight}
            label={CONTACT_EDIT_WORDS.stage}
            detail={stageName ?? undefined}
            onPress={run(onStage)}
            testID="sheet-stage"
          />
        ) : null}
        {onNextAction ? (
          <SheetRow
            icon={Clock}
            label={CONTACT_EDIT_WORDS.nextAction}
            onPress={run(onNextAction)}
            testID="sheet-next-action"
          />
        ) : null}
        {onAddPerson ? (
          <SheetRow
            icon={UserPlus}
            label={CONTACT_EDIT_WORDS.addTitle}
            onPress={run(onAddPerson)}
            testID="sheet-add-person"
          />
        ) : null}
      </View>
    </Sheet>
  );
}

export function AssignSheet({
  open,
  onClose,
  members,
  current,
  myUserId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  members: readonly UserRef[];
  current: string | null;
  myUserId: string;
  onPick: (member: UserRef | null) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={CONVERSATION_ACTIONS.assignTo}
      scroll
      testID="assign-sheet"
    >
      <View className="mt-2 gap-0.5">
        {members.map((m) => (
          <Pressable
            key={m.id}
            role="button"
            onPress={() => {
              onClose();
              onPick(m);
            }}
            className="min-h-12 flex-row items-center gap-3 rounded-menu px-2 active:bg-card-2"
            testID={`assign-${m.id}`}
          >
            <Avatar name={m.fullName || '?'} seed={m.id} size="sm" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-[15px]">
              {memberLabel(m, myUserId)}
            </Text>
            {current === m.id ? <Icon as={Check} className="size-[18px] text-accent-text" /> : null}
          </Pressable>
        ))}
        <Pressable
          role="button"
          onPress={() => {
            onClose();
            onPick(null);
          }}
          className="min-h-12 flex-row items-center gap-3 rounded-menu px-2 active:bg-card-2"
          testID="assign-nobody"
        >
          <Icon as={X} className="size-[18px] text-text-2" />
          <Text className="min-w-0 flex-1 text-[15px]">{CONVERSATION_ACTIONS.nobody}</Text>
          {current === null ? <Icon as={Check} className="size-[18px] text-accent-text" /> : null}
        </Pressable>
      </View>
    </Sheet>
  );
}

export function SnoozeSheet({
  open,
  onClose,
  timeZone,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  timeZone: string;
  onPick: (option: SnoozeOption) => void;
}) {
  const options = React.useMemo(() => (open ? snoozeOptions(timeZone) : []), [open, timeZone]);
  return (
    <Sheet open={open} onClose={onClose} title={CONVERSATION_ACTIONS.snooze} testID="snooze-sheet">
      <View className="mt-2 gap-0.5">
        {options.map((o) => (
          <Pressable
            key={o.key}
            role="button"
            onPress={() => {
              onClose();
              onPick(o);
            }}
            className="min-h-12 flex-row items-center gap-3 rounded-menu px-2 active:bg-card-2"
            testID={`snooze-${o.key}`}
          >
            <Icon as={AlarmClock} className="size-5 text-text-2" />
            <Text className="min-w-0 flex-1 text-[15px]">{o.label}</Text>
            <Text className="text-[13px] text-text-3">{o.when}</Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

export const NOTE_WORDS = {
  add: 'Add a note',
  title: (first: string) => `A note about ${first}`,
  placeholder: 'Only your team sees notes.',
  save: 'Add note',
  added: 'Note added.',
  write: 'Write something.',
} as const;

export function NoteSheet({
  open,
  onClose,
  first,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  first: string;
  onSave: (body: string) => Promise<boolean>;
}) {
  const colors = useColors();
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setBody('');
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={NOTE_WORDS.title(first)} testID="note-sheet">
      <TextInput
        value={body}
        onChangeText={setBody}
        multiline
        autoFocus
        placeholder={NOTE_WORDS.placeholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={NOTE_WORDS.title(first)}
        className="mt-3 min-h-[96px] rounded-menu border border-border-strong bg-card px-3.5 py-2.5 font-sans text-base text-text"
        textAlignVertical="top"
        testID="note-body"
      />
      <View className="mt-3 gap-2">
        <Button
          icon={StickyNote}
          loading={busy}
          disabled={!body.trim()}
          onPress={() => {
            setBusy(true);
            void onSave(body.trim())
              .then((ok) => ok && onClose())
              .finally(() => setBusy(false));
          }}
          testID="note-save"
        >
          {NOTE_WORDS.save}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * The open lead's next action, set from the conversation that prompted it — "call Monday with the price" is
 * decided while reading their text, not later on the lead's own page.
 */
export function NextActionSheet({
  open,
  onClose,
  lead,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  lead: { readonly title: string; readonly nextAction: string | null } | null;
  onSave: (text: string) => void | Promise<void>;
}) {
  const colors = useColors();
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setText(lead?.nextAction ?? '');
  }, [open, lead?.nextAction]);
  if (!lead) return null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={CONTACT_EDIT_WORDS.nextAction}
      description={lead.title}
      testID="next-action-sheet"
    >
      <TextInput
        value={text}
        onChangeText={setText}
        autoFocus
        placeholder={CONTACT_EDIT_WORDS.nextActionPlaceholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={CONTACT_EDIT_WORDS.nextAction}
        className="mt-3 min-h-12 rounded-menu border border-border-strong bg-card px-3.5 py-2.5 font-sans text-base text-text"
        testID="next-action-text"
      />
      <View className="mt-3">
        <Button
          icon={Clock}
          loading={busy}
          disabled={!text.trim()}
          onPress={() => {
            setBusy(true);
            void Promise.resolve(onSave(text.trim()))
              .then(() => onClose())
              .finally(() => setBusy(false));
          }}
          testID="next-action-save"
        >
          {CONTACT_EDIT_WORDS.nextActionSave}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * Naming a number nobody has linked, without leaving the thread.
 *
 * The number is already the conversation, so the only thing missing is who it belongs to. Everything else about
 * them is on their page once they exist.
 */
export function AddPersonSheet({
  open,
  onClose,
  counterpart,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  /** The number or address this conversation is with, shown so it is clear what gets attached. */
  counterpart: string;
  onSave: (name: string) => Promise<boolean>;
}) {
  const colors = useColors();
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setName('');
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={CONTACT_EDIT_WORDS.addTitle}
      description={counterpart}
      testID="add-person-sheet"
    >
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        placeholder={CONTACT_EDIT_WORDS.namePlaceholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={CONTACT_EDIT_WORDS.addTitle}
        className="mt-3 min-h-12 rounded-menu border border-border-strong bg-card px-3.5 py-2.5 font-sans text-base text-text"
        testID="add-person-name"
      />
      <View className="mt-3">
        <Button
          icon={UserPlus}
          loading={busy}
          disabled={!name.trim()}
          onPress={() => {
            setBusy(true);
            void onSave(name.trim())
              .then((ok) => ok && onClose())
              .finally(() => setBusy(false));
          }}
          testID="add-person-save"
        >
          {CONTACT_EDIT_WORDS.addSave}
        </Button>
      </View>
    </Sheet>
  );
}

/** "Hand Tom back to Ava?": handing back always asks first, as on the web. */
export function HandBackSheet({
  open,
  onClose,
  teammateName,
  who,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  teammateName: string;
  who: string;
  onConfirm: () => void;
}) {
  const ai = useAiColors();
  const q = handBackQuestion(teammateName, who);
  return (
    <Sheet open={open} onClose={onClose} testID="hand-back-sheet">
      <View className="flex-row items-start gap-3">
        <View
          className="size-10 items-center justify-center rounded-[10px]"
          style={{ backgroundColor: ai.soft }}
        >
          <Sparkles size={20} color={ai.text} strokeWidth={1.5} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="sheetTitle">{q.title}</Text>
          <Text className="text-sm leading-5 text-text-2">{q.body}</Text>
        </View>
      </View>
      <View className="mt-4 gap-2">
        <Button
          onPress={() => {
            onClose();
            onConfirm();
          }}
          testID="hand-back-confirm"
        >
          {CONVERSATION_ACTIONS.handBackTo(teammateName)}
        </Button>
        <Button variant="secondary" onPress={onClose} testID="hand-back-keep">
          {CONVERSATION_ACTIONS.keepIt}
        </Button>
      </View>
    </Sheet>
  );
}
