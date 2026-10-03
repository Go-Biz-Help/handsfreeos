import { fmtTime, localDateOf } from '@hfos/core';
import {
  DOCUMENT_KINDS,
  type DocumentKind,
  type Performer,
} from '@hfos/core/addons/realestate/catalog/types';
import { dutyLogWords } from '@hfos/core/addons/realestate/history-words';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_DUTY_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { dueWords, PERFORMER_LABELS, traceWords } from '@hfos/core/addons/realestate/rule-words';
import { isDoneDuty } from '@hfos/core/addons/realestate/states';
import { documentsOfCopy, type DealDocument } from '@hfos/core/addons/realestate/views/documents';
import {
  dutySheetOfCopy,
  proofChecklistOfCopy,
  type DutySheet,
  type ProofChecklist,
} from '@hfos/core/addons/realestate/views/duty-sheet';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Camera, Check, FileText, Paperclip } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { deviceStore } from '@/lib/device-store';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { useRealestateCopy } from './copy';
import { addEvidence, addPhotoEvidence, completeDuty, completeWithException } from './deal-actions';
import { Footnote, GroupLabel, useReChanges, WaitStrip, type ReChange } from './deal-bits';
import { NeedsSignalCard, RE_EXCEPT, SignalButton, useReContext } from './kit';

/**
 * A duty (board 79): what it is and when it's due, its proof checklist first, and doing it with no signal. A photo, a
 * file or a note goes on at once and waits to send; Mark done turns on once each proof is there, and is done on the
 * phone straight away, marked as waiting. Marking it done without its proof is an owner's or admin's, and needs signal;
 * the reason can be kept on the phone until there is some.
 */

export interface DutyRef {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dealId: string;
  readonly dutyId: string;
}

/** Where a reason kept for later sits on this phone. */
export const keptKey = (dutyId: string) => `realestate.exception.${dutyId}`;

