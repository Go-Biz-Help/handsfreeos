import {
  assigneeShort,
  checkRich,
  COMPOSER_WORDS,
  CONTACT_EDIT_WORDS,
  CONVERSATION_ACTIONS,
  CONVERSATION_DONE,
  crossChannelCanText,
  emailNote,
  emailSubjectOf,
  handlingView,
  handoverNote,
  joinName,
  nameProblem,
  PENDING_REPLY_WORDS,
  replySubject,
  rowName,
  SENT_WORDS,
  splitName,
  switchRefusal,
  textNote,
  THREAD_WORDS,
  threadChannelLine,
  whoOf,
  type ComposerNote,
  type RichDraft,
  type StageRef,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AskSheet,
  QuietHoursSheet,
  StillSendSheet,
  type Decided,
} from '@/components/changes/decide-sheets';
import {
  DraftCard,
  useDraftDecision,
  useWaitingDrafts,
  type WaitingDraft,
} from '@/components/drafts';
import { Ellipsis, Phone } from '@/components/icons';
import { Composer, type ComposerMode } from '@/components/inbox/composer';
import { useKeyboardHeight } from '@/components/inbox/keyboard';
import {
  ActionsSheet,
  AddPersonSheet,
  AssignSheet,
  HandBackSheet,
  HandlingBanner,
  NextActionSheet,
  NoteCard,
  NoteSheet,
  NOTE_WORDS,
  SnoozeSheet,
  StatusBanner,
} from '@/components/inbox/conversation-parts';
import { PendingReplyBubble } from '@/components/inbox/pending-reply';
import { CallCard, DayDivider, EmailCard, MessageBubble } from '@/components/inbox/thread-items';
import { BrandMark } from '@/components/shell/brand';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { change, changes, newId } from '@/changes';
import { describe, loadNames } from '@/changes/describe';
import type { OutboxRow } from '@/changes/outbox';
import { EditSheet, RECORD_SHEET_WORDS, TagSheet } from '@/components/customers/sheets';
import { MoveSheet } from '@/components/pipeline/bits';
import { savePerson, saveTags, type PersonEdit } from '@/customers/actions';
import { useNames } from '@/customers/names';
import { TAGS_SQL } from '@/customers/queries';
import { moveLead, setNextAction } from '@/pipeline/actions';
import { useStagesOf } from '@/pipeline/use-pipeline';
import { conversationActions } from '@/inbox/actions';
import { startCall } from '@/inbox/calls';
import { inputOf, type PendingReply } from '@/inbox/outbox';
import { dropReplyPhoto, sendReply, takeReplyPhoto, type TrayPhoto } from '@/inbox/send';
import { threadEntries, type ThreadEntry } from '@/inbox/thread-entries';
import { useConversation, useThread } from '@/inbox/use-conversation';
import { useEmailFacts } from '@/inbox/use-email';
import { useMembers, useNow } from '@/inbox/use-inbox';
import { useNetwork } from '@/lib/network';

type Row =
  ThreadEntry | { readonly kind: 'draft'; readonly key: string; readonly waiting: WaitingDraft };

/**
 * One conversation (the Inbox canvas's thread): who it's with and on which channel, who handles it, its texts, emails,
 * calls, voicemails and notes, the replies written here that haven't come back yet with when they go, the AI teammate's
 * draft waiting for an OK, and the composer. Everything reads from the phone's copy and works with no signal, but Call.
 */
