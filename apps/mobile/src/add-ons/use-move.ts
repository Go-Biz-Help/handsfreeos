import type { LifecycleAction } from '@hfos/core';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';

import {
  agreedWith,
  asksFirst,
  questionOf,
  typedNameMatches,
  type AddonQuestion,
  type AddonView,
} from './rules';
import type { AddonImpact, AddonMoved } from './types';
import { addonCommands, useAddonImpact, type Live } from './use-add-ons';
import { movedLine } from './words';

/**
 * Moving an add-on, from the button to the toast. Turning it on or installing it goes at once; turning it off,
 * uninstalling it or deleting its data asks first, with what `addon.impact` says it would take with it. Whenever
 * HandsFreeOS answers that other add-ons have to move too (`addon_needs`, `addon_required_by`), its question is put to
 * the person, and a yes sends the same move again with those add-ons agreed to: nothing ever moves silently (the
 * owner's decision, 2026-09-28).
 */

type Move = Exclude<LifecycleAction, 'purge'>;

export type MoveStep =
  | { readonly kind: 'idle' }
  /** Before a move that takes something away: its question, and what it would do. */
  | {
      readonly kind: 'confirm';
      readonly view: AddonView;
      readonly action: 'disable' | 'uninstall' | 'purge';
    }
  /** HandsFreeOS asked about other add-ons: "Rent Collection needs Property Management. Turn it on too?" */
  | {
      readonly kind: 'question';
      readonly view: AddonView;
      readonly action: Move;
      /** Everything agreed to so far, with the add-ons this question is about. */
      readonly include: readonly string[];
      readonly question: AddonQuestion;
    };

export interface MoveFlow {
  readonly step: MoveStep;
  /** What the move asked about would do, while it's being asked. */
  readonly impact: Live<AddonImpact>;
  /** A move on its way to HandsFreeOS. */
  readonly sending: boolean;
  /** Deleting its data: the name typed so far, and why HandsFreeOS turned the last one down. */
  readonly typed: string;
  readonly refusedName: string | null;
  setTyped(text: string): void;
  start(view: AddonView, action: LifecycleAction): void;
  /** Yes to what's asked: the move, with every other add-on it takes agreed to. */
  confirm(): void;
  /** Whether `confirm` would send anything now. */
  readonly canConfirm: boolean;
  close(): void;
}

export function useAddonMove({
  workspaceId,
  nameOf,
  onMoved,
}: {
  workspaceId: string;
  nameOf: (addonId: string) => string;
  /** After every move, gone through or not: where things stand has to be read again. */
  onMoved: () => void;
}): MoveFlow {
  const [step, setStep] = React.useState<MoveStep>({ kind: 'idle' });
  const [round, setRound] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [typed, setTypedText] = React.useState('');
  const [refusedName, setRefusedName] = React.useState<string | null>(null);
  const impact = useAddonImpact(
    workspaceId,
    step.kind === 'confirm' ? { addonId: step.view.addonId, action: step.action, round } : null,
  );

  const close = React.useCallback(() => setStep({ kind: 'idle' }), []);

  const moved = (done: readonly AddonMoved[]) => {
    setStep({ kind: 'idle' });
    const line = movedLine(done, nameOf);
    if (line) toast.show(line);
    onMoved();
  };

  const refused = (e: unknown) => {
    setStep({ kind: 'idle' });
    toast.error(errorMessage(e));
    onMoved();
  };

  const send = async (view: AddonView, action: Move, include: readonly string[]) => {
    setSending(true);
    try {
      moved(await addonCommands.move(workspaceId, view.addonId, action, include));
    } catch (e) {
      const question = questionOf(e);
      if (question)
        setStep({
          kind: 'question',
          view,
          action,
          include: agreedWith(include, question.addons),
          question,
        });
      else refused(e);
    } finally {
      setSending(false);
    }
  };

  const purge = async (view: AddonView, name: string) => {
    setSending(true);
    try {
      moved(await addonCommands.purge(workspaceId, view.addonId, name.trim()));
    } catch (e) {
      // A name HandsFreeOS doesn't take stays in the question, under the box, to be typed again.
      if ((e as { code?: unknown } | null)?.code === 'validation') setRefusedName(errorMessage(e));
      else refused(e);
    } finally {
      setSending(false);
    }
  };

  const start = (view: AddonView, action: LifecycleAction) => {
    if (sending) return;
    if (asksFirst(action)) {
      setTypedText('');
      setRefusedName(null);
      setRound((r) => r + 1);
      setStep({ kind: 'confirm', view, action });
      return;
    }
    void send(view, action, []);
  };

  const plan = step.kind === 'confirm' && impact.data?.outcome === 'plan' ? impact.data : null;
  const canConfirm =
    !sending &&
    (step.kind === 'question' ||
      (plan !== null &&
        step.kind === 'confirm' &&
        (step.action !== 'purge' || typedNameMatches(typed, step.view.name))));

  const confirm = () => {
    if (!canConfirm) return;
    if (step.kind === 'question') {
      void send(step.view, step.action, step.include);
      return;
    }
    if (step.kind !== 'confirm' || !plan) return;
    if (step.action === 'purge') void purge(step.view, typed);
    // Every add-on the plan moves besides this one is one the person was just shown and agreed to.
    else void send(step.view, step.action, plan.needsAgreement);
  };

  return {
    step,
    impact,
    sending,
    typed,
    refusedName,
    setTyped: (text: string) => {
      setTypedText(text);
      setRefusedName(null);
    },
    start,
    confirm,
    canConfirm,
    close,
  };
}
