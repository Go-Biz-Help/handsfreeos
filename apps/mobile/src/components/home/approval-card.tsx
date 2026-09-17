import {
  approvalAsked,
  approvalCustomerOf,
  approvalDecidedToast,
  approvalExpiresIn,
  approvalFieldLabel,
  approvalPreviewOf,
  APPROVALS_WORDS,
  approvalSegmentLabel,
  approvalTitle,
  minutesSince,
  waitingFor,
  type ApprovalFacts,
} from '@hfos/core';
import * as React from 'react';
import { TextInput, View } from 'react-native';

import { BookOpen, Check, Clock, FileText, Info, ShieldCheck } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { change, ChangeError } from '@/changes';
import { networkSnapshot } from '@/lib/network';
import { cn } from '@/lib/utils';
import { openWebPath } from '@/home/open';
import { HOME_PHONE_WORDS } from '@/home/words';
import { useColors } from '@/theme';

const SECTION = 'text-xs font-semibold uppercase tracking-[0.5px] text-text-3';

/**
 * A workflow's approval step waiting for this person's yes, as the web's Approvals card shows it at phone width: what
 * will happen (the AI-written text, editable), the customer and what they said, the knowledge used, who was asked and
 * how long it has waited, and the time left. Approve and Reject go through `change('workflow.decide_approval')`: fresh
 * for 30 minutes, so with no signal it waits and then asks "Still send?".
 */
