import { addDays, fmtMonthDay, money } from '@hfos/core';
import { LOAN_TYPES } from '@hfos/core/addons/realestate/offer-words';
import { RE_FINANCING_WORDS as W } from '@hfos/core/addons/realestate/phone-words-closing';
import { financingOfCopy, type FinancingView } from '@hfos/core/addons/realestate/views/closing';
import { documentsOfCopy } from '@hfos/core/addons/realestate/views/documents';
import * as React from 'react';
import { Linking, View } from 'react-native';

import { Camera, MessageCircle, Phone } from '@/components/icons';
import { List, ListLabel } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { markStepDone } from './closing-actions';
import {
  CheckRow,
  Chips,
  DealSubpage,
  FieldError,
  FieldLabel,
  SummaryAnswer,
  takeDealPhoto,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * A deal's financing on the phone (board 85, first panel): the lender with Call and Text, and the loan's steps from
 * preapproval to funding, each ticked done when the lender calls, with no signal. Marking one done needs its proof
 * (one of the deal's documents, or a photo of the lender's letter taken now), as on the web; it counts for the duties
 * that ask for it once it reaches HandsFreeOS.
 */

type Step = FinancingView['steps'][number];
export interface ProofChoice {
  readonly kind: 'document' | 'file';
  readonly id: string;
  readonly label: string;
}

export function FinancingScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const view = React.useMemo(
    () => financingOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const side = deal?.data.side === 'listing' ? 'listing' : 'buyer';
  const proofs = React.useMemo<ProofChoice[]>(
    () =>
      documentsOfCopy(copy, dealId)
        .filter((d) => d.status !== 'void' && d.status !== 'superseded')
        .map((d) => ({ kind: 'document' as const, id: d.documentId, label: d.title })),
    [copy, dealId],
  );
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () => ({
      ...unwrap(
        await api.POST('/v1/queries/realestate.financing', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
      full: true,
    }),
    `financing:${dealId}`,
    'financing',
  );
  const [step, setStep] = React.useState<Step | null>(null);
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={side === 'listing' ? W.titleListing : W.title}
      testID="re-financing"
    >
      {whole && view ? (
        <FinancingBody view={view} onStep={setStep} />
      ) : (
        <SummaryAnswer answer={server} what="financing">
          {(data) => <FinancingBody view={data} />}
        </SummaryAnswer>
      )}
      <StepSheet
        step={step}
        today={ctx.today}
        proofs={proofs}
        onClose={() => setStep(null)}
        onDone={async (s, doneOn, proof) => {
          let chosen = proof;
          let dependsOn: string[] | undefined;
          if (proof === 'photo') {
            const taken = await takeDealPhoto({
              workspaceId: ctx.workspaceId,
              userId: ctx.userId,
              dealId,
              source: 'camera',
              name: `${s.label} letter.jpg`,
            });
            if (taken.kind !== 'kept') return false;
            chosen = { kind: 'file', id: taken.fileId, label: W.photoTaken };
            dependsOn = [taken.changeId];
          }
          if (chosen === 'photo') return false;
          await markStepDone({
            workspaceId: ctx.workspaceId,
            dealId,
            userId: ctx.userId,
            step: s.step,
            doneOn,
            proof: { kind: chosen.kind, id: chosen.id },
            dependsOn,
          });
          toast.show(W.marked(s.label));
          return true;
        }}
      />
    </DealSubpage>
  );
}

/** "Conventional · $392,000 loan · rate locked to Oct 13" */
export function lenderLine(view: FinancingView): string {
  const l = view.lender;
  const lock = view.steps.find((s) => s.step === 'rate_lock');
  return [
    l.loanType ? LOAN_TYPES[l.loanType] : null,
    l.loanAmountCents ? W.loan(money(l.loanAmountCents)) : null,
    lock?.status === 'done' && lock.expiresOn ? W.locked(fmtMonthDay(lock.expiresOn)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function FinancingBody({
  view,
  onStep,
}: {
  view: FinancingView;
  /** Ticking a step; left out where it can't be ticked (a summary's answer). */
  onStep?: (step: Step) => void;
}) {
  const l = view.lender;
  const head = [l.lenderName, l.officerName].filter(Boolean).join(' · ');
  const line = lenderLine(view);
  return (
    <View className="gap-3" testID="financing-body">
      <Card className="gap-2.5 p-4" testID="financing-lender">
        {head ? (
          <>
            <Text className="text-[15px] font-semibold">{head}</Text>
            {line ? <Text className="text-[13.5px] text-text-2">{line}</Text> : null}
            {l.officerPhone ? (
              <View className="flex-row gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="md"
                  icon={Phone}
                  onPress={() => void Linking.openURL(`tel:${l.officerPhone}`)}
                  testID="financing-call"
                >
                  {W.call(l.officerName)}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  icon={MessageCircle}
                  onPress={() => void Linking.openURL(`sms:${l.officerPhone}`)}
                  testID="financing-text"
                >
                  {W.text}
                </Button>
              </View>
            ) : null}
          </>
        ) : (
          <Text className="text-[14px] text-text-2">{W.noLender}</Text>
        )}
      </Card>
      <ListLabel>{W.steps}</ListLabel>
      <List testID="financing-steps">
        {view.steps.map((s) => (
          <CheckRow
            key={s.step}
            checked={s.status === 'done'}
            label={s.label}
            line={s.line}
            warning={s.warning}
            onPress={onStep && s.status !== 'done' ? () => onStep(s) : undefined}
            testID={`financing-${s.step}`}
          />
        ))}
      </List>
    </View>
  );
}

/** Marking a step done: its proof and the day. */
export function StepSheet({
  step,
  today,
  proofs,
  onClose,
  onDone,
}: {
  step: Step | null;
  today: string;
  proofs: readonly ProofChoice[];
  onClose: () => void;
  /** True once it's made, so the sheet closes. */
  onDone: (step: Step, doneOn: string, proof: ProofChoice | 'photo') => Promise<boolean>;
}) {
  const [proof, setProof] = React.useState<string>('photo');
  const [day, setDay] = React.useState<'today' | 'yesterday'>('today');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!step) return;
    setProof(proofs[0] ? `${proofs[0].kind}:${proofs[0].id}` : 'photo');
    setDay('today');
    setError(null);
  }, [step, proofs]);
  const save = async () => {
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = proofs.find((p) => `${p.kind}:${p.id}` === proof) ?? 'photo';
      const done = await onDone(step, day === 'today' ? today : addDays(today, -1), chosen);
      if (done) onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!step}
      onClose={onClose}
      title={step ? W.doneTitle(step.label) : undefined}
      description={W.doneAbout}
      testID="financing-step-sheet"
    >
      <View className="gap-3">
        <FieldLabel>{W.proof}</FieldLabel>
        <List>
          {[
            ...proofs.map((p) => ({ key: `${p.kind}:${p.id}`, label: p.label })),
            { key: 'photo', label: W.photoProof },
          ].map((p) => (
            <CheckRow
              key={p.key}
              icon={p.key === 'photo' ? Camera : undefined}
              checked={p.key === 'photo' ? undefined : proof === p.key}
              label={p.label}
              end={p.key === 'photo' && proof === 'photo' ? '✓' : undefined}
              onPress={() => setProof(p.key)}
              testID={`financing-proof-${p.key === 'photo' ? 'photo' : p.key.split(':')[1]}`}
            />
          ))}
        </List>
        {!proofs.length ? <Text className="text-[13px] text-text-3">{W.noProof}</Text> : null}
        <FieldLabel>{W.doneOn}</FieldLabel>
        <Chips
          value={day}
          onChange={setDay}
          options={[
            ['today', W.today],
            ['yesterday', W.yesterday],
          ]}
          testID="financing-day"
        />
        <FieldError>{error}</FieldError>
        <Button loading={busy} onPress={() => void save()} testID="financing-mark-done">
          {W.markDone}
        </Button>
      </View>
    </Sheet>
  );
}
