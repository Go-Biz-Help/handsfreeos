'use client';
import {
  ADDON_MOVE_WORDS,
  ADDON_PAGE_WORDS as W,
  addonAgreeWords,
  addonHoldsLines,
  addonOptionalLine,
  type LifecycleAction,
} from '@hfos/core';
import { useEffect, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AddonImpact } from '@/lib/api/types';
import { addonName } from './words';

/** One add-on a move is about. */
export interface MoveTarget {
  readonly addonId: string;
  readonly name: string;
}

/** The moves that take something away, confirmed first with what they'd change (`addon.impact`). */
export type TakingAction = 'disable' | 'uninstall' | 'purge';

/**
 * Makes a move: the other add-ons the person agreed to move with it, and for deleting data the name they typed.
 * Resolves to a line to show under the typed name when that was what was wrong, else null (the page says the rest).
 */
export type MakeMove = (
  target: MoveTarget,
  action: LifecycleAction,
  include: readonly string[],
  confirmName?: string,
) => Promise<string | null>;

const sectionLabel = 'text-xs font-medium text-text-3';

/**
 * Before turning an add-on off, uninstalling it or deleting its data: the move's question and what it does (the words
 * the web and the phone share), then what `addon.impact` says it would change — every other add-on that has to stop
 * with it, asked about once (the owner's decision: offer to turn off both, never silently), what stops working,
 * which add-ons do less without it, and what it holds here. Deleting data is for owners, and asks for its name.
 */
export function ConfirmMoveDialog({
  workspaceId,
  target,
  busy,
  onClose,
  onMove,
}: {
  workspaceId: string;
  target: (MoveTarget & { readonly action: TakingAction }) | null;
  busy: boolean;
  onClose: () => void;
  onMove: MakeMove;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? null : onClose())}>
      {target ? (
        <ConfirmBody
          key={`${target.addonId}:${target.action}`}
          workspaceId={workspaceId}
          target={target}
          busy={busy}
          onClose={onClose}
          onMove={onMove}
        />
      ) : null}
    </Dialog>
  );
}

function ConfirmBody({
  workspaceId,
  target,
  busy,
  onClose,
  onMove,
}: {
  workspaceId: string;
  target: MoveTarget & { readonly action: TakingAction };
  busy: boolean;
  onClose: () => void;
  onMove: MakeMove;
}) {
  const { action, name } = target;
  const words = ADDON_MOVE_WORDS[action];
  const [impact, setImpact] = useState<AddonImpact | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const purge = action === 'purge';
  const typedRight = typed.trim().toLowerCase() === name.trim().toLowerCase();

  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/addon.impact', {
        body: { workspaceId, addonId: target.addonId, action },
      })
      .then((r) => {
        if (!cancelled) setImpact(unwrap(r));
      })
      .catch(() => {
        // The move itself checks again, and asks about any other add-on it would take with it.
        if (!cancelled) setFailed(W.impactFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, target.addonId, action]);

  const others = (impact?.needsAgreement ?? []).map(addonName);
  const settled = impact !== null || failed !== null;
  // What would stop working (none from an add-on that's already off: the server leaves those out).
  const stops = impact?.outcome === 'plan' ? impact.capabilitiesLost : [];
  const lessWithout =
    impact?.outcome === 'plan' ? addonOptionalLine(impact.optionalFor.map((o) => o.name)) : null;
  const holds = impact?.outcome === 'plan' ? addonHoldsLines(action, impact.holds) : [];
  const canGo = impact ? impact.outcome === 'plan' : failed !== null;

  async function go() {
    setNameError(null);
    if (purge && !typedRight) {
      setNameError(`${W.typeName(name)}.`);
      return;
    }
    const wrong = await onMove(target, action, impact?.needsAgreement ?? [], typed.trim());
    if (wrong) setNameError(wrong);
  }

  return (
    <DialogContent
      title={words.confirm?.(name) ?? `${words.button}?`}
      description={words.consequence ?? undefined}
      className="max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] overflow-y-auto"
    >
      <div className="mt-4 flex flex-col gap-4" data-testid="addon-confirm" data-action={action}>
        {!settled ? (
          <p className="text-[13px] text-text-3" role="status">
            {W.checking}
          </p>
        ) : null}
        {failed ? <p className="text-[13px] text-text-2">{failed}</p> : null}
        {impact?.outcome === 'already' ? (
          <p className="text-[13px] text-text-2" data-testid="addon-confirm-already">
            {W.already}
          </p>
        ) : null}
        {impact?.outcome === 'refused' && impact.refusal ? (
          <Callout data-testid="addon-confirm-refused">{impact.refusal.message}</Callout>
        ) : null}
        {impact?.question ? (
          <Callout data-testid="addon-confirm-question">{impact.question}</Callout>
        ) : null}
        {stops.length ? (
          <div>
            <h3 className={sectionLabel}>{W.whatStops}</h3>
            <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
              {stops.map((c) => (
                <li key={c.id}>{c.label}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {lessWithout ? <p className="text-[13px] text-text-2">{lessWithout}</p> : null}
        {holds.length ? (
          <div data-testid="addon-confirm-holds">
            <h3 className={sectionLabel}>{W.whatItHolds}</h3>
            {holds.map((line) => (
              <p key={line} className="mt-1 text-[13px] text-text-2">
                {line}
              </p>
            ))}
          </div>
        ) : null}
        {purge && canGo ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void go();
            }}
          >
            <Field label={W.typeName(name)} htmlFor="addon-purge-name" error={nameError}>
              <Input
                id="addon-purge-name"
                autoComplete="off"
                autoFocus
                placeholder={name}
                value={typed}
                invalid={!!nameError}
                aria-describedby={nameError ? 'addon-purge-name-error' : undefined}
                onChange={(e) => setTyped(e.target.value)}
                data-testid="addon-purge-name"
              />
            </Field>
          </form>
        ) : null}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {canGo ? 'Cancel' : 'Close'}
        </Button>
        {canGo ? (
          <Button
            variant={action === 'disable' ? 'primary' : 'danger'}
            loading={busy}
            disabled={purge && !typedRight}
            onClick={() => void go()}
            data-testid="addon-confirm-yes"
          >
            {others.length ? addonAgreeWords(action, others) : words.button}
          </Button>
        ) : null}
      </div>
    </DialogContent>
  );
}

/**
 * The question a move comes back with when it needs other add-ons moved too ("Rent Collection needs Property
 * Management. Turn it on too?", rules `addon_needs` and `addon_required_by`), and the yes that sends it again with
 * them (`include`).
 */
export function AskMoveDialog({
  ask,
  busy,
  onClose,
  onMove,
}: {
  ask:
    | (MoveTarget & {
        readonly action: LifecycleAction;
        readonly include: readonly string[];
        readonly message: string;
      })
    | null;
  busy: boolean;
  onClose: () => void;
  onMove: MakeMove;
}) {
  const words = ask ? ADDON_MOVE_WORDS[ask.action] : null;
  const others = ask ? ask.include.filter((id) => id !== ask.addonId).map(addonName) : [];
  return (
    <Dialog open={ask !== null} onOpenChange={(open) => (open ? null : onClose())}>
      {ask && words ? (
        <DialogContent
          title={words.confirm?.(ask.name) ?? `${words.button} ${ask.name}?`}
          description={ask.message}
        >
          <div className="mt-6 flex flex-wrap justify-end gap-2" data-testid="addon-ask">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={ask.action === 'uninstall' ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => void onMove(ask, ask.action, ask.include)}
              data-testid="addon-ask-yes"
            >
              {others.length ? addonAgreeWords(ask.action, others) : words.button}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
