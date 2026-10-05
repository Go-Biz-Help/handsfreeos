import { localDateOf } from '@hfos/core';
import { DOCUMENT_KINDS, type DocumentKind } from '@hfos/core/addons/realestate/catalog/types';
import { exportSizeWords } from '@hfos/core/addons/realestate/keeping-words';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_DOCUMENTS_WORDS, RE_DUTY_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { holdsWhole } from '@hfos/core/addons/realestate/views/deal-facts';
import {
  documentsOfCopy,
  signingsOfCopy,
  type DealDocument,
  type DealSigning,
} from '@hfos/core/addons/realestate/views/documents';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Camera, ChevronRight, FileText, Lock, Plus } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { signedUrl } from '@/inbox/storage';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { addDocument, photoOnDeal } from './deal-actions';
import {
  Chip,
  dayOf,
  Footnote,
  GroupLabel,
  KeptStrip,
  useReChanges,
  type ReChange,
} from './deal-bits';
import { NeedsSignalCard, SummaryChip, useLiveAnswer, useReContext } from './kit';

/**
 * A deal's documents (board 81): signed ones locked and saying which version counts, those out for signing with who
 * signs next, and the rest. Names, versions and who signed are on the phone; the document itself stays at HandsFreeOS
 * and opens with signal (Chris, 2026-10-03). A photo of a paper adds a document with no signal.
 */

/** The kinds a photo of a paper most often is, first in the picker. */
const PHOTO_KINDS: readonly DocumentKind[] = [
  'amendment',
  'addendum',
  'inspection_report',
  'repair_request',
  'emd_receipt',
  'insurance_binder',
  'seller_disclosure',
  'invoice',
  'other',
];