export function DutyScreen({ dutyId, dealId }: { dutyId: string; dealId?: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(
    ctx.workspaceId,
    dealId ? { kind: 'deal', dealId } : { kind: 'all' },
  );
  const changes = useReChanges(ctx.workspaceId);
  const sheet = React.useMemo(() => dutySheetOfCopy(copy, dutyId, ctx), [copy, dutyId, ctx]);
  const checklist = React.useMemo(
    () => proofChecklistOfCopy(copy, dutyId, ctx),
    [copy, dutyId, ctx],
  );
  const documents = React.useMemo(
    () => (sheet ? documentsOfCopy(copy, sheet.duty.dealId) : []),
    [copy, sheet],
  );
  return (
    <DutyView
      sheet={sheet}
      checklist={checklist}
      documents={documents}
      changes={changes}
      userId={ctx.userId}
      workspaceId={ctx.workspaceId}
      timeZone={ctx.timeZone}
      now={ctx.now}
      canExcept={ctx.holds(RE_EXCEPT)}
    />
  );
}

export function DutyView({
  sheet,
  checklist,
  documents,
  changes,
  userId,
  workspaceId,
  timeZone,
  now,
  canExcept,
}: {
  sheet: DutySheet | null;
  checklist: ProofChecklist | null;
  documents: readonly DealDocument[];
  changes: readonly ReChange[];
  userId: string;
  workspaceId: string;
  timeZone: string;
  now: number;
  canExcept: boolean;
}) {
  const [adding, setAdding] = React.useState<'photo' | 'other' | 'except' | null>(null);
  const [kept, setKept] = React.useState<string | null>(() =>
    sheet ? (deviceStore.get<string>(keptKey(sheet.duty.dutyId)) ?? null) : null,
  );
  if (!sheet || !checklist)
    return (
      <Screen title={RE_DUTY_WORDS.title} leading="back" testID="re-duty">
        <NeedsSignalCard words={RE_DUTY_WORDS.notHere} testID="re-duty-missing" />
      </Screen>
    );
  const d = sheet.duty;
  const ref: DutyRef = { workspaceId, userId, dealId: d.dealId, dutyId: d.dutyId };
  const mine = changes.filter((c) => c.input.dutyId === d.dutyId);
  const doneWaits = mine.some((c) => c.name === 'realestate.duty.complete');
  const evidenceWaits = new Set(
    mine
      .filter((c) => c.name === 'realestate.duty.add_evidence')
      .map((c) => c.input.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const done = isDoneDuty(d.status);
  const open = !done && d.status !== 'draft' && d.status !== 'pending_approval';
  const tracking = d.accountable?.userId === userId;
  const performers = d.performers.map((p) => PERFORMER_LABELS[p as Performer] ?? p);
  const today = localDateOf(now, timeZone);
  const dueToday = d.dueAt !== null && localDateOf(Date.parse(d.dueAt), timeZone) === today;
  const due = d.dueAt
    ? `${dueWords(d.dueAt, timeZone, { now, open: !done })}${d.overdue ? '' : ` ${fmtTime(d.dueAt, timeZone)}`}`
    : null;
  const line = [
    d.dealName,
    performers.length || tracking ? RE_DUTY_WORDS.performers(performers, tracking) : null,
    due,
  ]
    .filter(Boolean)
    .join(' · ');

  const unmetDoc = checklist.items.find((i) => !i.met && i.item.kind === 'document');
  const asDocument =
    unmetDoc && unmetDoc.item.kind === 'document'
      ? {
          kind: unmetDoc.item.documents[0]! as DocumentKind,
          title: DOCUMENT_KINDS[unmetDoc.item.documents[0]! as DocumentKind],
        }
      : null;
  const attestations = checklist.items.flatMap((i) =>
    !i.met && i.item.kind === 'attestation' ? [i.item.words] : [],
  );

  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      toast.show(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onPhoto = async (source: 'camera' | 'library') => {
    setAdding(null);
    // An iPhone won't show the picker over a sheet that is closing.
    await new Promise((r) => setTimeout(r, 450));
    try {
      const taken = await addPhotoEvidence(ref, source, asDocument);
      if (taken === 'no-camera-permission') toast.error(RE_DUTY_WORDS.noCamera);
      else if (taken === 'kept') toast.show(RE_DUTY_WORDS.photoAdded);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const keep = (reason: string) => {
    deviceStore.set(keptKey(d.dutyId), reason);
    setKept(reason);
    setAdding(null);
    toast.show(RE_DUTY_WORDS.kept);
  };
  const sendException = async (reason: string) => {
    try {
      await completeWithException(workspaceId, d.dutyId, reason);
      deviceStore.remove(keptKey(d.dutyId));
      setKept(null);
      setAdding(null);
      toast.show(RE_DUTY_WORDS.markedWithReason);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Screen
      title={RE_DUTY_WORDS.title}
      subtitle={d.dealName}
      leading="back"
      testID="re-duty"
      header={<WaitStrip waiting={mine.length} inset />}
    >
      <View className="gap-2 px-1 pt-1">
        <Text variant="heading" testID="re-duty-title">
          {d.title}
        </Text>
        <Text className="text-[13.5px] leading-[19px] text-text-2" testID="re-duty-line">
          {line}
        </Text>
        <View className="flex-row flex-wrap gap-1.5">
          <StatusBadges sheet={sheet} dueToday={dueToday} doneWaits={doneWaits} />
        </View>
      </View>

      <GroupLabel label={RE_DUTY_WORDS.whatCounts} />
      {!checklist.full ? (
        <NeedsSignalCard words={RE_DUTY_WORDS.summaryProof} testID="re-duty-summary" />
      ) : checklist.items.length === 0 ? (
        <Card className="px-4 py-3">
          <Text className="text-[14px] text-text-2">{RE_DUTY_WORDS.nothingNeeded}</Text>
        </Card>
      ) : (
        <Checklist checklist={checklist} sheet={sheet} waits={evidenceWaits} />
      )}
      {checklist.full && checklist.mode === 'any' && checklist.items.length > 1 ? (
        <Footnote>{RE_DUTY_WORDS.anyOne}</Footnote>
      ) : null}
      {open && !checklist.complete && checklist.full ? (
        <Footnote>{RE_DUTY_WORDS.turnsOn}</Footnote>
      ) : null}

      {open ? (
        <View className="gap-2.5 pt-1">
          {checklist.full && !checklist.complete ? (
            <>
              <Button
                variant="secondary"
                icon={Camera}
                onPress={() => setAdding('photo')}
                testID="re-duty-photo"
              >
                {RE_DUTY_WORDS.addPhoto}
              </Button>
              <Button
                variant="secondary"
                icon={Paperclip}
                onPress={() => setAdding('other')}
                testID="re-duty-other"
              >
                {RE_DUTY_WORDS.addFileOrNote}
              </Button>
            </>
          ) : null}
          <Button
            icon={Check}
            disabled={!checklist.complete}
            onPress={() =>
              void run(
                () => completeDuty({ workspaceId, dutyId: d.dutyId }),
                RE_DUTY_WORDS.markedDoneWaits,
              )
            }
            testID="re-duty-done"
          >
            {RE_DUTY_WORDS.markDone}
          </Button>
          {!checklist.complete ? (
            <Button variant="ghost" onPress={() => setAdding('except')} testID="re-duty-except">
              {RE_DUTY_WORDS.withoutProof}
            </Button>
          ) : null}
        </View>
      ) : doneWaits ? (
        <Button disabled icon={Check} testID="re-duty-done-waits">
          {RE_DUTY_WORDS.doneWaits}
        </Button>
      ) : null}

      {kept && open ? (
        <Card className="gap-2 px-4 py-3" testID="re-duty-kept">
          <Text className="text-[13px] font-medium text-text-2">{RE_DUTY_WORDS.keptReason}</Text>
          <Text className="text-[14.5px]">{`“${kept}”`}</Text>
          <SignalButton
            label={RE_DUTY_WORDS.sendKept}
            why={RE_DUTY_WORDS.withoutProofAbout}
            onPress={() => void sendException(kept)}
            testID="re-duty-send-kept"
          />
        </Card>
      ) : null}

      <DutyDetails sheet={sheet} timeZone={timeZone} />

      <Sheet
        open={adding === 'photo'}
        onClose={() => setAdding(null)}
        title={RE_DUTY_WORDS.addPhoto}
        testID="re-duty-photo-sheet"
      >
        <View className="gap-2.5 pt-3">
          <Button icon={Camera} onPress={() => void onPhoto('camera')} testID="re-duty-camera">
            {RE_DUTY_WORDS.takePhoto}
          </Button>
          <Button
            variant="secondary"
            onPress={() => void onPhoto('library')}
            testID="re-duty-library"
          >
            {RE_DUTY_WORDS.pickPhoto}
          </Button>
        </View>
      </Sheet>
      <FileOrNoteSheet
        open={adding === 'other'}
        onClose={() => setAdding(null)}
        attestations={attestations}
        documents={documents}
        onNote={(body) =>
          void run(() => addEvidence(ref, { kind: 'note', body }), RE_DUTY_WORDS.noteAdded).then(
            () => setAdding(null),
          )
        }
        onAttest={(words) =>
          void run(
            () => addEvidence(ref, { kind: 'attestation', body: words }),
            RE_DUTY_WORDS.attested,
          ).then(() => setAdding(null))
        }
        onDocument={(documentId) =>
          void run(
            () => addEvidence(ref, { kind: 'document', documentId }),
            RE_DUTY_WORDS.documentAdded,
          ).then(() => setAdding(null))
        }
      />
      <ExceptionSheet
        open={adding === 'except'}
        onClose={() => setAdding(null)}
        canExcept={canExcept}
        kept={kept}
        onSend={(reason) => void sendException(reason)}
        onKeep={keep}
      />
    </Screen>
  );
}

function StatusBadges({
  sheet,
  dueToday,
  doneWaits,
}: {
  sheet: DutySheet;
  dueToday: boolean;
  doneWaits: boolean;
}) {
  const d = sheet.duty;
  const out: React.ReactNode[] = [];
  if (d.status === 'completed')
    out.push(
      <Badge key="done" variant={doneWaits ? 'pending' : 'ok'} testID="re-duty-status">
        <Text>
          {doneWaits
            ? RE_DUTY_WORDS.doneWaiting
            : d.exception
              ? RE_DUTY_WORDS.exception
              : RE_DUTY_WORDS.done}
        </Text>
      </Badge>,
    );
  else if (d.status === 'waived' || d.status === 'cancelled')
    out.push(
      <Badge key="ended" variant="gray" testID="re-duty-status">
        <Text>{d.status === 'waived' ? RE_DUTY_WORDS.waived : RE_DUTY_WORDS.cancelled}</Text>
      </Badge>,
    );
  else if (d.status === 'draft')
    out.push(
      <Badge key="draft" variant="pending" testID="re-duty-status">
        <Text>{RE_DUTY_WORDS.draft}</Text>
      </Badge>,
    );
  else if (d.overdue || dueToday)
    out.push(
      <Badge key="due" variant="danger" testID="re-duty-status">
        <Text>{d.overdue ? RE_DUTY_WORDS.late : RE_DUTY_WORDS.dueToday}</Text>
      </Badge>,
    );
  if (d.status === 'waiting_external' && d.waitingOn)
    out.push(
      <Badge key="waiting" variant="gray">
        <Text>{RE_DUTY_WORDS.waitingOn(d.waitingOn)}</Text>
      </Badge>,
    );
  if (d.status === 'blocked' && d.blocker)
    out.push(
      <Badge key="blocked" variant="danger">
        <Text numberOfLines={1}>{RE_DUTY_WORDS.blocked(d.blocker.what)}</Text>
      </Badge>,
    );
  return <>{out}</>;
}

/** What finishes it, item by item, ticked as each arrives, with the proof that ticked it. */
function Checklist({
  checklist,
  sheet,
  waits,
}: {
  checklist: ProofChecklist;
  sheet: DutySheet;
  waits: ReadonlySet<string>;
}) {
  const live = sheet.evidence.filter((e) => !e.withdrawnAt);
  // The proof that ticked an item: a document for a document, a document or a file for a file, else its own kind.
  const proofOf = (kind: string) =>
    live.find((e) =>
      kind === 'file' ? e.kind === 'file' || e.kind === 'document' : e.kind === kind,
    );
  return (
    <View
      className="overflow-hidden rounded-card border border-border bg-card"
      testID="re-duty-checklist"
    >
      {checklist.items.map((c, i) => {
        const e = c.met ? proofOf(c.item.kind) : undefined;
        const waiting = e ? waits.has(e.evidenceId) : false;
        const proof = e
          ? [e.body ? `“${e.body}”` : e.label, waiting ? RE_DUTY_WORDS.waitingToSend : null]
              .filter(Boolean)
              .join(' · ')
          : null;
        return (
          <View
            key={i}
            className={cn(
              'flex-row items-center gap-3 px-3.5 py-2.5',
              i > 0 && 'border-t border-border',
              waiting && 'bg-card-2',
            )}
            testID={`re-proof-${i}`}
          >
            <View
              className={cn(
                'size-[22px] items-center justify-center rounded-[6px]',
                c.met ? 'bg-success' : 'border-[1.5px] border-border-strong',
              )}
              accessibilityLabel={c.met ? 'There' : 'Still needed'}
            >
              {c.met ? <Icon as={Check} className="size-3.5 text-white" strokeWidth={2.5} /> : null}
            </View>
            <View className="min-w-0 flex-1 gap-px">
              <Text className="text-[15px]">{c.words}</Text>
              <Text className="text-[13px] text-text-3">
                {proof ?? RE_DUTY_WORDS.item[c.item.kind]}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Why it's due then, what it waits on, and what happened to it. */
function DutyDetails({ sheet, timeZone }: { sheet: DutySheet; timeZone: string }) {
  const trace = traceWords(sheet.duty.dueTrace);
  return (
    <>
      {sheet.duty.dueAt || trace.length ? (
        <>
          <GroupLabel label={RE_DUTY_WORDS.whyDue} />
          <Card className="gap-1 px-4 py-3">
            <Text className="text-[14px]">{sheet.duty.dueRule}</Text>
            {trace.map((t) => (
              <Text key={t} className="text-[13px] text-text-3">
                {t}
              </Text>
            ))}
          </Card>
        </>
      ) : null}
      {sheet.waitsOn.length ? (
        <>
          <GroupLabel label={RE_DUTY_WORDS.waitsOn} count={sheet.waitsOn.length} />
          <Card className="px-4 py-2">
            {sheet.waitsOn.map((w) => (
              <Text key={w.dutyId} className="py-1 text-[14px]">
                {[w.title, w.accountableName].filter(Boolean).join(' · ')}
              </Text>
            ))}
          </Card>
        </>
      ) : null}
      {sheet.log.length ? (
        <>
          <GroupLabel label={RE_DUTY_WORDS.log} />
          <Card className="px-4 py-2">
            {sheet.log.slice(0, 8).map((l, i) => (
              <Text key={i} className="py-1 text-[13.5px] text-text-2">
                {[dutyLogWords(l.what, l.before, l.after), l.actor?.name, fmtTime(l.at, timeZone)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}

function FileOrNoteSheet({
  open,
  onClose,
  attestations,
  documents,
  onNote,
  onAttest,
  onDocument,
}: {
  open: boolean;
  onClose: () => void;
  attestations: readonly string[];
  documents: readonly DealDocument[];
  onNote: (body: string) => void;
  onAttest: (words: string) => void;
  onDocument: (documentId: string) => void;
}) {
  const [note, setNote] = React.useState('');
  const [picking, setPicking] = React.useState(false);
  const colors = useColors();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RE_DUTY_WORDS.fileOrNoteTitle}
      scroll
      testID="re-duty-other-sheet"
    >
      <View className="gap-2.5 pt-3">
        {attestations.map((words) => (
          <View key={words} className="gap-1">
            <Button variant="secondary" onPress={() => onAttest(words)} testID="re-duty-attest">
              {RE_DUTY_WORDS.sayYouDid(words)}
            </Button>
            <Text className="text-[12.5px] text-text-3">{RE_DUTY_WORDS.attestAbout}</Text>
          </View>
        ))}
        <Text className="pt-1 text-[13px] font-medium text-text-2">{RE_DUTY_WORDS.noteLabel}</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder={RE_DUTY_WORDS.notePlaceholder}
          placeholderTextColor={colors.placeholder}
          multiline
          className="min-h-20 rounded-menu border border-border-strong bg-card px-3.5 py-3 font-sans text-base text-text"
          testID="re-duty-note"
        />
        <Text className="text-[12.5px] text-text-3">{RE_DUTY_WORDS.noteAbout}</Text>
        <Button
          disabled={!note.trim()}
          onPress={() => {
            onNote(note);
            setNote('');
          }}
          testID="re-duty-note-add"
        >
          {RE_DUTY_WORDS.addNote}
        </Button>
        <Button
          variant="secondary"
          icon={FileText}
          onPress={() => setPicking(!picking)}
          testID="re-duty-pick-document"
        >
          {RE_DUTY_WORDS.pickDocument}
        </Button>
        {picking ? (
          documents.length === 0 ? (
            <Text className="text-[13px] text-text-3">{RE_DUTY_WORDS.noDocuments}</Text>
          ) : (
            <View className="overflow-hidden rounded-menu border border-border">
              {documents.map((doc, i) => (
                <Pressable
                  key={doc.documentId}
                  role="button"
                  onPress={() => onDocument(doc.documentId)}
                  testID={`re-duty-document-${doc.documentId}`}
                  className={cn(
                    'min-h-12 justify-center px-3.5 py-2 active:bg-card-2',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  <Text className="text-[15px]">{doc.title || doc.kindLabel}</Text>
                  <Text className="text-[12.5px] text-text-3">{`${doc.kindLabel} · v${doc.version}`}</Text>
                </Pressable>
              ))}
            </View>
          )
        ) : null}
      </View>
    </Sheet>
  );
}

function ExceptionSheet({
  open,
  onClose,
  canExcept,
  kept,
  onSend,
  onKeep,
}: {
  open: boolean;
  onClose: () => void;
  canExcept: boolean;
  kept: string | null;
  onSend: (reason: string) => void;
  onKeep: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState(kept ?? '');
  const colors = useColors();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RE_DUTY_WORDS.withoutProof}
      description={canExcept ? RE_DUTY_WORDS.withoutProofAbout : RE_DUTY_WORDS.withoutProofOthers}
      testID="re-duty-except-sheet"
    >
      {canExcept ? (
        <View className="gap-2.5 pt-3">
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder={RE_DUTY_WORDS.reasonPlaceholder}
            placeholderTextColor={colors.placeholder}
            multiline
            className="min-h-16 rounded-menu bg-card-2 px-3.5 py-3 font-sans text-base text-text"
            testID="re-duty-reason"
          />
          <SignalButton
            label={RE_DUTY_WORDS.withoutProof}
            onPress={() => onSend(reason)}
            disabled={!reason.trim()}
            testID="re-duty-except-send"
          />
          <Button
            variant="secondary"
            disabled={!reason.trim()}
            onPress={() => onKeep(reason.trim())}
            testID="re-duty-keep"
          >
            {RE_DUTY_WORDS.keepForLater}
          </Button>
          <Footnote>{RE_DUTY_WORDS.keepForLaterLine}</Footnote>
        </View>
      ) : null}
    </Sheet>
  );
}

/** "Needs signal" in words for a screen reader, beside the board's. */
export const NEEDS_SIGNAL_WORDS = RE_PHONE_WORDS.needsSignal;
