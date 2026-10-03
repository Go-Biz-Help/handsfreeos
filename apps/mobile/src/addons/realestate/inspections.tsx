import { fmtMonthDay, fmtTime, localDayOf } from '@hfos/core';
import {
  FINDING_ASKS,
  FINDING_SEVERITIES,
  FINDING_SEVERITY_KEYS,
  type FindingSeverity,
} from '@hfos/core/addons/realestate/closing';
import { RE_INSPECTION_WORDS as W } from '@hfos/core/addons/realestate/phone-words-closing';
import {
  inspectionsOfCopy,
  type InspectionsView,
} from '@hfos/core/addons/realestate/views/closing';
import * as React from 'react';
import { TextInput, View } from 'react-native';

import { Plus } from '@/components/icons';
import { List, ListLabel } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useColors } from '@/theme';

import { addFinding, sendRepairRequest } from './closing-actions';
import { SignalButton } from './kit';
import {
  DealSubpage,
  FieldError,
  FieldLabel,
  PhotoFrame,
  SignalNote,
  keepDealPhoto,
  SummaryAnswer,
  uploadDealPhoto,
  useDealPage,
  type KeptDealPhoto,
  useSummaryAnswer,
} from './subpage';

/**
 * A deal's inspections on the phone (board 85, second and third panels): each inspection with its report and how
 * many findings, and the findings with how serious each is and what to ask for. A finding is added at the inspection,
 * often in a basement with no signal: it waits on the phone, and its photos (on the deal's files) upload later and
 * the finding waits for them. The repair request is drafted from the findings and sent with signal.
 */

type Inspection = InspectionsView['inspections'][number];
type Finding = Inspection['findings'][number];

export function InspectionsScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const view = React.useMemo(
    () => inspectionsOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () => ({
      ...unwrap(
        await api.POST('/v1/queries/realestate.inspections', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
      full: true,
    }),
    `inspections:${dealId}`,
    'inspections',
  );
  const [adding, setAdding] = React.useState<Inspection | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  const findings = view?.inspections.flatMap((i) => i.findings) ?? [];
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-inspections"
    >
      {whole && view ? (
        <InspectionsBody
          view={view}
          timeZone={ctx.timeZone}
          onAdd={setAdding}
          onDraft={() => setDrafting(true)}
        />
      ) : (
        <SummaryAnswer answer={server} what="inspections">
          {(data) => <InspectionsBody view={data} timeZone={ctx.timeZone} />}
        </SummaryAnswer>
      )}
      <FindingSheet
        inspection={adding}
        onClose={() => setAdding(null)}
        onPhoto={() => keepDealPhoto(ctx.userId, 'camera')}
        onAdd={async (f, photos) => {
          if (!adding) return;
          // The photos go on the deal's files first; the finding names them and waits for them.
          const uploads: string[] = [];
          for (const [i, photo] of photos.entries())
            uploads.push(
              await uploadDealPhoto({
                workspaceId: ctx.workspaceId,
                dealId,
                photo,
                name: `${f.title} ${i + 1}.jpg`,
              }),
            );
          await addFinding({
            workspaceId: ctx.workspaceId,
            dealId,
            inspectionId: adding.id,
            title: f.title,
            location: f.location,
            severity: f.severity,
            position: findings.length,
            photoFileIds: photos.map((p) => p.fileId),
            dependsOn: uploads,
          });
          toast.show(W.added);
        }}
      />
      {view ? (
        <RepairSheet
          open={drafting}
          draft={view.draft.words}
          onClose={() => setDrafting(false)}
          onSend={async (words) => {
            await sendRepairRequest({ workspaceId: ctx.workspaceId, dealId, words });
            toast.show(W.sent);
          }}
        />
      ) : null}
    </DealSubpage>
  );
}

const SEVERITY_BADGE: Readonly<Record<FindingSeverity, 'danger' | 'pending' | 'gray'>> = {
  safety: 'danger',
  repair: 'pending',
  minor: 'gray',
};

