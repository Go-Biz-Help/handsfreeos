import { legalHoldBanner, LEGAL_HOLD_WORDS, type LegalHoldLike } from '@hfos/core';
import { EXPORT_WORDS, exportLine } from '@hfos/core/addons/realestate/keeping-words';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import {
  RE_DEAL_WORDS,
  RE_EXPORT_PHONE_WORDS,
} from '@hfos/core/addons/realestate/phone-words-deals';
import { useQuery } from '@powersync/react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import {
  ArrowRight,
  ChevronRight,
  Download,
  Globe,
  Lock,
  MessageSquareText,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { signedUrl } from '@/inbox/storage';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { exportDeal, liftHold, placeHold } from './deal-actions';
import { Footnote } from './deal-bits';
import { SignalButton, useLiveAnswer } from './kit';

/**
 * A deal's More (board 78's last panel) and what it opens (board 93): a client update the AI writes, the next stage,
 * the whole transaction exported, a legal hold placed or lifted, and the web. Anything HandsFreeOS has to check first
 * (the AI, export, holds) needs signal and says so; the rest works with no signal and sends later.
 */

export interface DealHold extends LegalHoldLike {
  readonly id: string;
}

/** The deal's legal hold, asked for with signal (holds aren't kept on the phone). */
export function useDealHold(workspaceId: string, dealId: string) {
  return useLiveAnswer<DealHold | null>(
    () =>
      api
        .POST('/v1/queries/record_hold.list', {
          body: { workspaceId, customRecordId: dealId, kind: 'legal' },
        })
        .then((r) => {
          const hold = unwrap(r).holds.find((h) => h.kind === 'legal');
          return hold
            ? { id: hold.id, placedAt: hold.placedAt, reason: hold.reason, placedBy: hold.placedBy }
            : null;
        }),
    `hold:${dealId}`,
    RE_PHONE_WORDS.needsSignal,
  );
}

