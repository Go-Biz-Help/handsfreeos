import {
  ASSISTANT_CONFIRM_WORDS,
  assistantCancelledText,
  assistantMoveKind,
  assistantOpenLabel,
  assistantStageKind,
  assistantWarningTone,
  type AssistantCard,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import {
  ArrowRight,
  Ban,
  CalendarClock,
  CalendarOff,
  CalendarX,
  Check,
  CircleCheck,
  Clock,
  Info,
  MessageSquareOff,
  Moon,
  ShieldCheck,
  TriangleAlert,
  Users,
  X,
} from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import type { CallState } from '@/assistant/chat';
import { AssistantError, cancelToolCall, confirmToolCall } from '@/assistant/stream';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { CardShell, openAppPath, Result } from './parts';

export type ConfirmCardData = Extract<AssistantCard, { type: 'confirm' }>;

/**
 * Anything that would reach a customer, or change a lead, a customer or an appointment, waits here for the person's
 * OK — the same card the web shows (design/m4/Confirm.dc.html, design/m10/Assistant.dc.html "A confirm card").
 * Nothing goes until the button is pressed, and its buttons are 44 px on a phone. Answering needs signal: the
 * worker is the only one that can run it.
 */

const WARNING_ICONS: Record<string, LucideIcon> = {
  quiet_hours: Moon,
  duplicate: Users,
  blocked: Ban,
  conflict: CalendarX,
  outside_hours: Clock,
  busy: CalendarClock,
  time_off: CalendarOff,
  no_text_consent: MessageSquareOff,
  note: Info,
  scheduled: Clock,
};

/** A move shows the old time struck through and the new one in bold. */
const FIELD_VALUE: Record<string, string> = {
  Was: 'text-text-3 line-through',
  Now: 'font-semibold',
};

const stageVariant = (name: string, kind?: 'open' | 'won' | 'lost') => {
  const k = kind ?? assistantStageKind(name);
  return k === 'won' ? 'ok' : k === 'lost' ? 'danger' : 'accent';
};

export function ConfirmCard({
  card,
  workspaceId,
  state,
  setCall,
}: {
  card: ConfirmCardData;
  workspaceId: string;
  state: CallState | undefined;
  setCall: (id: string, patch: Partial<CallState>) => void;
}) {
  const here: CallState = state ?? {
    status: 'awaiting_confirmation',
    tool: card.tool,
    outcome: null,
    error: null,
    href: null,
  };
  const [busy, setBusy] = React.useState<'confirm' | 'cancel' | null>(null);
  const [reason, setReason] = React.useState('');
  const [reasonOpen, setReasonOpen] = React.useState(false);
  const waiting = here.status === 'awaiting_confirmation';
  /** A rule stops it (opted out, no number…): no Confirm, only the reason and Close. */
  const blocked = !card.confirmLabel;
  const needsReason = card.reasons.length > 0;
  const moving = !!(card.stageFrom && card.stageTo);
  /** Cancelling an appointment: a red button, and the way out reads "Keep it". */
  const cancelling = card.tool === 'cancel_appointment';
  const leadLine = moving ? card.fields.find((f) => f.label === 'Lead')?.value : undefined;
  // An empty value (a "With" on a calendar that needs no staff) is left out rather than shown blank.
  const fields = card.fields.filter((f) => f.value.trim() && !(moving && f.label === 'Lead'));

  /**
   * Edit opens the conversation with the words in the box, so they can be changed and sent by hand. The card is
   * cancelled as it goes, so the same message can't also go from the card.
   */
  const edit = () => {
    if (!card.conversationId) return;
    void cancelToolCall(card.toolCallId, workspaceId).catch(() => undefined);
    setCall(card.toolCallId, {
      status: 'cancelled',
      note: ASSISTANT_CONFIRM_WORDS.editedInstead,
    });
    router.push(
      `${businessHref(workspaceId, `inbox/${card.conversationId}`)}?draft=${encodeURIComponent(card.body ?? '')}` as Href,
    );
  };

  const decide = async (kind: 'confirm' | 'cancel') => {
    setBusy(kind);
    try {
      const out =
        kind === 'confirm'
          ? await confirmToolCall(card.toolCallId, workspaceId, needsReason ? reason : undefined)
          : await cancelToolCall(card.toolCallId, workspaceId);
      setCall(card.toolCallId, {
        status:
          out.status === 'confirmed'
            ? 'confirmed'
            : out.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        outcome: out.outcome,
        href: out.href,
        error: out.error,
      });
    } catch (e) {
      // Answered on another screen, or it lapsed: the card says so.
      if (e instanceof AssistantError && (e.status === 409 || e.status === 404))
        setCall(card.toolCallId, { status: 'expired', note: e.message });
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <CardShell
      testID="assistant-card-confirm"
      className={cn(waiting && !blocked && 'border-accent')}
    >
      <View className="gap-2.5 px-3.5 py-3">
        {waiting && !blocked ? (
          <View className="flex-row items-center gap-1.5">
            <Icon as={ShieldCheck} className="size-3.5 text-accent-text" />
            <Text
              testID="assistant-needs-ok"
              className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-accent-text"
            >
              {ASSISTANT_CONFIRM_WORDS.needsOk}
            </Text>
          </View>
        ) : null}
        <Text className="text-[15px] font-semibold leading-[20px]" testID="assistant-confirm-title">
          {card.title}
        </Text>
        {moving ? (
          <>
            <View className="flex-row flex-wrap items-center gap-2">
              <Badge variant={stageVariant(card.stageFrom!, 'open')}>
                <Text>{card.stageFrom}</Text>
              </Badge>
              <Icon as={ArrowRight} className="size-3.5 text-text-3" />
              <Badge variant={stageVariant(card.stageTo!, assistantMoveKind(card))}>
                <Text>{card.stageTo}</Text>
              </Badge>
            </View>
            {leadLine ? <Text className="text-[13px] text-text-2">{leadLine}</Text> : null}
          </>
        ) : null}
        {fields.map((f, i) => (
          <View key={`${f.label}-${i}`} className="flex-row gap-2.5">
            <Text className="w-12 shrink-0 text-[13px] text-text-3">{f.label}</Text>
            <Text className={cn('min-w-0 flex-1 text-[13px]', FIELD_VALUE[f.label])}>
              {f.value}
            </Text>
          </View>
        ))}
        {card.body ? (
          <View className="rounded-menu bg-card-2 px-3 py-2.5">
            <Text className="text-[13.5px] leading-[19px]">{card.body}</Text>
          </View>
        ) : null}
        {card.warnings.map((w, i) => {
          const tone = assistantWarningTone(w.kind);
          return (
            <View
              key={i}
              testID={`assistant-warning-${w.kind}`}
              className={cn(
                'flex-row items-start gap-2 rounded-control px-2.5 py-2',
                tone === 'danger'
                  ? 'bg-danger-soft'
                  : tone === 'accent'
                    ? 'bg-accent-soft'
                    : 'bg-warning-soft',
              )}
            >
              <Icon
                as={WARNING_ICONS[w.kind] ?? TriangleAlert}
                className={cn(
                  'mt-0.5 size-3.5 shrink-0',
                  tone === 'danger'
                    ? 'text-danger-text'
                    : tone === 'accent'
                      ? 'text-accent-text'
                      : 'text-warning-text',
                )}
              />
              <Text
                className={cn(
                  'min-w-0 flex-1 text-[13px] leading-[18px]',
                  tone === 'danger'
                    ? 'text-danger-text'
                    : tone === 'accent'
                      ? 'text-accent-text'
                      : 'text-warning-text',
                )}
              >
                {w.text}
              </Text>
            </View>
          );
        })}
        {waiting && needsReason ? (
          <Pressable
            role="button"
            testID="assistant-lost-reason"
            onPress={() => setReasonOpen(true)}
            className="min-h-11 flex-row items-center justify-between rounded-menu border border-border-strong bg-card px-3.5"
          >
            <Text className={cn('text-[15px]', !reason && 'text-placeholder')}>
              {reason || ASSISTANT_CONFIRM_WORDS.chooseReason}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {waiting ? (
        <View className="flex-row items-center gap-2 border-t border-border px-3.5 py-2.5">
          {blocked ? null : (
            <Button
              size="md"
              variant={cancelling ? 'danger' : 'primary'}
              loading={busy === 'confirm'}
              disabled={!!busy || (needsReason && !reason)}
              onPress={() => void decide('confirm')}
              testID="assistant-confirm"
            >
              {card.confirmLabel}
            </Button>
          )}
          {card.editable && !blocked && card.conversationId ? (
            <Button
              size="md"
              variant="secondary"
              disabled={!!busy}
              onPress={edit}
              testID="assistant-edit"
            >
              {ASSISTANT_CONFIRM_WORDS.edit}
            </Button>
          ) : null}
          <View className="flex-1" />
          <Button
            size="md"
            variant="ghost"
            loading={busy === 'cancel'}
            disabled={!!busy}
            onPress={() => void decide('cancel')}
            testID="assistant-cancel"
          >
            {blocked
              ? ASSISTANT_CONFIRM_WORDS.close
              : cancelling
                ? ASSISTANT_CONFIRM_WORDS.keepIt
                : ASSISTANT_CONFIRM_WORDS.cancel}
          </Button>
        </View>
      ) : here.status === 'confirmed' ? (
        <Result
          tone="ok"
          icon={CircleCheck}
          action={
            here.href ? (
              <Pressable
                role="link"
                testID="assistant-result-open"
                hitSlop={8}
                onPress={() => openAppPath(here.href!)}
                className="min-h-11 shrink-0 justify-center px-1"
              >
                <Text className="font-medium text-accent-text">
                  {assistantOpenLabel(card.tool, here.href)}
                </Text>
              </Pressable>
            ) : null
          }
        >
          {here.outcome ?? ASSISTANT_CONFIRM_WORDS.done}
        </Result>
      ) : here.status === 'cancelled' ? (
        <Result tone="no" icon={X}>
          {here.note ?? assistantCancelledText(card)}
        </Result>
      ) : here.status === 'failed' ? (
        <Result tone="bad" icon={Ban}>
          {here.error ?? ASSISTANT_CONFIRM_WORDS.failed}
        </Result>
      ) : (
        <Result tone="no" icon={Clock}>
          {here.note ?? ASSISTANT_CONFIRM_WORDS.expired}
        </Result>
      )}

      <Sheet
        open={reasonOpen}
        onClose={() => setReasonOpen(false)}
        title={ASSISTANT_CONFIRM_WORDS.whyLost}
        scroll
        testID="assistant-reason-sheet"
      >
        {card.reasons.map((r) => (
          <Pressable
            key={r}
            role="button"
            onPress={() => {
              setReason(r);
              setReasonOpen(false);
            }}
            className="min-h-12 flex-row items-center gap-2.5 border-b border-border px-1 active:bg-card-2"
          >
            <Text className="min-w-0 flex-1 text-[15px]">{r}</Text>
            {reason === r ? <Icon as={Check} className="size-4 text-accent-text" /> : null}
          </Pressable>
        ))}
      </Sheet>
    </CardShell>
  );
}
