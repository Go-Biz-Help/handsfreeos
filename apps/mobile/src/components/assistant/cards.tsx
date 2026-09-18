import {
  assistantChatWhen,
  assistantMoneyOpenLabel,
  assistantOpenLabel,
  assistantStageKind,
  money,
  type AssistantCard,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import {
  BookOpen,
  CalendarDays,
  CircleCheck,
  Phone,
  StickyNote,
  Undo2,
  Zap,
} from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { undoToolCall } from '@/assistant/stream';
import type { CallState } from '@/assistant/chat';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import {
  CardHead,
  CardRow,
  CardShell,
  CardTitle,
  Dot,
  LinkLabel,
  openAppPath,
  Result,
  RowLink,
  Tile,
} from './parts';

/**
 * The cards under an answer, the same ones the web's panel draws (`apps/web/src/components/assistant/cards.tsx`).
 * Every figure and name on them is the worker's, built from real records, so nothing here comes from the model's
 * own words. Rows open the phone's screen for what they name.
 */

type CardOf<T extends AssistantCard['type']> = Extract<AssistantCard, { type: T }>;

const stageVariant = (name: string) =>
  assistantStageKind(name) === 'won'
    ? 'ok'
    : assistantStageKind(name) === 'lost'
      ? 'danger'
      : 'accent';

function StageBadge({ name }: { name: string }) {
  return (
    <Badge variant={stageVariant(name)}>
      <Text>{name}</Text>
    </Badge>
  );
}

function CustomerCard({ card }: { card: CardOf<'customer'> }) {
  return (
    <CardShell testID="assistant-card-customer">
      <CardHead>
        <Avatar name={card.fullName} seed={card.personId} />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm font-medium">
            {card.fullName}
          </Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {card.detail}
          </Text>
        </View>
        <Button variant="secondary" size="sm" onPress={() => openAppPath(card.href)}>
          Open
        </Button>
      </CardHead>
      {card.lead ? (
        <CardRow>
          <Text numberOfLines={1} className="min-w-0 flex-1 text-[13px]">
            {card.lead.title} · {money(card.lead.valueCents)}
          </Text>
          <StageBadge name={card.lead.stageName} />
        </CardRow>
      ) : null}
    </CardShell>
  );
}

function LeadCard({ card }: { card: CardOf<'lead'> }) {
  const sub = [card.customer, money(card.valueCents), card.assignee].filter(Boolean).join(' · ');
  return (
    <CardShell testID="assistant-card-lead">
      <CardHead>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm font-medium">
            {card.title}
          </Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {sub}
          </Text>
        </View>
        <StageBadge name={card.stageName} />
      </CardHead>
      {card.nextAction ? (
        <CardRow>
          <Text numberOfLines={2} className="min-w-0 flex-1 text-[13px] text-text-2">
            {card.nextAction}
          </Text>
        </CardRow>
      ) : null}
      <RowLink href={card.href}>
        <LinkLabel>Open lead</LinkLabel>
      </RowLink>
    </CardShell>
  );
}

function ChoicesCard({ card }: { card: CardOf<'choices'> }) {
  return (
    <CardShell testID="assistant-card-choices">
      <CardHead>
        <CardTitle>{card.title}</CardTitle>
      </CardHead>
      {card.items.map((item) => (
        <RowLink key={item.id} href={item.href}>
          <Avatar name={item.label} seed={item.id} size="sm" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-[13px]">
            <Text className="text-[13px] font-medium">{item.label}</Text>
            {item.detail ? ` · ${item.detail}` : ''}
          </Text>
        </RowLink>
      ))}
    </CardShell>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Chips that tell time: a row shows its first one at its end. */
const TIME_CHIPS: ReadonlySet<string> = new Set([
  'waiting',
  'not_contacted',
  'last_contact',
  'no_contact',
  'follow_up_overdue',
  'overdue',
  'starts_in',
  'expires_in',
]);

function AttentionCard({ card, at }: { card: CardOf<'attention'>; at: string }) {
  const head = card.affected;
  return (
    <CardShell testID="assistant-card-attention">
      {head ? (
        <CardHead className="items-end">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="text-xs text-text-3">
              Needs attention · {head.scope === 'mine' ? 'Mine' : 'Everyone'} ·{' '}
              {assistantChatWhen(at, { time: true })}
            </Text>
            <Text className="text-[22px] font-semibold tracking-[-0.2px]">
              {head.cents > 0
                ? `${money(head.cents)} affected`
                : head.total === 1
                  ? '1 needs attention'
                  : `${head.total} need attention`}
            </Text>
          </View>
          {head.urgent ? (
            <Badge variant="danger">
              <Text>{head.urgent} urgent</Text>
            </Badge>
          ) : null}
        </CardHead>
      ) : (
        <CardHead>
          <CardTitle>Waiting on you</CardTitle>
          <Text className="text-xs text-text-3">{assistantChatWhen(at, { time: true })}</Text>
        </CardHead>
      )}
      {card.items.map((item, i) => {
        const time = item.chips?.find((c) => TIME_CHIPS.has(c.code));
        return (
          <RowLink key={`${item.title}-${i}`} href={item.href}>
            <Dot tone={item.tone} />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[13px] font-medium">
                {item.title}
              </Text>
              <Text numberOfLines={1} className="text-xs text-text-3">
                {item.detail}
              </Text>
            </View>
            {time ? (
              <Badge variant={item.tone === 'danger' ? 'danger' : 'pending'}>
                <Text>{capital(time.text)}</Text>
              </Badge>
            ) : null}
          </RowLink>
        );
      })}
    </CardShell>
  );
}

function NumbersCard({ card }: { card: CardOf<'numbers'> }) {
  return (
    <CardShell testID="assistant-card-numbers">
      <View className="gap-1 px-3.5 py-3">
        <Text className="text-xs text-text-3">{card.label}</Text>
        <Text className="text-[26px] font-semibold tracking-[-0.3px]">{card.value}</Text>
        {card.delta ? <Text className="text-[13px] text-text-2">{card.delta}</Text> : null}
      </View>
      {card.stats.length ? (
        <CardRow className="flex-wrap gap-x-5 gap-y-1.5">
          {card.stats.map((s, i) => (
            <View key={i} className="gap-0.5">
              <Text className="text-[15px] font-semibold">{s.value}</Text>
              <Text className="text-xs text-text-3">{s.label}</Text>
            </View>
          ))}
        </CardRow>
      ) : null}
      {card.href ? (
        <RowLink href={card.href}>
          <LinkLabel>Open</LinkLabel>
        </RowLink>
      ) : null}
    </CardShell>
  );
}

function ListCard({ card }: { card: CardOf<'list'> }) {
  return (
    <CardShell testID="assistant-card-list">
      <CardHead>
        <CardTitle>{card.title}</CardTitle>
        {card.aside ? <Text className="text-xs text-text-3">{card.aside}</Text> : null}
      </CardHead>
      {card.items.map((item, i) =>
        item.href ? (
          <RowLink key={i} href={item.href}>
            <Dot tone={item.tone} />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[13px] font-medium">
                {item.title}
              </Text>
              <Text numberOfLines={1} className="text-xs text-text-3">
                {item.detail}
              </Text>
            </View>
          </RowLink>
        ) : (
          <CardRow key={i}>
            <Dot tone={item.tone} />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[13px] font-medium">
                {item.title}
              </Text>
              <Text numberOfLines={1} className="text-xs text-text-3">
                {item.detail}
              </Text>
            </View>
          </CardRow>
        ),
      )}
    </CardShell>
  );
}

function MoneyCard({ card }: { card: CardOf<'money'> }) {
  return (
    <CardShell testID="assistant-card-money">
      <View className="gap-1 px-3.5 py-3">
        <Text className="text-xs text-text-3">{card.title}</Text>
        <Text className="text-[26px] font-semibold tracking-[-0.3px]">{card.value}</Text>
        {card.detail ? <Text className="text-[13px] text-text-2">{card.detail}</Text> : null}
      </View>
      {card.stats?.length ? (
        <CardRow className="flex-wrap gap-x-5 gap-y-1.5">
          {card.stats.map((s, i) => (
            <View key={i} className="gap-0.5">
              <Text className="text-[15px] font-semibold">{s.value}</Text>
              <Text className="text-xs text-text-3">{s.label}</Text>
            </View>
          ))}
        </CardRow>
      ) : null}
      {(card.items ?? []).map((item, i) => {
        const row = (
          <>
            <Dot tone={item.tone} />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[13px] font-medium">
                {item.title}
              </Text>
              <Text numberOfLines={1} className="text-xs text-text-3">
                {item.detail}
              </Text>
            </View>
            {item.status ? (
              <Badge
                variant={
                  item.tone === 'danger' ? 'danger' : item.tone === 'warning' ? 'pending' : 'gray'
                }
              >
                <Text>{item.status}</Text>
              </Badge>
            ) : null}
          </>
        );
        return item.href ? (
          <RowLink key={i} href={item.href}>
            {row}
          </RowLink>
        ) : (
          <CardRow key={i}>{row}</CardRow>
        );
      })}
      {card.href ? (
        <RowLink href={card.href}>
          <LinkLabel>{assistantMoneyOpenLabel(card.href)}</LinkLabel>
        </RowLink>
      ) : null}
    </CardShell>
  );
}

function SlotsCard({ card }: { card: CardOf<'slots'> }) {
  return (
    <CardShell testID="assistant-card-slots">
      <CardHead>
        <View className="min-w-0 flex-1">
          <CardTitle>{card.title}</CardTitle>
          <Text className="text-xs text-text-3">
            {card.durationMinutes} min · {card.zone}
          </Text>
        </View>
      </CardHead>
      {card.days.map((day) => (
        <CardRow key={day.date} className="flex-col items-start gap-1.5">
          <Text className="text-[13px] font-medium">{day.label}</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {day.times.map((t) => (
              <View key={t.startsAt} className="rounded-menu bg-card-2 px-2.5 py-1.5">
                <Text className="text-[13px]">{t.label}</Text>
              </View>
            ))}
          </View>
        </CardRow>
      ))}
      <RowLink href={card.href}>
        <LinkLabel>Open the calendar</LinkLabel>
      </RowLink>
    </CardShell>
  );
}

function AppointmentCard({ card }: { card: CardOf<'appointment'> }) {
  return (
    <CardShell testID="assistant-card-appointment">
      <CardHead>
        <Tile icon={CalendarDays} tone="accent" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm font-medium">
            {card.what}
          </Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {[card.customer, card.when, card.with].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </CardHead>
      <RowLink href={card.href}>
        <LinkLabel>Open the appointment</LinkLabel>
      </RowLink>
    </CardShell>
  );
}

function WorkflowCard({ card }: { card: CardOf<'workflow'> }) {
  return (
    <CardShell testID="assistant-card-workflow">
      <CardHead>
        <Tile icon={Zap} tone="accent" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm font-medium">
            {card.name}
          </Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {card.trigger}
          </Text>
        </View>
      </CardHead>
      {card.steps.slice(0, 4).map((step, i) => (
        <CardRow key={i}>
          <Text numberOfLines={2} className="min-w-0 flex-1 text-[13px]">
            {step}
          </Text>
        </CardRow>
      ))}
      {card.more > 0 ? (
        <CardRow>
          <Text className="text-[13px] text-text-3">and {card.more} more</Text>
        </CardRow>
      ) : null}
      <RowLink href={card.href}>
        <LinkLabel>Open on the web</LinkLabel>
      </RowLink>
    </CardShell>
  );
}

function KnowledgeCard({ card }: { card: CardOf<'knowledge'> }) {
  return (
    <CardShell testID="assistant-card-knowledge">
      <CardHead>
        <Tile icon={BookOpen} tone="neutral" />
        <CardTitle>What it read</CardTitle>
      </CardHead>
      {card.items.map((item) => (
        <RowLink key={item.id} href={item.href}>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-[13px] font-medium">
              {item.title}
            </Text>
            <Text numberOfLines={2} className="text-xs text-text-3">
              {item.snippet.replace(/\*\*/g, '')}
            </Text>
          </View>
        </RowLink>
      ))}
    </CardShell>
  );
}

function CallCard({ card }: { card: CardOf<'call'> }) {
  return (
    <CardShell testID="assistant-card-call">
      <CardHead>
        <Tile icon={Phone} tone="success" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm font-medium">
            {card.fullName}
          </Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {card.phone}
          </Text>
        </View>
      </CardHead>
    </CardShell>
  );
}

/** A task or note the Assistant added on its own, with Undo while it can still be taken back. */
function DoneCard({
  card,
  workspaceId,
  state,
  setCall,
}: {
  card: CardOf<'done'>;
  workspaceId: string;
  state: CallState | undefined;
  setCall: (id: string, patch: Partial<CallState>) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const undone = state?.undone === true;
  const undo = async () => {
    setBusy(true);
    try {
      const out = await undoToolCall(card.toolCallId, workspaceId);
      setCall(card.toolCallId, { status: 'done', undone: out.undone ?? true });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CardShell testID="assistant-card-done">
      <CardHead>
        <Tile icon={card.kind === 'note' ? StickyNote : CircleCheck} tone="success" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className={cn('text-sm font-medium', undone && 'line-through')}>
            {card.title}
          </Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {card.detail}
          </Text>
        </View>
      </CardHead>
      {undone ? (
        <Result tone="no" icon={Undo2}>
          Taken back.
        </Result>
      ) : (
        <View className="flex-row items-center gap-2 border-t border-border px-3.5 py-2.5">
          {card.undoable ? (
            <Button
              variant="secondary"
              size="sm"
              icon={Undo2}
              loading={busy}
              onPress={() => void undo()}
              testID="assistant-undo"
            >
              Undo
            </Button>
          ) : null}
          <View className="flex-1" />
          {card.href ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => openAppPath(card.href!)}
              testID="assistant-done-open"
            >
              {assistantOpenLabel(card.kind === 'note' ? 'add_note' : 'add_task', card.href)}
            </Button>
          ) : null}
        </View>
      )}
    </CardShell>
  );
}

/** Everything but a confirmation, which has its own file because it can still change something. */
export function AnswerCard({
  card,
  at,
  workspaceId,
  calls,
  setCall,
}: {
  card: AssistantCard;
  at: string;
  workspaceId: string;
  calls: Readonly<Record<string, CallState>>;
  setCall: (id: string, patch: Partial<CallState>) => void;
}) {
  switch (card.type) {
    case 'customer':
      return <CustomerCard card={card} />;
    case 'lead':
      return <LeadCard card={card} />;
    case 'choices':
      return <ChoicesCard card={card} />;
    case 'attention':
      return <AttentionCard card={card} at={at} />;
    case 'numbers':
      return <NumbersCard card={card} />;
    case 'list':
      return <ListCard card={card} />;
    case 'money':
      return <MoneyCard card={card} />;
    case 'slots':
      return <SlotsCard card={card} />;
    case 'appointment':
      return <AppointmentCard card={card} />;
    case 'workflow':
      return <WorkflowCard card={card} />;
    case 'knowledge':
      return <KnowledgeCard card={card} />;
    case 'call':
      return <CallCard card={card} />;
    case 'done':
      return (
        <DoneCard
          card={card}
          workspaceId={workspaceId}
          state={calls[card.toolCallId]}
          setCall={setCall}
        />
      );
    default:
      return null;
  }
}
