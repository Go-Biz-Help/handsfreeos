import {
  bridgeOver,
  bridgeStatusOf,
  bridgeStatusWords,
  CALL_SHEET_WORDS,
  CANCELLABLE_BRIDGE,
  callSheetWords,
  formatPhone,
  VIDEO_CALL_WORDS,
  type BridgeStatus,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { router, type Href } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Building, PhoneCall, PhoneMissed, Smartphone, Video, X } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { change, ChangeError, NEEDS_SIGNAL } from '@/changes';
import { refusalOf } from '@/changes/rules';
import { callRequests, useCallRequest, type CallTarget } from '@/inbox/calls';
import { useBusinessNumber, useMyCell } from '@/inbox/cell';
import { useLock } from '@/lib/lock';
import { networkSnapshot } from '@/lib/network';
import { cn } from '@/lib/utils';
import {
  useCanStartVideoCall,
  useStartVideoCall,
  type VideoCallTarget,
} from '@/video-call/start-call';

/** Where the sheet is: asking HandsFreeOS for the call, following it, or why it couldn't start. */
type SheetState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'starting'; readonly target: CallTarget }
  | {
      readonly kind: 'calling';
      readonly target: CallTarget;
      readonly callId: string;
      readonly cell: string;
      readonly callerId: string;
    }
  | { readonly kind: 'refused'; readonly target: CallTarget; readonly message: string };

interface CallRow {
  readonly status: string;
  readonly answered_via: string | null;
  readonly answered_by_user_id: string | null;
  readonly answered_at: string | null;
}

/** My cell phone, remembering the call it was opened for, so it can offer that call once the cell is verified. */
export function myCellHref(businessId: string, target: CallTarget): Href {
  const query = target.conversationId
    ? `callConversation=${encodeURIComponent(target.conversationId)}`
    : `callPerson=${encodeURIComponent(target.personId ?? '')}`;
  return `${businessHref(businessId, 'settings/my-cell')}?${query}` as Href;
}

