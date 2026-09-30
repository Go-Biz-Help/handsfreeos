import {
  DESK_WORDS,
  TICKET_CHANNEL_WORDS,
  TICKET_EVENT_WORDS,
  TICKET_PRIORITY_WORDS,
  TICKET_STATUS_WORDS,
  type TicketPriority,
  type TicketStatus,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { desk, useLive, type Ok } from '@/admin/live';
import { DESK_PHONE_WORDS } from '@/admin/words';
import { DeskWaiting, Line, PickSheet, Section } from '@/components/admin/bits';
import { deskHref, useDesk, useDeskCan } from '@/components/admin/staff-context';
import { Eye, Sparkles } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { FieldError } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type TicketFull = Ok<'/v1/queries/support.ticket.get'>;
type Message = TicketFull['messages'][number];
type StaffList = Ok<'/v1/queries/support.staff.list'>;
type SavedReply = Ok<'/v1/queries/support.canned_reply.list'>['replies'][number];

/** A full date and time, in the reader's own zone. */
const whenWords = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * One ticket (the web's /admin/tickets/<id>): the conversation, the AI's suggested answer when there is one, and what
 * the web shows beside it, stacked underneath. Writing back opens a sheet, with the saved replies a press away and the
 * internal-note switch; the reply goes out from support@handsfreeos.com. Looking at the customer's business happens
 * on the web, where it is read-only, with a reason and a time limit.
 */
export default function Ticket() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const id = String(ticketId);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { userId } = useDesk();
  const canAssign = useDeskCan('support.assign');
  const canReadBusinesses = useDeskCan('platform.businesses.read');
  const canLook = useDeskCan('platform.view_as');
  const { staff: me } = useDesk();

  const live = useLive(() => desk('/v1/queries/support.ticket.get', { ticketId: id }), id);
  const replies = useLive(() => desk('/v1/queries/support.canned_reply.list', {}), 'saved-replies');
  const staff = useLive<StaffList | null>(
    () => (canAssign ? desk('/v1/queries/support.staff.list', {}) : Promise.resolve(null)),
    `staff-${canAssign}`,
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState<'status' | 'priority' | 'assignee' | null>(null);
  const [writing, setWriting] = React.useState<{ body: string; internal: boolean } | null>(null);

  /** One change to the ticket, then the ticket asked for again; the API's words if it can't. */
  const run = async (what: string, fn: () => Promise<unknown>, said?: string) => {
    setBusy(what);
    try {
      await fn();
      if (said) toast.show(said);
      live.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const data = live.data;
  if (!data)
    return (
      <Screen
        title=""
        leading="back"
        back={deskHref('tickets')}
        scroll={false}
        testID="desk-ticket"
      >
        <DeskWaiting live={live} testID="ticket" />
      </Screen>
    );

  const { ticket, business } = data;
  const people = (staff.data?.staff ?? []).filter((s) => s.status === 'active');

  return (
    <Screen
      title={`#${ticket.number}`}
      subtitle={TICKET_STATUS_WORDS[ticket.status]}
      leading="back"
      back={deskHref('tickets')}
      scroll={false}
      testID="desk-ticket"
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        refreshControl={
          <RefreshControl
            refreshing={live.refreshing}
            onRefresh={live.reload}
            tintColor={colors.accent}
          />
        }
      >
        <View className="gap-1 px-1">
          <Text variant="heading" testID="ticket-subject">
            {ticket.subject || DESK_WORDS.noSubject}
          </Text>
          <Text className="text-[13px] text-text-3">
            {TICKET_CHANNEL_WORDS[ticket.channel]} ·{' '}
            {ticket.requester.name ? `${ticket.requester.name}, ` : ''}
            {ticket.requester.email}
          </Text>
        </View>

        {data.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}

        {data.draft ? (
          <Card className="gap-2 border-dashed border-accent px-4 py-3" testID="ticket-draft">
            <View className="flex-row flex-wrap items-center gap-1.5">
              <Icon as={Sparkles} className="size-4 text-accent-text" />
              <Text className="text-[13.5px] font-semibold text-accent-text">
                {DESK_WORDS.draftTitle}
              </Text>
              {data.draft.stale ? (
                <Text className="text-[12.5px] text-text-3">· {DESK_WORDS.draftStale}</Text>
              ) : null}
            </View>
            <Text className="text-[14.5px] leading-[21px] text-text-2">{data.draft.bodyText}</Text>
            <Text className="text-xs text-text-3">
              {data.draft.sources.length
                ? DESK_WORDS.draftFrom(data.draft.sources.map((s) => s.title))
                : DESK_WORDS.draftNothingSolid}
            </Text>
            <View className="flex-row gap-2">
              <Button
                variant="secondary"
                size="md"
                className="flex-1"
                onPress={() => setWriting({ body: data.draft!.bodyText, internal: false })}
                testID="draft-use"
              >
                {DESK_WORDS.draftUse}
              </Button>
              <Button
                variant="ghost"
                size="md"
                loading={busy === 'dismiss'}
                onPress={() =>
                  void run('dismiss', () =>
                    desk('/v1/commands/support.ticket.dismiss_draft', { ticketId: ticket.id }),
                  )
                }
                testID="draft-dismiss"
              >
                {DESK_WORDS.draftDismiss}
              </Button>
            </View>
          </Card>
        ) : null}

        <Button
          variant="ghost"
          icon={Sparkles}
          loading={busy === 'draft'}
          onPress={() =>
            void run(
              'draft',
              () => desk('/v1/commands/support.ticket.request_draft', { ticketId: ticket.id }),
              DESK_PHONE_WORDS.draftAsked,
            )
          }
          testID="ask-ai"
        >
          {DESK_WORDS.askAi}
        </Button>

        <Section title={DESK_WORDS.thisTicket} testID="ticket-facts">
          <PickLine
            label={DESK_WORDS.status}
            value={TICKET_STATUS_WORDS[ticket.status]}
            onPress={() => setPicking('status')}
            testID="ticket-status"
          />
          <PickLine
            label={DESK_WORDS.priority}
            value={TICKET_PRIORITY_WORDS[ticket.priority]}
            onPress={() => setPicking('priority')}
            testID="ticket-priority"
          />
          <PickLine
            label={DESK_WORDS.whoHasIt}
            value={ticket.assignee?.name ?? DESK_WORDS.nobody}
            onPress={canAssign && staff.data ? () => setPicking('assignee') : undefined}
            testID="ticket-assignee"
          />
          <Line label={DESK_WORDS.cameIn} value={whenWords(ticket.createdAt)} />
          <Line
            label={DESK_WORDS.firstAnswered}
            value={ticket.firstResponseAt ? whenWords(ticket.firstResponseAt) : DESK_WORDS.notYet}
          />
        </Section>

        <Section title={DESK_WORDS.theirBusiness} testID="ticket-business">
          {business ? (
            <>
              <View className="gap-0.5">
                <Text className="text-[15px] font-medium">{business.name}</Text>
                <Text className="text-[13px] text-text-3">
                  {business.organizationName ? `${business.organizationName} · ` : ''}
                  {DESK_WORDS.people(business.memberCount)} ·{' '}
                  {DESK_WORDS.withUsSince(new Date(business.createdAt).toLocaleDateString())}
                </Text>
              </View>
              {canReadBusinesses ? (
                <Button
                  variant="secondary"
                  size="md"
                  onPress={() =>
                    router.push(deskHref(`businesses/${business.workspaceId}`) as Href)
                  }
                  testID="ticket-open-business"
                >
                  {DESK_WORDS.openAccountPage}
                </Button>
              ) : null}
              {canLook ? (
                <Button
                  variant="ghost"
                  size="md"
                  icon={Eye}
                  onPress={() => void openWeb(`/admin/tickets/${ticket.id}`)}
                  testID="ticket-look-on-web"
                >
                  {me.founder ? DESK_PHONE_WORDS.openAsOwnerOnWeb : DESK_PHONE_WORDS.lookOnWeb}
                </Button>
              ) : null}
            </>
          ) : (
            <Text className="text-[13.5px] leading-[19px] text-text-3">
              {DESK_WORDS.businessUnknown}
            </Text>
          )}
        </Section>

        {data.alsoFrom.length ? (
          <Section title={DESK_WORDS.alsoFromThem} testID="ticket-also-from">
            {data.alsoFrom.map((t) => (
              <Pressable
                key={t.id}
                role="link"
                onPress={() => router.push(deskHref(`tickets/${t.id}`) as Href)}
                className="min-h-9 justify-center active:opacity-70"
              >
                <Text className="text-[13.5px] text-text-2" numberOfLines={1}>
                  #{t.number} {t.subject} · {TICKET_STATUS_WORDS[t.status]}
                </Text>
              </Pressable>
            ))}
          </Section>
        ) : null}

        <Section title={DESK_WORDS.whatHappened} testID="ticket-events">
          {data.events.map((e) => (
            <Text key={e.id} className="text-[13px] text-text-3">
              {TICKET_EVENT_WORDS[e.kind] ?? e.kind} · {whenWords(e.createdAt)}
            </Text>
          ))}
        </Section>
      </ScrollView>

      <View
        className="flex-row gap-2 border-t border-border bg-card px-3 pt-2.5"
        style={{ paddingBottom: Math.max(insets.bottom, 10) }}
      >
        <Button
          className="flex-1"
          onPress={() => setWriting({ body: '', internal: false })}
          testID="reply-open"
        >
          {DESK_PHONE_WORDS.writeBack}
        </Button>
        <Button
          variant="secondary"
          onPress={() => setWriting({ body: '', internal: true })}
          testID="note-open"
        >
          {DESK_WORDS.internalNote}
        </Button>
      </View>

      <PickSheet<TicketStatus>
        open={picking === 'status'}
        onClose={() => setPicking(null)}
        title={DESK_PHONE_WORDS.pickStatus}
        value={ticket.status}
        options={(Object.keys(TICKET_STATUS_WORDS) as TicketStatus[]).map((s) => ({
          value: s,
          label: TICKET_STATUS_WORDS[s],
        }))}
        onPick={(status) =>
          void run('status', () =>
            desk('/v1/commands/support.ticket.set_status', { ticketId: ticket.id, status }),
          )
        }
        testID="pick-status"
      />
      <PickSheet<TicketPriority>
        open={picking === 'priority'}
        onClose={() => setPicking(null)}
        title={DESK_PHONE_WORDS.pickPriority}
        value={ticket.priority}
        options={(Object.keys(TICKET_PRIORITY_WORDS) as TicketPriority[]).map((p) => ({
          value: p,
          label: TICKET_PRIORITY_WORDS[p],
        }))}
        onPick={(priority) =>
          void run('priority', () =>
            desk('/v1/commands/support.ticket.set_priority', { ticketId: ticket.id, priority }),
          )
        }
        testID="pick-priority"
      />
      <PickSheet<string>
        open={picking === 'assignee'}
        onClose={() => setPicking(null)}
        title={DESK_PHONE_WORDS.pickAssignee}
        value={ticket.assignee?.userId ?? ''}
        options={[
          { value: '', label: DESK_WORDS.nobody },
          ...people.map((s) => ({
            value: s.userId,
            label: `${s.displayName || s.fullName}${s.userId === userId ? ` ${DESK_WORDS.me}` : ''}`,
          })),
        ]}
        onPick={(assignee) =>
          void run('assign', () =>
            desk('/v1/commands/support.ticket.assign', {
              ticketId: ticket.id,
              assigneeUserId: assignee || null,
            }),
          )
        }
        testID="pick-assignee"
      />
      <ReplySheet
        ticketId={ticket.id}
        start={writing}
        savedReplies={replies.data?.replies ?? []}
        onClose={() => setWriting(null)}
        onSent={(internal) => {
          setWriting(null);
          toast.show(internal ? DESK_PHONE_WORDS.noteSaved : DESK_PHONE_WORDS.sent);
          live.reload();
        }}
      />
    </Screen>
  );
}

function MessageView({ message: m }: { message: Message }) {
  return (
    <View
      testID={`ticket-message-${m.author}`}
      className={cn(
        'gap-1.5 rounded-card border px-4 py-3',
        m.internal
          ? 'border-warning-soft bg-warning-soft'
          : m.author === 'customer'
            ? 'border-border bg-card'
            : 'border-accent-soft bg-accent-soft',
      )}
    >
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="min-w-0 flex-shrink text-[13px] font-semibold" numberOfLines={1}>
          {m.authorName}
          {m.internal ? DESK_WORDS.internalNoteTag : ''}
        </Text>
        <Text className="text-xs text-text-3">{whenWords(m.createdAt)}</Text>
      </View>
      <Text selectable className="text-[14.5px] leading-[21px]">
        {m.bodyText}
      </Text>
    </View>
  );
}

/** A line of "This ticket" that changes with a press: the value, and a chevron-less press area. */
function PickLine({
  label,
  value,
  onPress,
  testID,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  testID?: string;
}) {
  if (!onPress) return <Line label={label} value={value} testID={testID} />;
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${label}. ${value}`}
      onPress={onPress}
      testID={testID}
      className="-mx-2 min-h-10 flex-row items-center justify-between gap-3 rounded-control px-2 active:bg-card-2"
    >
      <Text className="text-[13.5px] text-text-3">{label}</Text>
      <Text className="text-[13.5px] font-medium text-accent-text">{value}</Text>
    </Pressable>
  );
}

/**
 * Writing back, or an internal note. The saved replies go in with a press, after whatever is already written; the
 * switch makes it a note the customer never sees.
 */
function ReplySheet({
  ticketId,
  start,
  savedReplies,
  onClose,
  onSent,
}: {
  ticketId: string;
  start: { body: string; internal: boolean } | null;
  savedReplies: readonly SavedReply[];
  onClose: () => void;
  onSent: (internal: boolean) => void;
}) {
  const colors = useColors();
  const keyboard = useKeyboardHeight();
  const [body, setBody] = React.useState('');
  const [internal, setInternal] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!start) return;
    setBody(start.body);
    setInternal(start.internal);
    setProblem(null);
  }, [start]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/support.ticket.reply', { ticketId, body: text, internal });
      onSent(internal);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={start !== null}
      onClose={onClose}
      title={internal ? DESK_WORDS.internalNote : DESK_PHONE_WORDS.writeBack}
      testID="reply-sheet"
    >
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          textAlignVertical="top"
          placeholder={internal ? DESK_WORDS.notePlaceholder : DESK_WORDS.replyPlaceholder}
          placeholderTextColor={colors.text3}
          accessibilityLabel={internal ? DESK_WORDS.internalNote : DESK_PHONE_WORDS.reply}
          maxLength={20000}
          className="h-40 rounded-control border border-border-strong bg-card px-3 py-3 font-sans text-[15px] text-text"
          testID="reply-box"
        />
        {savedReplies.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-1.5"
            keyboardShouldPersistTaps="handled"
            testID="reply-saved"
          >
            {savedReplies.map((r) => (
              <Pressable
                key={r.id}
                role="button"
                onPress={() => setBody((b) => (b.trim() ? `${b}\n\n${r.bodyText}` : r.bodyText))}
                className="h-9 justify-center rounded-full border border-border-strong px-3 active:bg-card-2"
                testID={`saved-reply-${r.id}`}
              >
                <Text className="text-[13px] text-text-2">{r.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View className="min-h-11 flex-row items-center justify-between gap-3">
          <Text className="text-[14.5px]">{DESK_WORDS.internalNote}</Text>
          <Switch
            checked={internal}
            onCheckedChange={setInternal}
            label={DESK_WORDS.internalNote}
            testID="reply-internal"
          />
        </View>
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button
          onPress={() => void send()}
          loading={busy}
          disabled={!body.trim()}
          testID="reply-send"
        >
          {internal ? DESK_WORDS.saveNote : DESK_WORDS.sendReply}
        </Button>
        {internal ? null : (
          <Text className="text-center text-xs text-text-3">{DESK_WORDS.replyGoesOut}</Text>
        )}
      </View>
    </Sheet>
  );
}
