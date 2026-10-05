import { daysBetween, localDateOf } from '@hfos/core';
import {
  CONTINGENCY_ENDINGS,
  inSentence,
  type ContingencyEnding,
} from '@hfos/core/addons/realestate/contingencies';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_CONTINGENCY_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import {
  contingenciesOfCopy,
  type ContingenciesView,
} from '@hfos/core/addons/realestate/views/closing';
import { documentsOfCopy, type DealDocument } from '@hfos/core/addons/realestate/views/documents';
import * as React from 'react';
import { View } from 'react-native';

import { Camera } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { addDocument, photoOnDeal, resolveContingency } from './deal-actions';
import { Choice, dayOf, Footnote, KeptStrip, useReChanges, type ReChange } from './deal-bits';
import { NeedsSignalCard, useReContext } from './kit';

/**
 * Contingencies (board 80): each one, when it ends and how it ended, read with no signal. Resolving one works with no
 * signal too, with the signed form (one of the deal's documents, or a photo of it taken now): it waits to send, and the
 * dates and duties it moves, move at HandsFreeOS when it arrives.
 */

type Contingency = ContingenciesView['contingencies'][number];

export function ContingenciesScreen({ dealId }: { dealId: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const view = React.useMemo(() => contingenciesOfCopy(copy, dealId, ctx), [copy, dealId, ctx]);
  const documents = React.useMemo(
    () =>
      documentsOfCopy(copy, dealId).filter((d) => d.status !== 'void' && d.status !== 'superseded'),
    [copy, dealId],
  );
  const changes = useReChanges(ctx.workspaceId);
  return (
    <ContingenciesListView
      dealName={copy.deals.get(dealId)?.name ?? ''}
      dealId={dealId}
      view={view}
      documents={documents}
      changes={changes}
      workspaceId={ctx.workspaceId}
      userId={ctx.userId}
      timeZone={ctx.timeZone}
      now={ctx.now}
    />
  );
}

export function ContingenciesListView({
  dealName,
  dealId,
  view,
  documents,
  changes,
  workspaceId,
  userId,
  timeZone,
  now,
}: {
  dealName: string;
  dealId: string;
  view: ContingenciesView | null;
  documents: readonly DealDocument[];
  changes: readonly ReChange[];
  workspaceId: string;
  userId: string;
  timeZone: string;
  now: number;
}) {
  const [resolving, setResolving] = React.useState<Contingency | null>(null);
  const waiting = new Set(
    changes
      .filter((c) => c.name === 'realestate.contingency.resolve')
      .map((c) => c.input.contingencyId),
  );
  const today = localDateOf(now, timeZone);
  return (
    <Screen
      title={RE_CONTINGENCY_WORDS.title}
      subtitle={dealName}
      leading="back"
      testID="re-contingencies"
      header={<KeptStrip inset />}
    >
      {!view ? (
        <NeedsSignalCard words={RE_PHONE_WORDS.notOnPhone} />
      ) : !view.full ? (
        <NeedsSignalCard words={RE_CONTINGENCY_WORDS.summary} testID="re-contingencies-summary" />
      ) : view.contingencies.length === 0 ? (
        <Card className="px-5 py-8">
          <Text className="text-center text-[14px] text-text-2">{RE_CONTINGENCY_WORDS.empty}</Text>
        </Card>
      ) : (
        view.contingencies.map((c) => {
          const end = dayOf(c.endsOn, timeZone, now);
          const open = c.state === 'open';
          const chip = !open
            ? {
                words: c.stateWords,
                variant: c.state === 'satisfied' ? ('ok' as const) : ('gray' as const),
              }
            : c.clock === 'passed'
              ? { words: RE_CONTINGENCY_WORDS.ended(end!), variant: 'danger' as const }
              : c.clock === 'ending'
                ? {
                    words: RE_CONTINGENCY_WORDS.endsIn(end!, daysBetween(today, c.endsOn!)),
                    variant: 'pending' as const,
                  }
                : end
                  ? { words: RE_CONTINGENCY_WORDS.ends(end), variant: 'gray' as const }
                  : { words: RE_CONTINGENCY_WORDS.noEnd, variant: 'gray' as const };
          const sent = waiting.has(c.id);
          const page =
            c.kind === 'inspection' ? 'inspections' : c.kind === 'financing' ? 'financing' : null;
          return (
            <Card
              key={c.id}
              className={cn('gap-2 px-3.5 py-3', sent && 'bg-card-2')}
              testID={`re-contingency-${c.id}`}
            >
              <View className="flex-row items-start gap-2">
                <Text className="flex-1 text-[16px] font-semibold">{c.label}</Text>
                <Badge variant={sent ? 'pending' : chip.variant} testID="re-contingency-state">
                  <Text>{sent ? RE_PHONE_WORDS.waitingToSend : chip.words}</Text>
                </Badge>
              </View>
              <Text className="text-[13.5px] leading-[19px] text-text-2">
                {[
                  RE_CONTINGENCY_WORDS.from[c.source],
                  c.document?.title,
                  c.note,
                  c.resolvedByName ? RE_CONTINGENCY_WORDS.resolvedBy(c.resolvedByName) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {open && !sent ? (
                <View className="flex-row flex-wrap items-center gap-2">
                  <Button
                    size="md"
                    variant="secondary"
                    onPress={() => setResolving(c)}
                    testID="re-contingency-resolve"
                  >
                    {RE_CONTINGENCY_WORDS.resolve}
                  </Button>
                  {page ? (
                    <Button
                      size="md"
                      variant="ghost"
                      onPress={() =>
                        openWebPath(`/app/w/${workspaceId}/a/realestate/deals/${dealId}/${page}`)
                      }
                    >
                      {page === 'inspections'
                        ? RE_CONTINGENCY_WORDS.openInspections
                        : RE_CONTINGENCY_WORDS.openFinancing}
                    </Button>
                  ) : null}
                </View>
              ) : null}
            </Card>
          );
        })
      )}
      <ResolveSheet
        contingency={resolving}
        documents={documents}
        onClose={() => setResolving(null)}
        workspaceId={workspaceId}
        userId={userId}
        dealId={dealId}
      />
    </Screen>
  );
}

export function ResolveSheet({
  contingency,
  documents,
  onClose,
  workspaceId,
  userId,
  dealId,
}: {
  contingency: Contingency | null;
  documents: readonly DealDocument[];
  onClose: () => void;
  workspaceId: string;
  userId: string;
  dealId: string;
}) {
  const [how, setHow] = React.useState<ContingencyEnding>('satisfied');
  const [documentId, setDocumentId] = React.useState<string | null>(null);
  const [photo, setPhoto] = React.useState<{ changeId: string; fileId: string } | null>(null);
  const label = contingency?.label ?? '';
  React.useEffect(() => {
    setHow('satisfied');
    setDocumentId(null);
    setPhoto(null);
  }, [contingency?.id]);

  const takeIt = async () => {
    try {
      const taken = await photoOnDeal({ workspaceId, userId, dealId, source: 'camera' });
      if (taken.kind === 'kept') {
        setPhoto({ changeId: taken.changeId, fileId: taken.fileId });
        setDocumentId(null);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const save = async () => {
    if (!contingency) return;
    try {
      if (photo) {
        const doc = await addDocument({
          workspaceId,
          dealId,
          fileId: photo.fileId,
          kind: 'other',
          title: `${label}: signed form`,
          status: 'sent',
          dependsOn: [photo.changeId],
        });
        await resolveContingency({
          workspaceId,
          userId,
          contingencyId: contingency.id,
          how,
          documentId: doc.documentId,
          dependsOn: [doc.changeId],
        });
      } else if (documentId) {
        await resolveContingency({
          workspaceId,
          userId,
          contingencyId: contingency.id,
          how,
          documentId,
        });
      } else {
        toast.error(RE_CONTINGENCY_WORDS.needForm);
        return;
      }
      toast.show(RE_CONTINGENCY_WORDS.saved);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Sheet
      open={contingency !== null}
      onClose={onClose}
      title={RE_CONTINGENCY_WORDS.resolveTitle(inSentence(label))}
      scroll
      testID="re-resolve"
    >
      <View className="gap-2.5 pt-3">
        <Text className="text-[13px] text-text-2">{RE_CONTINGENCY_WORDS.how}</Text>
        {CONTINGENCY_ENDINGS.map((h) => (
          <Choice
            key={h}
            label={RE_CONTINGENCY_WORDS.hows[h]}
            picked={how === h}
            onPress={() => setHow(h)}
            testID={`re-resolve-${h}`}
          />
        ))}
        <Text className="pt-1 text-[13px] text-text-2">{RE_CONTINGENCY_WORDS.proof}</Text>
        {photo ? (
          <Choice
            label={RE_CONTINGENCY_WORDS.photoTaken(`${label}: signed form`)}
            picked
            onPress={() => setPhoto(null)}
          />
        ) : (
          <Button
            variant="secondary"
            icon={Camera}
            onPress={() => void takeIt()}
            testID="re-resolve-photo"
          >
            {RE_CONTINGENCY_WORDS.photoForm}
          </Button>
        )}
        {documents.map((doc) => (
          <Choice
            key={doc.documentId}
            label={doc.title || doc.kindLabel}
            detail={`${doc.kindLabel} · v${doc.version}`}
            picked={documentId === doc.documentId}
            onPress={() => {
              setDocumentId(doc.documentId);
              setPhoto(null);
            }}
            testID={`re-resolve-document-${doc.documentId}`}
          />
        ))}
        <Footnote>{RE_CONTINGENCY_WORDS.noForm}</Footnote>
        <Button
          disabled={!photo && !documentId}
          onPress={() => void save()}
          testID="re-resolve-save"
        >
          {RE_CONTINGENCY_WORDS.save}
        </Button>
        <Footnote>{RE_CONTINGENCY_WORDS.savesOffline}</Footnote>
      </View>
    </Sheet>
  );
}