/** The customer a call is for, from the copy: their name, or the number when nobody has linked it. */
function useCustomerName(target: CallTarget | null): string | null {
  const conversationId = target?.conversationId ?? '';
  const personId = target?.personId ?? '';
  const { data: conversation } = useQuery<{
    counterpart: string;
    channel: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    `SELECT c.counterpart, c.channel, p.first_name, p.last_name FROM conversations c
     LEFT JOIN people p ON p.id = c.person_id WHERE c.id = ?`,
    [conversationId],
  );
  const { data: person } = useQuery<{ first_name: string | null; last_name: string | null }>(
    'SELECT first_name, last_name FROM people WHERE id = ?',
    [personId],
  );
  const named = (row: { first_name: string | null; last_name: string | null } | undefined) =>
    row ? `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || null : null;
  if (target?.personId) return named(person[0]);
  const c = conversation[0];
  if (!c) return null;
  return named(c) ?? (c.channel === 'sms' ? formatPhone(c.counterpart) : null);
}

/**
 * Switch to video's way to the customer (docs/video-calls.md, part 5): the text conversation the call is from, when a
 * customer is linked to it, or the customer's own number. Null when there's no customer to send a link to.
 */
function useVideoTarget(target: CallTarget | null): VideoCallTarget | null {
  const { data } = useQuery<{ person_id: string | null }>(
    'SELECT person_id FROM conversations WHERE id = ?',
    [target?.conversationId ?? ''],
  );
  if (target?.personId) return { personId: target.personId, channel: 'sms' };
  return target?.conversationId && data[0]?.person_id
    ? { conversationId: target.conversationId }
    : null;
}

/**
 * The call sheet (the Calls board's "Call Mike"), mounted once in a business's layout: it takes the calls asked for
 * with `startCall`, and shows each one's way through — "Calling your cell…", "Calling Mike Johnson…", "Connected",
 * "Call ended" or why not — read from the call's own synced row. Cancel ends it while a phone is still ringing.
 * Once they're talking, Switch to video texts the customer their own link and opens the call here; the phone call
 * keeps going until it's hung up, so nobody is left in silence while they find the link.
 */
export function CallSheetHost() {
  const { business } = useBusiness();
  const { locked } = useLock();
  const request = useCallRequest();
  const { cell } = useMyCell();
  const number = useBusinessNumber(business.id);
  const [state, setState] = React.useState<SheetState>({ kind: 'closed' });
  const [cancelling, setCancelling] = React.useState(false);
  const target = state.kind === 'closed' ? null : state.target;
  const customer = useCustomerName(target);
  const canVideo = useCanStartVideoCall(business.id);
  const video = useStartVideoCall(business.id);
  const videoTarget = useVideoTarget(target);
  // Switch to video starts once this sheet is gone: the call screen can't open over it.
  const switching = React.useRef<VideoCallTarget | null>(null);

  const start = React.useCallback(
    async (next: CallTarget) => {
      if (!networkSnapshot().online) {
        toast.error(NEEDS_SIGNAL);
        return;
      }
      if (!cell?.verifiedAt) {
        // No verified cell: My cell phone first, and it offers the call once the cell is verified.
        router.push(myCellHref(business.id, next));
        return;
      }
      setState({ kind: 'starting', target: next });
      try {
        const result = await change('call.connect_me', { workspaceId: business.id, ...next });
        setState({
          kind: 'calling',
          target: next,
          callId: result.output.callId,
          cell: result.output.cell,
          callerId: result.output.callerId,
        });
      } catch (error) {
        const rule = error instanceof ChangeError ? (refusalOf(error.body)?.rule ?? null) : null;
        if (rule === 'no_verified_cell') {
          setState({ kind: 'closed' });
          router.push(myCellHref(business.id, next));
          return;
        }
        setState({
          kind: 'refused',
          target: next,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [business.id, cell?.verifiedAt],
  );

  // A call asked for (here or by a notification's Call, for this business), once the app is unlocked.
  React.useEffect(() => {
    if (!request || locked) return;
    const taken = callRequests.take(business.id);
    if (taken) void start(taken.target);
  }, [request, locked, business.id, start]);

  const callId = state.kind === 'calling' ? state.callId : '';
  const { data: rows } = useQuery<CallRow>(
    'SELECT status, answered_via, answered_by_user_id, answered_at FROM calls WHERE id = ?',
    [callId],
  );
  const row = rows[0];
  // Until the call's row reaches the phone (a moment), HandsFreeOS is calling the person's cell.
  const status: BridgeStatus | null =
    state.kind === 'calling'
      ? row
        ? (bridgeStatusOf({
            status: row.status,
            answeredVia: row.answered_via,
            answeredByUserId: row.answered_by_user_id,
            answeredAt: row.answered_at,
          }) ?? 'calling_cell')
        : 'calling_cell'
      : state.kind === 'starting'
        ? 'calling_cell'
        : null;

  const close = () => {
    setState({ kind: 'closed' });
    setCancelling(false);
  };

  const cancel = async () => {
    if (state.kind !== 'calling') return;
    setCancelling(true);
    try {
      await change('call.cancel_connect', { workspaceId: business.id, callId: state.callId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  };

  const words =
    status !== null
      ? callSheetWords({
          status,
          customerName: customer,
          cell: state.kind === 'calling' ? state.cell : (cell?.e164 ?? null),
          callerId: state.kind === 'calling' ? state.callerId : (number?.e164 ?? null),
          businessName: business.name,
        })
      : null;
  const over = status !== null && bridgeOver(status);
  const title =
    state.kind === 'refused'
      ? state.message
      : status !== null
        ? bridgeStatusWords(status, customer)
        : '';
  const bad =
    state.kind === 'refused' ||
    status === 'cell_unanswered' ||
    status === 'customer_unanswered' ||
    status === 'customer_busy' ||
    status === 'failed';

  const switchToVideo = () => {
    switching.current = videoTarget;
    close();
  };
  const onClosed = () => {
    const next = switching.current;
    switching.current = null;
    if (next) void video.start(next, { after: VIDEO_CALL_WORDS.switchHint });
  };

  return (
    <>
      <Sheet open={state.kind !== 'closed'} onClose={close} onClosed={onClosed} testID="call-sheet">
        {state.kind === 'closed' ? null : (
          <View className="items-center gap-1 pb-1 pt-1">
            <CallMark icon={bad ? PhoneMissed : PhoneCall} tone={bad ? 'warning' : 'success'} />
            <Text
              className="mt-3 text-center text-xl font-semibold tracking-[-0.2px]"
              testID="call-sheet-status"
              accessibilityLiveRegion="polite"
            >
              {title}
            </Text>
            {words?.hint && state.kind !== 'refused' ? (
              <Text
                className="text-center text-[15px] leading-[22px] text-text-2"
                testID="call-sheet-hint"
              >
                {words.hint}
              </Text>
            ) : null}
          </View>
        )}
        {words && state.kind !== 'refused' && !over ? (
          <View className="mt-4 overflow-hidden rounded-card border border-border">
            <DetailRow icon={Smartphone} label={words.cellLabel} value={words.cell} />
            <View className="h-px bg-border" />
            <DetailRow icon={Building} label={words.seesLabel} value={words.sees} />
          </View>
        ) : null}
        <View className="mt-4 gap-2">
          {status === 'connected' && canVideo && videoTarget ? (
            <Button
              icon={Video}
              loading={video.busy}
              onPress={switchToVideo}
              testID="call-sheet-switch-to-video"
            >
              {VIDEO_CALL_WORDS.switchToVideo}
            </Button>
          ) : null}
          {status !== null && CANCELLABLE_BRIDGE.has(status) && state.kind === 'calling' ? (
            <Button
              variant="secondary"
              icon={X}
              loading={cancelling}
              onPress={() => void cancel()}
              testID="call-sheet-cancel"
            >
              {CALL_SHEET_WORDS.cancel}
            </Button>
          ) : state.kind === 'starting' ? (
            <Button variant="secondary" icon={X} loading disabled testID="call-sheet-starting">
              {CALL_SHEET_WORDS.cancel}
            </Button>
          ) : (
            <Button variant="secondary" onPress={close} testID="call-sheet-close">
              {CALL_SHEET_WORDS.close}
            </Button>
          )}
        </View>
      </Sheet>
      {video.sheet}
    </>
  );
}

function CallMark({ icon, tone }: { icon: LucideIcon; tone: 'success' | 'warning' }) {
  return (
    <View
      className={cn(
        'size-[76px] items-center justify-center rounded-full',
        tone === 'success' ? 'bg-success-soft' : 'bg-warning-soft',
      )}
    >
      <View
        className={cn(
          'size-[60px] items-center justify-center rounded-full border-2',
          tone === 'success' ? 'border-success' : 'border-warning',
        )}
      >
        <Icon
          as={icon}
          className={cn('size-7', tone === 'success' ? 'text-success-text' : 'text-warning-text')}
        />
      </View>
    </View>
  );
}

function DetailRow({ icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <View className="min-h-[56px] flex-row items-center gap-3 bg-card px-3.5 py-2.5">
      <Icon as={icon} className="size-5 text-text-2" />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-medium">{label}</Text>
        <Text className="text-[13px] text-text-3">{value}</Text>
      </View>
    </View>
  );
}
