'use client';
import {
  MAIN_OFFER_WORDS as W,
  partWords,
  type MainOfferParts,
  type OfferAssistPath,
  type OfferBox,
} from '@hfos/core';
import { Sparkles, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { assistOffer, offerAiError } from '@/lib/main-offer/actions';

/** A chip that fills a box with an example to start from. */
function Example({ text, onPick }: { text: string; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="inline-flex h-[30px] max-w-full items-center truncate rounded-full border border-dashed border-border-strong px-3 text-[13px] text-text-2 transition-colors hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      <span className="truncate">{text}</span>
    </button>
  );
}

/** The AI's three, to pick one from, or put away. */
export function AiChoices({
  testId,
  onClose,
  children,
}: {
  testId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Card className="mt-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-[13px] font-semibold">{W.pickOne}</span>
        <span className="flex items-center gap-2">
          <span className="hidden text-xs text-text-3 sm:inline">{W.fromAi}</span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Put the AI’s options away"
            onClick={onClose}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </span>
      </div>
      {children}
    </Card>
  );
}

/** One of the AI's options: its words and Use this. */
export function AiChoice({
  children,
  label = W.useThis,
  onUse,
  testId,
}: {
  children: ReactNode;
  label?: string;
  onUse: () => void;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
      <div className="min-w-0 flex-1 text-[13.5px]">{children}</div>
      <Button size="sm" variant="secondary" onClick={onUse} data-testid={testId}>
        {label}
      </Button>
    </div>
  );
}

/** The AI's button for a box: Improve what's written, or Write it for me when it's empty. */
export function AiButton({
  improve,
  busy,
  onClick,
  testId,
}: {
  improve: boolean;
  busy: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button size="sm" variant="ghost" loading={busy} onClick={onClick} data-testid={testId}>
      <Sparkles className="h-4 w-4 text-accent-text" strokeWidth={1.5} />
      {improve ? W.improve : W.writeIt}
    </Button>
  );
}

/**
 * One box of the offer (docs/main-offer.md): its question, the box, examples to model for the business's line of
 * work, and the AI's Improve or Write it for me, three to pick from. Nothing the AI writes is used until it's picked.
 */
export function OfferBoxField({
  workspaceId,
  box,
  parts,
  examples,
  onChange,
}: {
  workspaceId: string;
  box: OfferBox;
  parts: MainOfferParts;
  examples?: readonly string[];
  onChange: (words: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<string[] | null>(null);
  const words = partWords(parts, box.path);
  const id = `offer-${box.path.replace('.', '-')}`;
  // The niche finder's own boxes have no AI of their own: Find my niche reads them all.
  const aiPath = box.path.startsWith('niche.') ? null : (box.path as OfferAssistPath);

  async function ask() {
    if (!aiPath) return;
    setBusy(true);
    try {
      const out = await assistOffer(workspaceId, aiPath, words.trim() ? 'improve' : 'write', parts);
      if (!out.options.length) toast.error('The AI had nothing better this time. Try again.');
      else setOptions(out.options);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(false);
    }
  }

  const Box = box.long ? Textarea : Input;
  return (
    <div data-testid={`${id}-box`}>
      <Field label={box.label} htmlFor={id} hint={box.hint}>
        <Box
          id={id}
          value={words}
          placeholder={box.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={box.long ? 'min-h-[72px]' : undefined}
        />
      </Field>
      {aiPath || examples?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {aiPath ? (
            <AiButton
              improve={!!words.trim()}
              busy={busy}
              onClick={() => void ask()}
              testId={`${id}-ai`}
            />
          ) : null}
          {examples?.length ? (
            <>
              <span className="text-xs text-text-3">{W.examples}</span>
              {examples.slice(0, 2).map((ex) => (
                <Example key={ex} text={ex} onPick={() => onChange(ex)} />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {options ? (
        <AiChoices testId={`${id}-options`} onClose={() => setOptions(null)}>
          {options.map((o, i) => (
            <AiChoice
              key={o}
              testId={`${id}-use-${i}`}
              onUse={() => {
                onChange(o);
                setOptions(null);
              }}
            >
              {o}
            </AiChoice>
          ))}
        </AiChoices>
      ) : null}
    </div>
  );
}