/** "Over the back porch · ask for repair", "Note for the buyers". */
export function findingLine(f: Finding): string {
  const ask = f.ask === 'not_asked' ? f.note : W.askFor(FINDING_ASKS[f.ask]);
  const parts = [f.location, ask].filter((p): p is string => !!p);
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** "Sep 30, 9:00 AM · 6 findings · period ends Oct 3" */
export function inspectionLine(i: Inspection, periodEnds: string | null, timeZone: string): string {
  return [
    i.scheduledAt
      ? `${fmtMonthDay(localDayOf(i.scheduledAt, timeZone))}, ${fmtTime(i.scheduledAt, timeZone)}`
      : null,
    W.findingCount(i.findings.length),
    periodEnds ? W.periodEnds(fmtMonthDay(periodEnds)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function InspectionsBody({
  view,
  timeZone,
  onAdd,
  onDraft,
}: {
  view: InspectionsView;
  timeZone: string;
  onAdd?: (inspection: Inspection) => void;
  onDraft?: () => void;
}) {
  const active = view.inspections.filter((i) => i.status !== 'canceled');
  const findings = active.flatMap((i) => i.findings);
  // Findings go on the newest inspection still on: the one at the home today.
  const current = active.at(-1) ?? null;
  return (
    <View className="gap-3" testID="inspections-body">
      {active.length === 0 ? (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.none}</Text>
        </Card>
      ) : (
        active.map((i) => (
          <Card key={i.id} className="gap-1 p-4" testID="inspection-card">
            <View className="flex-row items-start justify-between gap-2">
              <Text className="flex-1 text-[15px] font-semibold">{i.inspector ?? i.label}</Text>
              {i.status === 'report_in' ? (
                <Badge variant="ok">{W.reportIn}</Badge>
              ) : i.scheduledAt ? (
                <Badge variant="pending">{fmtMonthDay(localDayOf(i.scheduledAt, timeZone))}</Badge>
              ) : (
                <Badge variant="gray">{W.notBooked}</Badge>
              )}
            </View>
            <Text className="text-[13.5px] text-text-2">
              {inspectionLine(i, view.periodEnds, timeZone)}
            </Text>
          </Card>
        ))
      )}
      {active.length ? (
        <>
          <ListLabel>{`${W.findings}  ${findings.length}`}</ListLabel>
          {findings.length ? (
            <List testID="inspection-findings">
              {findings.map((f) => (
                <View key={f.id} className="flex-row items-center gap-3 py-2.5 pl-3 pr-4">
                  {f.photoFileIds.length ? (
                    <PhotoFrame
                      className="w-12"
                      label={f.photoFileIds.length > 1 ? String(f.photoFileIds.length) : undefined}
                      testID={`finding-photos-${f.id}`}
                    />
                  ) : null}
                  <View className="min-w-0 flex-1 gap-px">
                    <Text className="text-base">{f.title}</Text>
                    <Text className="text-[13px] leading-[18px] text-text-3">{findingLine(f)}</Text>
                  </View>
                  <Badge variant={SEVERITY_BADGE[f.severity]}>
                    {FINDING_SEVERITIES[f.severity]}
                  </Badge>
                </View>
              ))}
            </List>
          ) : (
            <Text className="px-1 text-[13.5px] text-text-3">{W.noFindings}</Text>
          )}
        </>
      ) : null}
      {onAdd && current ? (
        <Button
          variant="secondary"
          icon={Plus}
          onPress={() => onAdd(current)}
          testID="inspection-add-finding"
        >
          {W.addFinding}
        </Button>
      ) : null}
      {onDraft && active.length ? (
        <SignalButton
          label={W.draft}
          why={W.draftWhy}
          disabled={!view.draft.items}
          onPress={onDraft}
          testID="inspection-draft"
        />
      ) : null}
    </View>
  );
}

export interface NewFinding {
  readonly title: string;
  readonly location: string | null;
  readonly severity: FindingSeverity;
}

/** Adding a finding at the inspection: photos, what, where and how serious. */
export function FindingSheet({
  inspection,
  onClose,
  onPhoto,
  onAdd,
}: {
  inspection: Inspection | null;
  onClose: () => void;
  /** Takes a photo and keeps it on the phone; it goes with the finding when it's added. */
  onPhoto: () => Promise<KeptDealPhoto | null>;
  onAdd: (finding: NewFinding, photos: readonly KeptDealPhoto[]) => Promise<void>;
}) {
  const [title, setTitle] = React.useState('');
  const [where, setWhere] = React.useState('');
  const [severity, setSeverity] = React.useState<FindingSeverity>('repair');
  const [photos, setPhotos] = React.useState<KeptDealPhoto[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!inspection) return;
    setTitle('');
    setWhere('');
    setSeverity('repair');
    setPhotos([]);
    setError(null);
  }, [inspection]);
  const add = async () => {
    if (!title.trim()) {
      setError(W.sayWhat);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd({ title: title.trim(), location: where.trim() || null, severity }, photos);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={!!inspection} onClose={onClose} title={W.addFinding} testID="finding-sheet">
      <View className="gap-3">
        <View className="flex-row gap-2">
          {photos.map((_, i) => (
            <PhotoFrame key={i} label={W.photo(i + 1)} className="flex-1" />
          ))}
          {photos.length < 3 ? (
            <PhotoFrame
              className="flex-1"
              onPress={() =>
                void onPhoto().then((p) => {
                  if (p) setPhotos((was) => [...was, p]);
                })
              }
              testID="finding-photo"
            />
          ) : null}
          {Array.from({ length: Math.max(0, 2 - photos.length) }, (_, i) => (
            <View key={`gap-${i}`} className="flex-1" />
          ))}
        </View>
        {photos.length ? <SignalNote>{W.waiting}</SignalNote> : null}
        <FieldLabel>{W.what}</FieldLabel>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder={W.whatHint}
          invalid={!!error && !title.trim()}
          testID="finding-what"
        />
        <FieldLabel>{W.where}</FieldLabel>
        <Input
          value={where}
          onChangeText={setWhere}
          placeholder={W.whereHint}
          testID="finding-where"
        />
        <FieldLabel>{W.howSerious}</FieldLabel>
        <Segmented
          label={W.howSerious}
          value={severity}
          onChange={setSeverity}
          options={FINDING_SEVERITY_KEYS.map((k) => ({
            value: k,
            label: FINDING_SEVERITIES[k],
            testID: `finding-severity-${k}`,
          }))}
        />
        <FieldError testID="finding-error">{error}</FieldError>
        <Button loading={busy} onPress={() => void add()} testID="finding-add">
          {W.add}
        </Button>
      </View>
    </Sheet>
  );
}

/** The repair request, drafted from the findings, edited, and sent with signal. */
export function RepairSheet({
  open,
  draft,
  onClose,
  onSend,
}: {
  open: boolean;
  draft: string;
  onClose: () => void;
  onSend: (words: string) => Promise<void>;
}) {
  const colors = useColors();
  const [words, setWords] = React.useState(draft);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setWords(draft);
      setError(null);
    }
  }, [open, draft]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={W.draft}
      description={W.draftAbout}
      testID="repair-sheet"
    >
      <View className="gap-3">
        <TextInput
          multiline
          value={words}
          onChangeText={setWords}
          className="min-h-40 rounded-menu border border-border-strong bg-card p-3 font-sans text-base text-text"
          textAlignVertical="top"
          placeholderTextColor={colors.placeholder}
          placeholder={W.nothingToAsk}
          testID="repair-words"
        />
        <FieldError>{error}</FieldError>
        <SignalButton
          label={W.send}
          why={W.draftWhy}
          disabled={busy || !words.trim()}
          onPress={() => {
            setBusy(true);
            setError(null);
            onSend(words.trim())
              .then(onClose)
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
          testID="repair-send"
        />
      </View>
    </Sheet>
  );
}