/** "On legal hold since Oct 1. …": while the deal is held. A hold freezes what's there; work goes on. */
export function HoldBanner({
  hold,
  timeZone,
  onLift,
}: {
  hold: DealHold;
  timeZone: string;
  onLift?: () => void;
}) {
  const words = legalHoldBanner(hold, timeZone);
  return (
    <View
      className="flex-row gap-2.5 rounded-card bg-accent-soft px-3.5 py-3"
      testID="re-hold-banner"
    >
      <Icon as={Lock} className="mt-0.5 size-4 text-accent-text" />
      <View className="flex-1 gap-1">
        <Text className="text-[13.5px] leading-[19px] text-text">
          <Text className="text-[13.5px] font-semibold text-accent-text">{words.title}</Text>{' '}
          {words.body}
        </Text>
        {onLift ? (
          <Pressable role="button" onPress={onLift} testID="re-hold-lift" hitSlop={6}>
            <Text className="text-[13px] font-medium text-accent-text">
              {LEGAL_HOLD_WORDS.lift}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function MoreRow({
  icon,
  label,
  detail,
  onPress,
  needsSignal,
  testID,
}: {
  icon: React.ComponentProps<typeof Icon>['as'];
  label: string;
  detail: string;
  onPress: () => void;
  needsSignal?: boolean;
  testID?: string;
}) {
  const { online } = useNetwork();
  const off = needsSignal && !online;
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${label}. ${off ? RE_PHONE_WORDS.needsSignal : detail}`}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      testID={testID}
      className={cn(
        'min-h-14 flex-row items-center gap-3.5 py-2 active:bg-card-2',
        off && 'opacity-50',
      )}
    >
      <Icon as={icon} className="size-5 text-text-2" />
      <View className="min-w-0 flex-1 gap-px">
        <Text className="text-base">{label}</Text>
        <Text className="text-[13px] text-text-3">{off ? RE_PHONE_WORDS.needsSignal : detail}</Text>
      </View>
      <Icon as={ChevronRight} className="size-4 text-text-3" />
    </Pressable>
  );
}

export function DealMoreSheet({
  open,
  onClose,
  dealName,
  nextStage,
  atClosing,
  live,
  canExport,
  canHold,
  held,
  onUpdate,
  onNextStage,
  onExport,
  onHold,
  onWeb,
}: {
  open: boolean;
  onClose: () => void;
  dealName: string;
  /** The stage after this one, in words; null when there's none to move to. */
  nextStage: string | null;
  atClosing: boolean;
  live: boolean;
  canExport: boolean;
  canHold: boolean;
  held: boolean;
  onUpdate: () => void;
  onNextStage: () => void;
  onExport: () => void;
  onHold: () => void;
  onWeb: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={dealName} scroll testID="re-deal-more">
      <View className="pt-2">
        {live ? (
          <MoreRow
            icon={MessageSquareText}
            label={RE_DEAL_WORDS.writeUpdate}
            detail={RE_DEAL_WORDS.writeUpdateLine}
            onPress={onUpdate}
            needsSignal
            testID="re-more-update"
          />
        ) : null}
        {live && atClosing ? (
          <MoreRow
            icon={ArrowRight}
            label={RE_DEAL_WORDS.closeOnWeb}
            detail={RE_DEAL_WORDS.closeOnWebLine}
            onPress={onWeb}
            testID="re-more-close"
          />
        ) : live && nextStage ? (
          <MoreRow
            icon={ArrowRight}
            label={RE_DEAL_WORDS.nextStage}
            detail={nextStage}
            onPress={onNextStage}
            needsSignal
            testID="re-more-stage"
          />
        ) : null}
        {canExport ? (
          <MoreRow
            icon={Download}
            label={EXPORT_WORDS.title}
            detail={RE_DEAL_WORDS.exportLine}
            onPress={onExport}
            needsSignal
            testID="re-more-export"
          />
        ) : null}
        {canHold ? (
          <MoreRow
            icon={Lock}
            label={held ? RE_DEAL_WORDS.liftTitle : RE_DEAL_WORDS.holdTitle}
            detail={RE_DEAL_WORDS.holdLine}
            onPress={onHold}
            needsSignal
            testID="re-more-hold"
          />
        ) : null}
        <MoreRow
          icon={Globe}
          label={RE_DEAL_WORDS.openOnWeb}
          detail={RE_DEAL_WORDS.openOnWebLine}
          onPress={onWeb}
          testID="re-more-web"
        />
        <Footnote>{RE_DEAL_WORDS.moreFooter}</Footnote>
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------- export

type DealExport = {
  readonly id: string;
  readonly state: 'building' | 'ready' | 'failed';
  readonly fileId: string | null;
  readonly counts: Readonly<Record<string, unknown>>;
  readonly failure: string | null;
};

/** The file a ready export made, as the phone keeps the deal's files: where it is, to fetch it with signal. */
const EXPORT_FILE_SQL = 'SELECT id, name, bucket, object_path, size_bytes FROM files WHERE id = ?';

export function ExportSheet({
  open,
  onClose,
  workspaceId,
  dealId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
}) {
  const exports = useLiveAnswer<readonly DealExport[]>(
    open
      ? () =>
          api
            .POST('/v1/queries/realestate.exports', { body: { workspaceId, dealId } })
            .then((r) => unwrap(r).exports as readonly DealExport[])
      : null,
    `exports:${dealId}`,
    EXPORT_WORDS.needsSignal,
  );
  const latest = exports.data?.[0] ?? null;
  const making = latest?.state === 'building';
  // The worker makes it in a minute or so: look again until it has.
  React.useEffect(() => {
    if (!open || !making) return;
    const t = setInterval(exports.reload, 3000);
    return () => clearInterval(t);
  }, [open, making, exports.reload]);
  const { data: files } = useQuery<{
    id: string;
    name: string;
    bucket: string | null;
    object_path: string | null;
    size_bytes: number | null;
  }>(EXPORT_FILE_SQL, [latest?.fileId ?? '']);
  return (
    <ExportSheetView
      open={open}
      onClose={onClose}
      latest={latest}
      file={latest?.fileId ? (files[0] ?? null) : null}
      onMake={async () => {
        try {
          await exportDeal(workspaceId, dealId);
          toast.show(EXPORT_WORDS.asked);
          exports.reload();
        } catch (e) {
          toast.error(errorMessage(e));
        }
      }}
    />
  );
}

export function ExportSheetView({
  open,
  onClose,
  latest,
  file,
  onMake,
}: {
  open: boolean;
  onClose: () => void;
  latest: DealExport | null;
  file: {
    readonly name: string;
    readonly bucket: string | null;
    readonly object_path: string | null;
    readonly size_bytes: number | null;
  } | null;
  onMake: () => void;
}) {
  const [sharing, setSharing] = React.useState(false);
  const share = async () => {
    if (!file?.bucket || !file.object_path) {
      toast.error(RE_EXPORT_PHONE_WORDS.notOnPhone);
      return;
    }
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error(RE_EXPORT_PHONE_WORDS.noSharing);
      const url = await signedUrl(file.bucket, file.object_path);
      if (!url) throw new Error(RE_EXPORT_PHONE_WORDS.failed);
      const saved = await File.downloadFileAsync(url, new File(Paths.cache, file.name), {
        idempotent: true,
      });
      await Sharing.shareAsync(saved.uri, { mimeType: 'application/zip', dialogTitle: file.name });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : RE_EXPORT_PHONE_WORDS.failed);
    } finally {
      setSharing(false);
    }
  };
  const files = typeof latest?.counts.files === 'number' ? latest.counts.files : null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={EXPORT_WORDS.title}
      description={EXPORT_WORDS.about}
      testID="re-export"
    >
      <View className="gap-3 pt-3">
        {latest ? (
          <Card className="gap-1 px-3.5 py-3" testID="re-export-latest">
            <View className="flex-row items-start gap-2">
              <Text className="flex-1 text-[14.5px] font-semibold">
                {file?.name ??
                  (latest.state === 'building' ? EXPORT_WORDS.making : EXPORT_WORDS.title)}
              </Text>
              <Badge
                variant={
                  latest.state === 'ready' ? 'ok' : latest.state === 'failed' ? 'danger' : 'pending'
                }
                testID="re-export-state"
              >
                <Text>{EXPORT_WORDS.states[latest.state]}</Text>
              </Badge>
            </View>
            <Text className="text-[13px] text-text-3">
              {latest.state === 'ready'
                ? exportLine({ files, sizeBytes: file?.size_bytes ?? null })
                : latest.state === 'failed'
                  ? (latest.failure ?? EXPORT_WORDS.failedLine)
                  : EXPORT_WORDS.makingLine}
            </Text>
          </Card>
        ) : null}
        {latest?.state === 'ready' ? (
          <SignalButton
            label={sharing ? RE_EXPORT_PHONE_WORDS.sharing : RE_EXPORT_PHONE_WORDS.share}
            why={EXPORT_WORDS.needsSignal}
            disabled={sharing}
            onPress={() => void share()}
            testID="re-export-share"
          />
        ) : latest?.state === 'building' ? null : (
          <SignalButton
            label={EXPORT_WORDS.submit}
            why={EXPORT_WORDS.needsSignal}
            onPress={onMake}
            testID="re-export-make"
          />
        )}
        <Footnote>{EXPORT_WORDS.needsSignal}</Footnote>
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------- holds

export function HoldSheet({
  open,
  onClose,
  workspaceId,
  dealId,
  dealName,
  hold,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  dealName: string;
  /** Lifting the hold that's on, or placing one. */
  hold: DealHold | null;
  onDone: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const colors = useColors();
  const lifting = hold !== null;
  const submit = async () => {
    try {
      if (lifting) await liftHold(workspaceId, hold.id, reason);
      else await placeHold(workspaceId, dealId, reason);
      toast.show(lifting ? LEGAL_HOLD_WORDS.liftDone : LEGAL_HOLD_WORDS.placeDone);
      setReason('');
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={lifting ? LEGAL_HOLD_WORDS.liftTitle(dealName) : LEGAL_HOLD_WORDS.placeTitle(dealName)}
      description={lifting ? LEGAL_HOLD_WORDS.liftAbout : LEGAL_HOLD_WORDS.placeAbout}
      testID="re-hold-sheet"
    >
      <View className="gap-2.5 pt-3">
        <Text className="text-[13px] font-medium text-text-2">{RE_DEAL_WORDS.holdReason}</Text>
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={RE_DEAL_WORDS.holdReasonPlaceholder}
          placeholderTextColor={colors.placeholder}
          className="min-h-12 rounded-menu border border-border-strong bg-card px-3.5 py-3 font-sans text-base text-text"
          testID="re-hold-reason"
        />
        <SignalButton
          label={lifting ? LEGAL_HOLD_WORDS.liftSubmit : LEGAL_HOLD_WORDS.placeSubmit}
          why={lifting ? RE_DEAL_WORDS.liftWhy : RE_DEAL_WORDS.holdWhy}
          variant={lifting ? 'secondary' : 'primary'}
          disabled={!reason.trim()}
          onPress={() => void submit()}
          testID="re-hold-submit"
        />
        <Button variant="ghost" onPress={onClose}>
          {RE_DEAL_WORDS.notNow}
        </Button>
      </View>
    </Sheet>
  );
}