export function DocumentsScreen({ dealId, esign }: { dealId: string; esign?: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const whole = holdsWhole(copy, dealId, ctx.userId);
  const documents = React.useMemo(() => documentsOfCopy(copy, dealId), [copy, dealId]);
  const signings = React.useMemo(() => signingsOfCopy(copy, dealId), [copy, dealId]);
  const changes = useReChanges(ctx.workspaceId);
  // A deal kept as its summary: its documents load with signal.
  const live = useLiveAnswer<readonly DealDocument[]>(
    whole || !copy.deals.has(dealId)
      ? null
      : () =>
          api
            .POST('/v1/queries/realestate.document.list', {
              body: { workspaceId: ctx.workspaceId, dealId },
            })
            .then((r) => unwrap(r).documents as readonly DealDocument[]),
    `documents:${dealId}`,
    RE_DOCUMENTS_WORDS.summary,
  );
  return (
    <DocumentsView
      dealName={copy.deals.get(dealId)?.name ?? ''}
      dealId={dealId}
      held={copy.deals.has(dealId)}
      whole={whole}
      documents={whole ? documents : (live.data ?? [])}
      summaryState={whole ? null : { loading: live.loading, error: live.error, retry: live.reload }}
      signings={signings}
      pending={changes.filter(
        (c) => c.name === 'realestate.document.add' && c.input.dealId === dealId,
      )}
      workspaceId={ctx.workspaceId}
      userId={ctx.userId}
      timeZone={ctx.timeZone}
      now={ctx.now}
      esignId={esign ?? null}
    />
  );
}

/** The newest version of each document, the rest counted. */
function newestOf(documents: readonly DealDocument[]) {
  const by = new Map<string, DealDocument[]>();
  for (const d of documents) by.set(d.lineageId, [...(by.get(d.lineageId) ?? []), d]);
  return [...by.values()].map((list) => {
    const sorted = [...list].sort((a, b) => b.version - a.version);
    return { doc: sorted[0]!, versions: sorted.length };
  });
}

export function DocumentsView({
  dealName,
  dealId,
  held,
  whole,
  documents,
  summaryState,
  signings,
  pending,
  workspaceId,
  userId,
  timeZone,
  now,
  esignId,
}: {
  dealName: string;
  dealId: string;
  held: boolean;
  whole: boolean;
  documents: readonly DealDocument[];
  summaryState: { loading: boolean; error: string | null; retry: () => void } | null;
  signings: readonly DealSigning[];
  /** Documents added on this phone that haven't reached HandsFreeOS. */
  pending: readonly ReChange[];
  workspaceId: string;
  userId: string;
  timeZone: string;
  now: number;
  /** Back from DocuSign or Dotloop (the web's `?esign=<envelope>`): its document opens. */
  esignId: string | null;
}) {
  const [adding, setAdding] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [esignSeen, setEsignSeen] = React.useState(false);
  const fromEsign =
    esignId && !esignSeen ? (signings.find((s) => s.id === esignId)?.documentId ?? null) : null;
  const newest = newestOf(documents);
  const signingOf = (documentId: string) =>
    signings.find(
      (s) => s.documentId === documentId && (s.state === 'sent' || s.state === 'draft'),
    );
  const known = new Set(documents.map((d) => d.documentId));
  const waiting = pending.filter((c) => !known.has(String(c.input.id ?? '')));
  const groups = {
    signed: newest.filter((x) => x.doc.status === 'signed'),
    signing: newest.filter(
      (x) => x.doc.status !== 'signed' && x.doc.status !== 'void' && signingOf(x.doc.documentId),
    ),
    other: newest.filter(
      (x) => x.doc.status !== 'signed' && x.doc.status !== 'void' && !signingOf(x.doc.documentId),
    ),
    void: newest.filter((x) => x.doc.status === 'void'),
  };
  const shown = documents.find((d) => d.documentId === (open ?? fromEsign)) ?? null;
  const total = newest.length + waiting.length;
  const day = (iso: string | null) =>
    iso ? dayOf(localDateOf(Date.parse(iso), timeZone), timeZone, now) : null;

  const row = (x: { doc: DealDocument; versions: number }, i: number) => {
    const d = x.doc;
    const s = signingOf(d.documentId);
    const detail =
      d.status === 'signed'
        ? [
            d.version > 1
              ? RE_DOCUMENTS_WORDS.versionSigned(d.version, day(d.signedAt) ?? '')
              : RE_DOCUMENTS_WORDS.signedOn(day(d.signedAt) ?? ''),
            d.controlling && x.versions > 1 ? RE_DOCUMENTS_WORDS.counts : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : s
          ? [
              s.providerLabel,
              s.signersWords.replace(/^Signed by (\d+) of (\d+)$/, '$1 of $2 signed'),
              s.next ? `${s.next} next` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : [d.kindLabel, day(d.createdAt)].filter(Boolean).join(' · ');
    return (
      <Pressable
        key={d.documentId}
        role="button"
        onPress={() => setOpen(d.documentId)}
        testID={`re-document-${d.documentId}`}
        className={cn(
          'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
          i > 0 && 'border-t border-border',
        )}
      >
        <Icon as={FileText} className="size-[18px] text-text-2" />
        <View className="min-w-0 flex-1 gap-px">
          <Text className="text-[15px]">{d.title || d.kindLabel}</Text>
          <Text className="text-[13px] text-text-3">{detail}</Text>
        </View>
        {s ? (
          <Badge variant="pending">
            <Text>{RE_DOCUMENTS_WORDS.signing}</Text>
          </Badge>
        ) : null}
        {d.locked ? <Icon as={Lock} className="size-4 text-text-3" /> : null}
        <Icon as={ChevronRight} className="size-4 text-text-3" />
      </Pressable>
    );
  };

  return (
    <Screen
      title={RE_DOCUMENTS_WORDS.title}
      subtitle={held ? RE_DOCUMENTS_WORDS.subtitle(dealName, total) : undefined}
      leading="back"
      testID="re-documents"
      header={<KeptStrip inset />}
    >
      {!held ? (
        <NeedsSignalCard words={RE_PHONE_WORDS.notOnPhone} />
      ) : !whole && summaryState && documents.length === 0 ? (
        summaryState.loading ? null : (
          <NeedsSignalCard
            words={summaryState.error ?? RE_DOCUMENTS_WORDS.summary}
            onRetry={summaryState.retry}
            testID="re-documents-summary"
          />
        )
      ) : (
        <>
          {!whole ? <SummaryChip /> : null}
          {total === 0 ? (
            <Card className="px-5 py-8">
              <Text className="text-center text-[14px] text-text-2">
                {RE_DOCUMENTS_WORDS.empty}
              </Text>
            </Card>
          ) : null}
          {groups.signed.length ? (
            <>
              <GroupLabel label={RE_DOCUMENTS_WORDS.signed} count={groups.signed.length} />
              <Card>{groups.signed.map(row)}</Card>
            </>
          ) : null}
          {groups.signing.length ? (
            <>
              <GroupLabel label={RE_DOCUMENTS_WORDS.outForSigning} count={groups.signing.length} />
              <Card>{groups.signing.map(row)}</Card>
            </>
          ) : null}
          {groups.other.length || waiting.length ? (
            <>
              <GroupLabel
                label={RE_DOCUMENTS_WORDS.notSigned}
                count={groups.other.length + waiting.length}
              />
              <Card>
                {groups.other.map(row)}
                {waiting.map((c, i) => (
                  <View
                    key={c.id}
                    className={cn(
                      'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5',
                      (groups.other.length > 0 || i > 0) && 'border-t border-border',
                    )}
                    testID={`re-document-waiting-${c.id}`}
                  >
                    <Icon as={FileText} className="size-[18px] text-text-3" />
                    <View className="min-w-0 flex-1 gap-px">
                      <Text className="text-[15px]">
                        {String(
                          c.input.title ?? DOCUMENT_KINDS[c.input.kind as DocumentKind] ?? '',
                        )}
                      </Text>
                      <Text className="text-[13px] text-text-3">
                        {RE_DOCUMENTS_WORDS.waitingToSend}
                      </Text>
                    </View>
                    <Badge variant="pending">
                      <Text>{RE_DOCUMENTS_WORDS.waiting}</Text>
                    </Badge>
                  </View>
                ))}
              </Card>
            </>
          ) : null}
          {groups.void.length ? (
            <>
              <GroupLabel label={RE_DOCUMENTS_WORDS.voided} count={groups.void.length} />
              <Card>{groups.void.map(row)}</Card>
            </>
          ) : null}
          {whole ? (
            <Button
              variant="secondary"
              icon={Plus}
              onPress={() => setAdding(true)}
              testID="re-documents-add"
            >
              {RE_DOCUMENTS_WORDS.add}
            </Button>
          ) : null}
        </>
      )}
      <DocumentSheet
        document={shown}
        versions={shown ? documents.filter((d) => d.lineageId === shown.lineageId).length : 0}
        signing={
          shown
            ? (signings.find(
                (s) => s.documentId === shown.documentId || s.signedDocumentId === shown.documentId,
              ) ?? null)
            : null
        }
        timeZone={timeZone}
        now={now}
        onClose={() => {
          setOpen(null);
          setEsignSeen(true);
        }}
      />
      <AddDocumentSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={async (kind, title, source) => {
          setAdding(false);
          await new Promise((r) => setTimeout(r, 450));
          try {
            const photo = await photoOnDeal({ workspaceId, userId, dealId, source });
            if (photo.kind === 'no-camera-permission') {
              toast.error(RE_DUTY_WORDS.noCamera);
              return;
            }
            if (photo.kind !== 'kept') return;
            await addDocument({
              workspaceId,
              dealId,
              fileId: photo.fileId,
              kind,
              title,
              dependsOn: [photo.changeId],
            });
            toast.show(RE_DOCUMENTS_WORDS.added(title.trim() || DOCUMENT_KINDS[kind]));
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </Screen>
  );
}

/** One document, with no signal: what the phone knows of it, and Open it with signal. */
function DocumentSheet({
  document,
  versions,
  signing,
  timeZone,
  now,
  onClose,
}: {
  document: DealDocument | null;
  versions: number;
  signing: DealSigning | null;
  timeZone: string;
  now: number;
  onClose: () => void;
}) {
  const { online } = useNetwork();
  const { data: files } = useQuery<{
    bucket: string | null;
    object_path: string | null;
    size_bytes: number | null;
  }>('SELECT bucket, object_path, size_bytes FROM files WHERE id = ?', [document?.fileId ?? '']);
  const file = document ? (files[0] ?? null) : null;
  const size = file?.size_bytes ? exportSizeWords(file.size_bytes) : null;
  const d = document;
  const day = (iso: string | null) =>
    iso ? dayOf(localDateOf(Date.parse(iso), timeZone), timeZone, now) : null;
  const signedBy = signing?.state === 'completed' ? signing.signers.map((s) => s.name) : [];
  const openIt = async () => {
    if (!file?.bucket || !file.object_path) {
      toast.error(RE_DOCUMENTS_WORDS.cantOpen);
      return;
    }
    const url = await signedUrl(file.bucket, file.object_path).catch(() => null);
    if (!url) toast.error(RE_DOCUMENTS_WORDS.cantOpen);
    else void Linking.openURL(url);
  };
  return (
    <Sheet
      open={d !== null}
      onClose={onClose}
      title={d ? d.title || d.kindLabel : ''}
      scroll
      testID="re-document-sheet"
    >
      {d ? (
        <View className="gap-3 pt-3">
          <Card className="items-center gap-2 px-5 py-6">
            <Icon as={FileText} className="size-7 text-text-2" />
            <Text className="text-center text-[16px] font-semibold">{`${d.title || d.kindLabel} · v${d.version}`}</Text>
            {online ? (
              <Button variant="secondary" onPress={() => void openIt()} testID="re-document-open">
                {RE_DOCUMENTS_WORDS.open}
              </Button>
            ) : (
              <Text
                className="text-center text-[13.5px] text-text-2"
                testID="re-document-needs-signal"
              >
                {RE_DOCUMENTS_WORDS.openNeedsSignal(size)}
              </Text>
            )}
          </Card>
          <GroupLabel label={RE_DOCUMENTS_WORDS.knows} />
          <Card>
            {[
              d.signedAt
                ? [
                    RE_DOCUMENTS_WORDS.signedRow,
                    [day(d.signedAt), signedBy.length ? `by ${signedBy.join(', ')}` : null]
                      .filter(Boolean)
                      .join(' '),
                  ]
                : null,
              signing && !d.signedAt
                ? [RE_DOCUMENTS_WORDS.esignRow, `${signing.providerLabel} · ${signing.stateLabel}`]
                : null,
              [
                RE_DOCUMENTS_WORDS.versionRow,
                RE_DOCUMENTS_WORDS.versionOf(d.version, versions, d.controlling),
              ],
              [
                RE_DOCUMENTS_WORDS.lockedRow,
                d.locked ? RE_DOCUMENTS_WORDS.locked : RE_DOCUMENTS_WORDS.notLocked,
              ],
              [RE_DOCUMENTS_WORDS.kindRow, d.kindLabel],
            ]
              .filter((r): r is [string, string] => r !== null)
              .map(([label, value], i) => (
                <View
                  key={label}
                  className={cn('flex-row gap-3 px-3.5 py-3', i > 0 && 'border-t border-border')}
                >
                  <Text className="w-[30%] text-[14.5px] text-text-2">{label}</Text>
                  <Text className="flex-1 text-right text-[14.5px]">{value}</Text>
                </View>
              ))}
          </Card>
        </View>
      ) : null}
    </Sheet>
  );
}

function AddDocumentSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (kind: DocumentKind, title: string, source: 'camera' | 'library') => void;
}) {
  const [kind, setKind] = React.useState<DocumentKind>('other');
  const [title, setTitle] = React.useState('');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RE_DOCUMENTS_WORDS.addTitle}
      description={RE_DOCUMENTS_WORDS.addAbout}
      scroll
      testID="re-document-add"
    >
      <View className="gap-2.5 pt-3">
        <Text className="text-[13px] font-medium text-text-2">{RE_DOCUMENTS_WORDS.kind}</Text>
        <View className="flex-row flex-wrap gap-2">
          {PHOTO_KINDS.map((k) => (
            <Chip
              key={k}
              label={DOCUMENT_KINDS[k]}
              on={kind === k}
              onPress={() => setKind(k)}
              testID={`re-document-kind-${k}`}
            />
          ))}
        </View>
        <Text className="pt-1 text-[13px] font-medium text-text-2">{RE_DOCUMENTS_WORDS.name}</Text>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder={RE_DOCUMENTS_WORDS.namePlaceholder}
          accessibilityLabel={RE_DOCUMENTS_WORDS.name}
          testID="re-document-title"
        />
        <Button
          icon={Camera}
          onPress={() => onAdd(kind, title, 'camera')}
          testID="re-document-camera"
        >
          {RE_DOCUMENTS_WORDS.photo}
        </Button>
        <Button
          variant="secondary"
          onPress={() => onAdd(kind, title, 'library')}
          testID="re-document-library"
        >
          {RE_DOCUMENTS_WORDS.pick}
        </Button>
        <Footnote>{RE_DOCUMENTS_WORDS.addAbout}</Footnote>
      </View>
    </Sheet>
  );
}