export function WorkflowApprovalCard({
  a,
  workspaceId,
  now,
}: {
  a: ApprovalFacts;
  workspaceId: string;
  now: number;
}) {
  const colors = useColors();
  const p = React.useMemo(() => approvalPreviewOf(a), [a]);
  const [texts, setTexts] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(p.fields),
  );
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const who = approvalCustomerOf(a, p);
  const first = who.split(/\s+/)[0] || who;
  const expires = approvalExpiresIn(a.expiresAt, now);
  const expired = expires === 'Expired';
  const textOf = (key: string, original: string) => texts[key] ?? original;
  const blank = p.fields.some(([k, v]) => !textOf(k, v).trim());
  const sends = p.fields.length > 0 && p.channel !== null;
  const byline = `${a.workflow.name} · ${approvalAsked(a.approvers)} · ${waitingFor(minutesSince(a.createdAt, now))}`;

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    const edits = Object.fromEntries(
      p.fields.filter(([k, v]) => textOf(k, v) !== v).map(([k, v]) => [k, textOf(k, v).trim()]),
    );
    try {
      await change(
        'workflow.decide_approval',
        {
          workspaceId,
          approvalId: a.id,
          decision,
          ...(decision === 'approve' && Object.keys(edits).length ? { edits } : {}),
          ...(decision === 'reject' && reason.trim() ? { reason: reason.trim() } : {}),
        },
        {
          optimistic: (tx) =>
            tx.execute('UPDATE workflow_approvals SET status = ? WHERE id = ?', [
              decision === 'approve' ? 'approved' : 'rejected',
              a.id,
            ]),
        },
      );
      const done = approvalDecidedToast(decision, sends);
      toast.show(networkSnapshot().online ? done : HOME_PHONE_WORDS.queued(done));
      setRejecting(false);
    } catch (error) {
      toast.error(
        error instanceof ChangeError || error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <View
      testID="approval-card"
      className="gap-3 rounded-card border bg-card px-4 py-4"
      style={{ borderColor: colors.accent, boxShadow: `0 0 0 3px ${colors.accentSoft}` }}
    >
      <View className="flex-row items-start gap-3">
        <View className="size-[30px] items-center justify-center rounded-control bg-warning-soft">
          <Icon as={ShieldCheck} strokeWidth={1.75} className="size-[15px] text-warning-text" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold leading-[20px]" testID="approval-title">
            {approvalTitle(a, p)}
          </Text>
          <Text className="text-xs text-text-3">{byline}</Text>
        </View>
      </View>
      {expires ? (
        <View
          testID="approval-expires"
          className={cn(
            'flex-row items-center gap-1 self-start rounded-full px-2 py-1',
            expired ? 'bg-danger-soft' : 'bg-warning-soft',
          )}
        >
          <Icon
            as={Clock}
            strokeWidth={1.75}
            className={cn('size-3.5', expired ? 'text-danger-text' : 'text-warning-text')}
          />
          <Text
            className={cn(
              'text-xs font-medium',
              expired ? 'text-danger-text' : 'text-warning-text',
            )}
          >
            {expires}
          </Text>
        </View>
      ) : null}
      {p.note ? (
        <Text className="text-[13.5px] text-text-2" testID="approval-note">
          {p.note}
        </Text>
      ) : null}
      {p.asked ? (
        <View className="gap-1.5">
          <Text className={SECTION}>{APPROVALS_WORDS.latestMessage(first)}</Text>
          <View
            className="self-start rounded-[14px] rounded-bl-[4px] bg-card-2 px-3 py-2"
            testID="approval-asked"
          >
            <Text className="text-[14px] leading-[20px]">{p.asked}</Text>
          </View>
        </View>
      ) : null}
      {p.items.length ? (
        <View className="flex-row flex-wrap items-center gap-1.5" testID="approval-knowledge">
          <Text className="text-xs text-text-3">{APPROVALS_WORDS.knowledgeUsed}</Text>
          {p.items.map((i) => (
            <View
              key={i.id}
              className="flex-row items-center gap-1 rounded-[7px] bg-card-2 px-2 py-[3px]"
            >
              <Icon
                as={i.kind === 'document' ? FileText : BookOpen}
                className="size-3.5 text-text-2"
              />
              <Text numberOfLines={1} className="text-xs font-medium text-text-2">
                {i.title}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {p.fields.length ? (
        p.fields.map(([key, original]) => {
          const value = textOf(key, original);
          return (
            <View key={key} className="gap-1.5">
              <Text className={SECTION}>
                {approvalFieldLabel(p, key)} · {APPROVALS_WORDS.youCanEdit}
              </Text>
              <TextInput
                multiline
                value={value}
                maxLength={5000}
                editable={busy === null && !expired}
                onChangeText={(t) => setTexts((d) => ({ ...d, [key]: t }))}
                testID={`approval-field-${key}`}
                selectionColor={colors.accent}
                className={cn(
                  'min-h-[104px] rounded-menu border bg-card px-3.5 py-2.5 font-sans text-base leading-[22px] text-text',
                  value.trim() ? 'border-border-strong' : 'border-danger',
                )}
                style={{ textAlignVertical: 'top' }}
              />
              <View className="flex-row flex-wrap justify-between gap-x-3">
                <Text className="text-xs text-text-3" testID="approval-edited">
                  {value !== original ? APPROVALS_WORDS.edited : APPROVALS_WORDS.writtenByAi}
                </Text>
                {p.channel === 'sms' ? (
                  <Text className="text-xs text-text-3">{approvalSegmentLabel(value)}</Text>
                ) : null}
              </View>
              {!value.trim() ? (
                <Text role="alert" className="text-[12.5px] text-danger-text">
                  {APPROVALS_WORDS.writeOrReject}
                </Text>
              ) : null}
            </View>
          );
        })
      ) : (
        <Text className="text-[14px] text-text-2">
          {APPROVALS_WORDS.carriesOn(a.workflow.name, who)}
        </Text>
      )}
      <View className="flex-row items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px]">
        <Icon as={Info} className="mt-px size-3.5 text-text-2" />
        <Text className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-text-2">
          {expired ? APPROVALS_WORDS.expiredInfo : APPROVALS_WORDS.expiryInfo}
        </Text>
      </View>
      <View className="gap-2 border-t border-border pt-3">
        <Button
          icon={Check}
          disabled={busy !== null || expired || blank}
          loading={busy === 'approve'}
          onPress={() => void decide('approve')}
          testID="approval-approve"
        >
          {sends ? APPROVALS_WORDS.approveAndSend : APPROVALS_WORDS.approve}
        </Button>
        <View className="flex-row gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={busy !== null || expired}
            onPress={() => setRejecting(true)}
            testID="approval-reject"
          >
            {APPROVALS_WORDS.reject}
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            onPress={() => openWebPath(`/app/w/${workspaceId}/workflows/runs/${a.runId}`)}
            testID="approval-run"
          >
            {APPROVALS_WORDS.openRun}
          </Button>
        </View>
      </View>
      <Sheet
        open={rejecting}
        onClose={() => busy === null && setRejecting(false)}
        title={APPROVALS_WORDS.rejectTitle}
        description={APPROVALS_WORDS.rejectBody(a.workflow.name, who)}
      >
        <View className="mt-4 gap-1.5">
          <Text className="text-[13.5px] font-medium">{APPROVALS_WORDS.rejectWhy}</Text>
          <TextInput
            multiline
            value={reason}
            maxLength={1000}
            placeholder={APPROVALS_WORDS.rejectPlaceholder}
            placeholderTextColor={colors.placeholder}
            onChangeText={setReason}
            testID="reject-reason"
            className="min-h-[72px] rounded-menu border border-border-strong bg-card px-3.5 py-2.5 font-sans text-base text-text"
            style={{ textAlignVertical: 'top' }}
          />
        </View>
        <View className="mt-4 gap-2">
          <Button
            variant="danger"
            loading={busy === 'reject'}
            disabled={busy !== null}
            onPress={() => void decide('reject')}
            testID="reject-confirm"
          >
            {APPROVALS_WORDS.rejectConfirm}
          </Button>
          <Button variant="ghost" disabled={busy !== null} onPress={() => setRejecting(false)}>
            {APPROVALS_WORDS.keepIt}
          </Button>
        </View>
      </Sheet>
    </View>
  );
}