export default function Conversation() {
  const params = useLocalSearchParams<{ conversationId: string; edit?: string; draft?: string }>();
  const conversationId = params.conversationId;
  const { business, me, userId } = useBusiness();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { online } = useNetwork();
  const { data, loading } = useConversation(conversationId);
  const c = data?.conversation ?? null;
  const person = data?.person ?? null;
  const thread = useThread(conversationId, c?.person?.id ?? null);
  const drafts = useWaitingDrafts({ conversationId, kind: 'reply' });
  const members = useMembers();
  const names = useNames();
  const now = useNow();
  const myUserId = me.user.id;
  const { data: tagRows } = useQuery<{ id: string; name: string; color: string }>(TAGS_SQL, [
    business.id,
  ]);
  /** The open lead beside this customer, and its pipeline's stages, so it can be moved from here. */
  const lead = data?.conversation.openLead ?? null;
  /**
   * The open stages only: Won and Lost want a reason and the sheet that asks for one lives on the lead's page,
   * so from a conversation the lead moves along and is closed out there.
   */
  const stages = useStagesOf(lead?.pipelineId ?? null).filter((s) => s.kind === 'open');
  const personTags = names.tags(data?.person?.id ?? '');
  const actions = React.useMemo(
    () => conversationActions({ workspaceId: business.id, conversationId, myUserId }),
    [business.id, conversationId, myUserId],
  );

  // Composer.
  const [mode, setMode] = React.useState<ComposerMode | null>(null);
  const [body, setBody] = React.useState('');
  const [subject, setSubject] = React.useState('');
  const [photos, setPhotos] = React.useState<TrayPhoto[]>([]);
  // A text's buttons, card or carousel (RCS, 0103), and the pictures taken for a carousel's cards, by card.
  const [rich, setRich] = React.useState<RichDraft | null>(null);
  const [cardPhotos, setCardPhotos] = React.useState<Readonly<Record<string, TrayPhoto>>>({});
  const [sending, setSending] = React.useState(false);
  const [boxKey, setBoxKey] = React.useState(0);
  const [editing, setEditing] = React.useState<OutboxRow | null>(null);
  const sentHere = React.useRef(new Set<string>());
  const asked = React.useRef(new Set<string>());

  // Sheets.
  const [sheet, setSheet] = React.useState<
    | 'actions'
    | 'assign'
    | 'snooze'
    | 'note'
    | 'hand-back'
    | 'edit-person'
    | 'tags'
    | 'stage'
    | 'next-action'
    | 'add-person'
    | null
  >(null);
  const [busy, setBusy] = React.useState<'take' | 'back' | null>(null);
  const [deciding, setDeciding] = React.useState<{
    kind: 'still-send' | 'quiet-hours' | 'ask';
    decided: Decided;
  } | null>(null);

  const channel = c?.channel ?? 'sms';
  const current: ComposerMode = mode ?? channel;
  // Buttons go with a text, as on the web; a waiting reply being edited keeps what it had.
  const canRich = current === 'sms' && !editing;
  const richCheck = rich && canRich ? checkRich(rich, body, photos.length) : null;
  const first = data?.first ?? null;
  const who = whoOf(first, channel);
  const phoneDisplay = person?.phone ?? (channel === 'sms' ? (c?.counterpartDisplay ?? '') : '');
  const emailTo = channel === 'email' ? (c?.counterpart ?? null) : (person?.email ?? null);
  const email = useEmailFacts(conversationId, current === 'email' ? emailTo : null);

  // Opening a conversation reads it, as on the web.
  const readOnce = React.useRef(false);
  React.useEffect(() => {
    if (!c || readOnce.current) return;
    readOnce.current = true;
    if (c.unreadCount > 0) void actions.markRead();
  }, [c, actions]);

  // Edit, from "Still send?" or the quiet-hours question (here or on Changes on this phone): the words back in the box.
  const { data: editRows } = useQuery<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [
    params.edit ?? '',
  ]);
  const editFrom = editRows[0];
  React.useEffect(() => {
    if (editFrom) startEdit(editFrom);
    // Only when the address names a change.
  }, [editFrom?.id]);

  // A draft the Assistant wrote, opened here with Edit (M10 step 17): the words go in the box, to send or change.
  const draftOnce = React.useRef(false);
  React.useEffect(() => {
    if (draftOnce.current || !params.draft) return;
    draftOnce.current = true;
    setBody(params.draft);
  }, [params.draft]);

  function startEdit(row: OutboxRow) {
    const input = inputOf(row);
    setEditing(row);
    setBody(typeof input.body === 'string' ? input.body : '');
    setSubject(typeof input.subject === 'string' ? input.subject : '');
    if (input.channel === 'email' || input.channel === 'sms' || input.channel === 'chat')
      setMode(input.channel);
  }

  // A reply sent from this screen that asks (quiet hours, Still send?) asks here at once.
  React.useEffect(() => {
    for (const reply of thread.pending) {
      if (!sentHere.current.has(reply.row.id) || asked.current.has(reply.row.id)) continue;
      if (reply.stage === 'quiet-hours' || reply.stage === 'still-send' || reply.stage === 'ask') {
        asked.current.add(reply.row.id);
        void openDecision(reply);
      }
    }
  }, [thread.pending]);

  async function openDecision(reply: PendingReply) {
    const open = changes.open;
    if (!open) return;
    const row = (await open.outbox.get(reply.row.id)) ?? reply.row;
    const names = await loadNames(open.db, [row]);
    const kind =
      reply.stage === 'quiet-hours'
        ? 'quiet-hours'
        : reply.stage === 'still-send'
          ? 'still-send'
          : 'ask';
    setDeciding({ kind, decided: { row, words: describe(row, names) } });
  }

  const entries = React.useMemo<Row[]>(() => {
    const list: Row[] = threadEntries(thread.items, thread.notes, thread.pending, new Date(now));
    for (const waiting of drafts.visible)
      list.push({ kind: 'draft', key: `draft-${waiting.draft.id}`, waiting });
    return list.reverse();
  }, [thread, drafts.visible, now]);

  if (!c || !data) {
    return (
      <Screen
        title={loading ? '' : 'Conversation'}
        leading="back"
        back={businessHref(business.id, 'inbox')}
        testID="conversation"
      >
        {loading ? null : (
          <Text className="px-2 py-8 text-center text-text-2" testID="conversation-missing">
            This conversation isn’t on this phone.
          </Text>
        )}
      </Screen>
    );
  }

  const view = handlingView(c);
  const teammateName = data.teammate?.name ?? c.teammate?.name ?? 'The AI teammate';
  const lastEmailSubject =
    [...thread.items].reverse().find((i) => i.channel === 'email' && i.subject)?.subject ?? null;
  const sameChannel = current === channel;
  const modes: readonly ('sms' | 'email')[] | null = channel === 'chat' ? null : ['sms', 'email'];

  // What the box says when this channel can't be used.
  let note: ComposerNote | null = null;
  if (current === 'sms') {
    const can = sameChannel
      ? data.canText
      : crossChannelCanText(channel, data.canText, person?.phone ?? '', data.fromNumber);
    note = textNote(can.reason, { firstName: first, offerEmail: false });
  } else if (current === 'email') {
    if (!emailTo)
      note = emailNote(
        { ok: false, reason: 'no_email' },
        { to: null, suppressedReason: null, firstName: first },
      );
    else if (email.suppressedReason)
      note = emailNote(
        { ok: false, reason: 'suppressed' },
        { to: emailTo, suppressedReason: email.suppressedReason, firstName: first },
      );
  }
  const off = note !== null;
  const canCall = channel === 'sms' || !!person?.phoneE164;
  const callTarget = channel === 'sms' ? { conversationId } : { personId: person?.id ?? '' };

  const switchMode = (next: 'sms' | 'email') => {
    if (next === current) return;
    if (next === 'email' && !emailTo) {
      toast.error(switchRefusal('email', { personId: person?.id ?? null, firstName: first }));
      return;
    }
    if (next === 'sms' && channel !== 'sms' && !person?.phone) {
      toast.error(switchRefusal('sms', { personId: person?.id ?? null, firstName: first }));
      return;
    }
    setMode(next);
  };

  const addPhoto = async (source: 'camera' | 'library') => {
    if (!person) {
      toast.error(COMPOSER_WORDS.addCustomerForPhotos);
      return;
    }
    try {
      const taken = await takeReplyPhoto(userId, source);
      if (taken.kind === 'kept') setPhotos((p) => [...p, taken.photo]);
      else if (taken.kind === 'no-camera-permission')
        toast.error('Allow HandsFreeOS to use the camera in Settings to take photos.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  /** A new draft, or none: the pictures of any card it no longer has go from the phone. */
  const changeRich = (next: RichDraft | null) => {
    const kept = new Set(next?.cards.map((card) => card.key) ?? []);
    const gone = Object.entries(cardPhotos).filter(([key]) => !kept.has(key));
    for (const [, photo] of gone) dropReplyPhoto(userId, photo);
    if (gone.length > 0)
      setCardPhotos((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key]) => kept.has(key))),
      );
    setRich(next);
  };

  /** A carousel card's picture: taken like a reply's photo and kept on the phone until the text goes. */
  const addCardPhoto = async (cardKey: string, source: 'camera' | 'library') => {
    if (!person) {
      toast.error(COMPOSER_WORDS.addCustomerForPhotos);
      return;
    }
    try {
      const taken = await takeReplyPhoto(userId, source);
      if (taken.kind === 'kept') {
        const replaced = cardPhotos[cardKey];
        if (replaced) dropReplyPhoto(userId, replaced);
        setCardPhotos((prev) => ({ ...prev, [cardKey]: taken.photo }));
        setRich((draft) =>
          draft
            ? {
                ...draft,
                cards: draft.cards.map((card) =>
                  card.key === cardKey
                    ? { ...card, fileId: taken.photo.fileId, preview: taken.photo.localName }
                    : card,
                ),
              }
            : draft,
        );
      } else if (taken.kind === 'no-camera-permission')
        toast.error('Allow HandsFreeOS to use the camera in Settings to take photos.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    // The draft's first problem, before anything goes (as on the web).
    if (richCheck && !richCheck.ok) {
      toast.error(richCheck.error);
      return;
    }
    setSending(true);
    try {
      if (editing) {
        const input = inputOf(editing);
        await changes.fix(editing.id, {
          ...input,
          body: text,
          ...(input.channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}),
        });
        sentHere.current.add(editing.id);
        asked.current.delete(editing.id);
        setEditing(null);
        setBody('');
        return;
      }
      const subjectLine =
        current === 'email'
          ? sameChannel
            ? (replySubject(lastEmailSubject) ??
              emailSubjectOf(subject, { businessName: business.name }))
            : emailSubjectOf(subject, { businessName: business.name })
          : null;
      const extras = richCheck?.ok ? richCheck.value : null;
      const carousel = extras?.kind === 'carousel';
      const result = await sendReply({
        workspaceId: business.id,
        conversationId: sameChannel ? conversationId : null,
        personId: person?.id ?? null,
        channel: current,
        body: text,
        subject: subjectLine,
        photos,
        quiet: null,
        emailAddressId: current === 'email' ? email.fromAddressId : null,
        rich: extras,
        cardPhotos: carousel
          ? (rich?.cards ?? []).flatMap((card) => {
              const photo = cardPhotos[card.key];
              return photo ? [photo] : [];
            })
          : [],
      });
      sentHere.current.add(result.id);
      setBody('');
      setBoxKey((k) => k + 1);
      setSubject('');
      setPhotos([]);
      if (extras) {
        // A carousel's pictures went with it; any taken for cards of a draft that became something else go.
        if (!carousel) for (const photo of Object.values(cardPhotos)) dropReplyPhoto(userId, photo);
        setCardPhotos({});
        setRich(null);
      }
      if (!sameChannel)
        toast.show(
          current === 'email'
            ? SENT_WORDS.emailElsewhere(emailTo ?? '')
            : SENT_WORDS.textElsewhere(person?.phone ?? ''),
        );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const takeOver = async () => {
    setBusy('take');
    await actions.takeOver(teammateName);
    setBusy(null);
  };
  const handBack = async () => {
    setBusy('back');
    await actions.handBack(teammateName, who);
    setBusy(null);
  };

  /**
   * Changing the customer from inside their conversation, the web's panel's other half. Every one goes through
   * `change()`, so it works with no signal and waits in the queue like everything else here.
   */
  const opened: PersonEdit | null = person
    ? {
        firstName: person.firstName,
        lastName: person.lastName,
        phone: person.phone ?? '',
        email: person.email ?? '',
        notes: person.notes,
        line1: person.line1,
        city: person.city,
        state: person.state,
        postalCode: person.postalCode,
      }
    : null;

  const editPerson = async (values: Readonly<Record<string, string>>) => {
    if (!person || !opened) return;
    const saved = await savePerson(business.id, person.id, opened, {
      ...opened,
      ...(values as unknown as PersonEdit),
    });
    toast.show(saved.changed ? RECORD_SHEET_WORDS.edit.saved : RECORD_SHEET_WORDS.edit.nothing);
  };

  const editTags = async (ids: readonly string[]) => {
    if (!person) return;
    await saveTags(
      { workspaceId: business.id, recordType: 'person', recordId: person.id },
      personTags,
      ids,
    );
  };

  const moveStage = async (stage: StageRef) => {
    if (!lead) return;
    await moveLead(business.id, lead, stage);
    toast.show(CONTACT_EDIT_WORDS.moved(stage.name));
  };

  const saveNextAction = async (text: string) => {
    if (!lead) return;
    await setNextAction(business.id, lead.id, text, null);
  };

  /**
   * Naming a number nobody has linked: the customer is made with the number on them, then the conversation is
   * linked to them, so this thread and any calls land on their timeline.
   */
  const addPerson = async (name: string): Promise<boolean> => {
    const problem = nameProblem(name);
    if (problem) {
      toast.error(problem);
      return false;
    }
    try {
      const parts = splitName(name);
      const personId = newId();
      await change(
        'person.create',
        {
          workspaceId: business.id,
          id: personId,
          ...parts,
          ...(c?.channel === 'sms' ? { phone: c.counterpart } : {}),
          ...(c?.channel === 'email' ? { email: c.counterpart } : {}),
        } as never,
        {
          optimistic: (tx) =>
            tx.execute(
              `INSERT INTO people (id, workspace_id, first_name, last_name, phone, phone_e164, email,
                 created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                personId,
                business.id,
                parts.firstName,
                parts.lastName,
                c?.channel === 'sms' ? c.counterpart : null,
                c?.channel === 'sms' ? c.counterpart : null,
                c?.channel === 'email' ? c.counterpart : null,
                new Date().toISOString(),
                new Date().toISOString(),
              ],
            ),
        },
      );
      await change(
        'conversation.link_person',
        { workspaceId: business.id, conversationId, personId } as never,
        {
          optimistic: (tx) =>
            tx.execute('UPDATE conversations SET person_id = ? WHERE id = ?', [
              personId,
              conversationId,
            ]),
        },
      );
      toast.show(CONTACT_EDIT_WORDS.added(joinName(parts)));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const addNote = async (text: string): Promise<boolean> => {
    if (!person) return false;
    try {
      const id = newId();
      const at = new Date().toISOString();
      await change(
        'activity.log',
        { workspaceId: business.id, id, kind: 'note', body: text, personId: person.id },
        {
          optimistic: (tx) =>
            tx.execute(
              `INSERT INTO activities (id, workspace_id, kind, person_id, body, occurred_at, author_user_id, actor_type,
                 created_at, updated_at) VALUES (?, ?, 'note', ?, ?, ?, ?, 'user', ?, ?)`,
              [id, business.id, person.id, text, at, myUserId, at, at],
            ),
        },
      );
      toast.show(NOTE_WORDS.added);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const backToList = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(business.id, 'inbox') as Href);
  };

  const renderRow = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case 'day':
        return <DayDivider label={item.label} />;
      case 'note':
        return <NoteCard note={item.note} />;
      case 'pending':
        return (
          <PendingReplyBubble
            reply={item.reply}
            userId={userId}
            who={who}
            onAction={(reply) => {
              if (reply.stage === 'refused') startEdit(reply.row);
              else void openDecision(reply);
            }}
            onDiscard={(reply) =>
              void changes
                .discard([reply.row.id])
                .then(() => toast.show(PENDING_REPLY_WORDS.discarded))
            }
          />
        );
      case 'draft':
        return <ThreadDraft waiting={item.waiting} who={who} timeZone={data.timeZone} now={now} />;
      case 'item': {
        const i = item.item;
        if (i.type === 'call') return <CallCard item={i} workspaceId={business.id} />;
        if (i.channel === 'email')
          return <EmailCard item={i} customerName={person?.fullName ?? null} />;
        return (
          <MessageBubble
            item={i}
            customerFirstName={first}
            onCancelHeld={(messageId) => void actions.cancelHeld(messageId)}
          />
        );
      }
    }
  };

  const decidedFor = (kind: 'still-send' | 'quiet-hours' | 'ask') =>
    deciding?.kind === kind ? deciding.decided : null;
  const closeDecision = () => setDeciding(null);
  const discardDecided = (decided: Decided) => {
    closeDecision();
    void changes.discard([decided.row.id]).then(() => toast.show(PENDING_REPLY_WORDS.discarded));
  };

  return (
    <Screen
      title={rowName(c)}
      subtitle={threadChannelLine(c, person)}
      leading="back"
      back={businessHref(business.id, 'inbox')}
      ask={false}
      scroll={false}
      testID="conversation"
      trailing={
        <View className="flex-row items-center">
          {canCall ? (
            <HeaderButton
              label={CONVERSATION_ACTIONS.call}
              onPress={() => startCall(callTarget)}
              testID="thread-call"
            >
              <Icon as={Phone} className="size-[21px] text-text-2" />
            </HeaderButton>
          ) : null}
          <HeaderButton
            label="Ask HandsFreeOS"
            onPress={() => router.push(businessHref(business.id, 'ask'))}
            testID="ask-handsfreeos"
          >
            <BrandMark size={24} />
          </HeaderButton>
          <HeaderButton
            label={CONVERSATION_ACTIONS.details}
            onPress={() => setSheet('actions')}
            testID="thread-details"
          >
            <Icon as={Ellipsis} className="size-[22px] text-text-2" />
          </HeaderButton>
        </View>
      }
    >
      <View
        className="flex-1"
        style={
          keyboard
            ? { paddingBottom: keyboard + (Platform.OS === 'android' ? insets.bottom : 0) }
            : undefined
        }
      >
        <HandlingBanner
          view={view}
          c={c}
          teammateName={teammateName}
          teammateStatus={data.teammate?.status ?? null}
          myUserId={myUserId}
          timeZone={data.timeZone}
          busy={busy}
          onTakeOver={() => void takeOver()}
          onHandBack={() => setSheet('hand-back')}
        />
        <StatusBanner
          c={c}
          who={who}
          timeZone={data.timeZone}
          onReopen={() => void actions.reopen()}
        />
        <FlatList
          data={entries}
          inverted
          keyExtractor={(row) => row.key}
          renderItem={renderRow}
          className="flex-1"
          contentContainerClassName="px-3.5 pb-2 pt-3"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          initialNumToRender={16}
          windowSize={9}
          testID="thread"
          ListEmptyComponent={
            <View
              className="flex-1 items-center justify-center px-6 py-10"
              style={{ transform: [{ scaleY: -1 }] }}
            >
              <Text className="text-center text-text-3">{THREAD_WORDS.empty}</Text>
            </View>
          }
        />
        <View style={{ paddingBottom: keyboard ? 0 : insets.bottom }} className="bg-card">
          <Composer
            userId={userId}
            mode={current}
            modes={modes}
            onMode={switchMode}
            body={body}
            onBody={setBody}
            subject={subject}
            onSubject={setSubject}
            showSubject={current === 'email' && !sameChannel}
            photos={photos}
            onAddPhoto={(source) => void addPhoto(source)}
            onRemovePhoto={(photo) => {
              dropReplyPhoto(userId, photo);
              setPhotos((p) => p.filter((x) => x.fileId !== photo.fileId));
            }}
            canPhoto={current !== 'chat' && !!person && !editing}
            note={note}
            off={off}
            first={first}
            phoneDisplay={phoneDisplay}
            fromNumber={data.fromNumber}
            fromEmail={email.fromAddress}
            elsewhere={sameChannel ? null : current === 'email' ? emailTo : (person?.phone ?? null)}
            handover={sameChannel ? handoverNote(view, teammateName) : null}
            online={online}
            editing={!!editing}
            onCancelEdit={() => {
              setEditing(null);
              setBody('');
            }}
            busy={sending}
            onSend={() => void send()}
            boxKey={boxKey}
            rich={rich}
            onRich={changeRich}
            richCheck={richCheck}
            canRich={canRich}
            canCarousel={!!person}
            onCardPhoto={(key, source) => void addCardPhoto(key, source)}
          />
        </View>
      </View>

      <ActionsSheet
        open={sheet === 'actions'}
        onClose={() => setSheet(null)}
        c={c}
        canCall={canCall}
        canHandToAi={!!data.teammate && c.handledBy !== 'ai' && channel !== 'email'}
        teammateName={teammateName}
        assigneeShort={assigneeShort(c.assignee, myUserId)}
        onCall={() => startCall(callTarget)}
        onAssign={() => setSheet('assign')}
        onHandToAi={() => setSheet('hand-back')}
        onSnooze={() => setSheet('snooze')}
        onCloseConversation={() =>
          void actions.close(CONVERSATION_DONE.closed(who)).then((ok) => ok && backToList())
        }
        onReopen={() => void actions.reopen()}
        onMarkUnread={() => void actions.markUnread().then((ok) => ok && backToList())}
        onNote={person ? () => setSheet('note') : null}
        onEditPerson={person ? () => setSheet('edit-person') : null}
        onTags={person ? () => setSheet('tags') : null}
        onStage={lead && stages.length > 1 ? () => setSheet('stage') : null}
        onNextAction={lead ? () => setSheet('next-action') : null}
        onAddPerson={person ? null : () => setSheet('add-person')}
        stageName={lead?.stageName ?? null}
      />
      <AssignSheet
        open={sheet === 'assign'}
        onClose={() => setSheet(null)}
        members={members}
        current={c.assignee?.id ?? null}
        myUserId={myUserId}
        onPick={(m) => void actions.assign(m?.id ?? null, m?.fullName)}
      />
      <SnoozeSheet
        open={sheet === 'snooze'}
        onClose={() => setSheet(null)}
        timeZone={data.timeZone}
        onPick={(o) =>
          void actions
            .snooze(o.until, CONVERSATION_DONE.snoozed(o.when))
            .then((ok) => ok && backToList())
        }
      />
      <NoteSheet
        open={sheet === 'note'}
        onClose={() => setSheet(null)}
        first={first ?? who}
        onSave={addNote}
      />
      {opened ? (
        <EditSheet
          open={sheet === 'edit-person'}
          onClose={() => setSheet(null)}
          fields={[
            { key: 'firstName', label: 'First name', value: opened.firstName },
            { key: 'lastName', label: 'Last name', value: opened.lastName },
            { key: 'phone', label: 'Mobile', value: opened.phone, keyboard: 'phone-pad' },
            { key: 'email', label: 'Email', value: opened.email, keyboard: 'email-address' },
            { key: 'line1', label: 'Street', value: opened.line1 },
            { key: 'city', label: 'City', value: opened.city },
            { key: 'state', label: 'State', value: opened.state },
            { key: 'postalCode', label: 'ZIP', value: opened.postalCode },
            { key: 'notes', label: 'Notes', value: opened.notes, multiline: true },
          ]}
          onSave={editPerson}
        />
      ) : null}
      <TagSheet
        open={sheet === 'tags'}
        tags={tagRows}
        chosen={personTags}
        onClose={() => setSheet(null)}
        onSave={editTags}
      />
      <MoveSheet
        open={sheet === 'stage'}
        lead={
          lead
            ? {
                title: lead.title,
                stageId: lead.stageId,
                valueCents: lead.valueCents,
                person: person
                  ? { id: person.id, fullName: person.fullName, archived: person.archived }
                  : null,
                company: null,
              }
            : null
        }
        stages={stages}
        pipelineName=""
        onClose={() => setSheet(null)}
        onMove={(stage) => {
          setSheet(null);
          void moveStage(stage);
        }}
      />
      <NextActionSheet
        open={sheet === 'next-action'}
        onClose={() => setSheet(null)}
        lead={lead}
        onSave={saveNextAction}
      />
      <AddPersonSheet
        open={sheet === 'add-person'}
        onClose={() => setSheet(null)}
        counterpart={c.counterpartDisplay}
        onSave={addPerson}
      />
      <HandBackSheet
        open={sheet === 'hand-back'}
        onClose={() => setSheet(null)}
        teammateName={teammateName}
        who={who}
        onConfirm={() => void handBack()}
      />
      <StillSendSheet
        decided={decidedFor('still-send')}
        onClose={closeDecision}
        onEdit={startEdit}
        onDiscard={discardDecided}
      />
      <QuietHoursSheet
        decided={decidedFor('quiet-hours')}
        onClose={closeDecision}
        onEdit={startEdit}
      />
      <AskSheet
        decided={decidedFor('ask')}
        onClose={closeDecision}
        onEdit={startEdit}
        onDiscard={discardDecided}
      />
    </Screen>
  );
}

function HeaderButton({
  label,
  onPress,
  testID,
  children,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      className="size-11 items-center justify-center rounded-full active:bg-card-2"
    >
      {children}
    </Pressable>
  );
}

/** The AI teammate's reply waiting for an OK, after the newest message. */
function ThreadDraft({
  waiting,
  who,
  timeZone,
  now,
}: {
  waiting: WaitingDraft;
  who: string;
  timeZone: string;
  now: number;
}) {
  const { business } = useBusiness();
  const d = useDraftDecision({ workspaceId: business.id, draft: waiting.draft, who });
  return (
    <View className="mt-3">
      <DraftCard d={d} timeZone={timeZone} now={now} testID="thread-draft" />
    </View>
  );
}
