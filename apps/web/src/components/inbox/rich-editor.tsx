'use client';
/**
 * Buttons, a card or a carousel to go with a text (RCS, 0103): the web's editor. The draft, its checks, the plain
 * face and the words are core's (`packages/core/src/inbox/rich-draft.ts`), shared with the phone's editor.
 */
import {
  checkRich,
  emptyRichDraft,
  newDraftButton,
  newDraftCard,
  RCS_LIMITS,
  RICH_WORDS,
  richButtonLimit,
  type DraftButton,
  type DraftCard,
  type RichButtonType,
  type RichDraft,
} from '@hfos/core';
import { ImagePlus, Info, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadFile } from '@/components/files/upload-zone';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { errorMessage } from '@/lib/api/client';

/** The keys the web's editor tells its rows apart by. */
const webKey = () => crypto.randomUUID();

/** A fresh draft for the composer: one empty button, and two empty cards should it become a carousel. */
export const newRichDraft = (): RichDraft => emptyRichDraft(webKey);

function ButtonsField({
  buttons,
  max,
  onChange,
  callNumber,
  label,
  testId,
}: {
  buttons: readonly DraftButton[];
  max: number;
  onChange: (next: readonly DraftButton[]) => void;
  /** The business's own number, where a new call button starts. */
  callNumber: string | null;
  label: string;
  testId: string;
}) {
  const set = (k: string, patch: Partial<DraftButton>) =>
    onChange(buttons.map((b) => (b.key === k ? { ...b, ...patch } : b)));
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {buttons.map((b, i) => (
        <div key={b.key} className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
          <Select
            selectSize="sm"
            aria-label={`${label} ${i + 1}: kind`}
            value={b.type}
            onChange={(e) => {
              const type = e.target.value as RichButtonType;
              set(b.key, {
                type,
                target: type === 'call' && !b.target ? (callNumber ?? '') : b.target,
              });
            }}
            className="w-[88px] flex-none"
            data-testid="rich-button-type"
          >
            {(Object.keys(RICH_WORDS.buttonKind) as RichButtonType[]).map((t) => (
              <option key={t} value={t}>
                {RICH_WORDS.buttonKind[t]}
              </option>
            ))}
          </Select>
          <Input
            inputSize="sm"
            aria-label={`${label} ${i + 1}: name`}
            placeholder={RICH_WORDS.buttonTitle[b.type]}
            maxLength={RCS_LIMITS.buttonTitle}
            value={b.title}
            onChange={(e) => set(b.key, { title: e.target.value })}
            className="min-w-[120px] flex-1"
            data-testid="rich-button-title"
          />
          {b.type !== 'reply' ? (
            <Input
              inputSize="sm"
              aria-label={`${label} ${i + 1}: ${b.type === 'link' ? 'web address' : 'number'}`}
              placeholder={RICH_WORDS.buttonTarget[b.type]}
              value={b.target}
              onChange={(e) => set(b.key, { target: e.target.value })}
              className="min-w-[140px] flex-[1.4]"
              data-testid="rich-button-target"
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
            onClick={() => onChange(buttons.filter((x) => x.key !== b.key))}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
      ))}
      {buttons.length < max ? (
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-accent-text hover:underline"
          onClick={() => onChange([...buttons, newDraftButton(webKey)])}
          data-testid="rich-add-button"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          {RICH_WORDS.addButton}
        </button>
      ) : null}
    </div>
  );
}

function CardField({
  card,
  index,
  workspaceId,
  personId,
  callNumber,
  onChange,
  onRemove,
}: {
  card: DraftCard;
  index: number;
  workspaceId: string;
  personId: string | null;
  callNumber: string | null;
  onChange: (next: DraftCard) => void;
  onRemove: (() => void) | null;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const titleId = useId();
  async function pick(file: File | undefined) {
    if (!file || !personId) return;
    setUploading(true);
    try {
      const fileId = await uploadFile(workspaceId, 'person', personId, file);
      onChange({ ...card, fileId, preview: URL.createObjectURL(file) });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }
  return (
    <div
      className="flex w-[232px] flex-none flex-col gap-1.5 rounded-[12px] border border-border bg-card p-2"
      data-testid="rich-card-editor"
    >
      <input
        ref={picker}
        type="file"
        accept="image/jpeg,image/png,image/gif"
        className="sr-only"
        aria-label={`Card ${index + 1}: picture`}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => picker.current?.click()}
        disabled={uploading || !personId}
        className="flex h-[92px] items-center justify-center overflow-hidden rounded-[8px] border border-dashed border-border-strong bg-card-2 text-xs text-text-3 disabled:opacity-50"
        data-testid="rich-card-picture"
      >
        {card.preview ? (
          // A local preview of a picture about to be sent.
          <img src={card.preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="inline-flex items-center gap-1">
            <ImagePlus className="h-4 w-4" strokeWidth={1.5} />
            {uploading ? RICH_WORDS.addingPicture : RICH_WORDS.addPicture}
          </span>
        )}
      </button>
      <label htmlFor={titleId} className="sr-only">
        Card {index + 1}: title
      </label>
      <Input
        id={titleId}
        inputSize="sm"
        placeholder={RICH_WORDS.cardTitleOptional}
        maxLength={RCS_LIMITS.carouselCardTitle}
        value={card.title}
        onChange={(e) => onChange({ ...card, title: e.target.value })}
      />
      <Input
        inputSize="sm"
        aria-label={`Card ${index + 1}: words`}
        placeholder={RICH_WORDS.cardWords}
        maxLength={RCS_LIMITS.carouselCardText}
        value={card.body}
        onChange={(e) => onChange({ ...card, body: e.target.value })}
        data-testid="rich-card-body"
      />
      <ButtonsField
        buttons={card.buttons}
        max={RCS_LIMITS.carouselCardButtons.max}
        onChange={(buttons) => onChange({ ...card, buttons })}
        callNumber={callNumber}
        label={`Card ${index + 1} button`}
        testId="rich-card-buttons"
      />
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex w-fit items-center gap-1 text-xs text-text-3 hover:text-danger-text"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          {RICH_WORDS.removeCard}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The editor above the composer's box. `body` is the text being written: it is the card's words, or what sits
 * above the buttons or the carousel. `photos` counts the photos attached: a message with one holds four buttons.
 */
export function RichEditor({
  draft,
  onChange,
  onClose,
  body,
  photos,
  rcs,
  workspaceId,
  personId,
  callNumber,
}: {
  draft: RichDraft;
  onChange: (next: RichDraft) => void;
  onClose: () => void;
  body: string;
  photos: number;
  /** Whether texts go RCS first for this business right now. */
  rcs: boolean;
  workspaceId: string;
  personId: string | null;
  callNumber: string | null;
}) {
  const checked = checkRich(draft, body, photos);
  const maxButtons = richButtonLimit(draft, photos);
  const titleId = useId();
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[12px] border border-border bg-card-2/60 p-2.5"
      data-testid="rich-editor"
    >
      <div className="flex items-center justify-between gap-2">
        <Segmented
          value={draft.kind}
          onChange={(kind) => onChange({ ...draft, kind })}
          ariaLabel={RICH_WORDS.whatGoes}
          options={[
            { value: 'buttons', label: RICH_WORDS.kind.buttons, testId: 'rich-kind-buttons' },
            { value: 'card', label: RICH_WORDS.kind.card, testId: 'rich-kind-card' },
            {
              value: 'carousel',
              label: RICH_WORDS.kind.carousel,
              testId: 'rich-kind-carousel',
              disabled: !personId,
              title: personId ? undefined : RICH_WORDS.carouselNeedsCustomer,
            },
          ]}
        />
        <Button variant="ghost" size="icon" aria-label={RICH_WORDS.takeOff} onClick={onClose}>
          <X className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>
      {draft.kind === 'card' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={titleId} className="text-xs font-medium text-text-2">
            {RICH_WORDS.cardTitle}
          </label>
          <Input
            id={titleId}
            inputSize="sm"
            placeholder={RICH_WORDS.cardTitlePlaceholder}
            maxLength={RCS_LIMITS.cardTitle}
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            data-testid="rich-card-title"
          />
          <span className="text-xs text-text-3">{RICH_WORDS.cardNote}</span>
        </div>
      ) : null}
      {draft.kind === 'carousel' ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {draft.cards.map((c, i) => (
            <CardField
              key={c.key}
              card={c}
              index={i}
              workspaceId={workspaceId}
              personId={personId}
              callNumber={callNumber}
              onChange={(next) =>
                onChange({ ...draft, cards: draft.cards.map((x) => (x.key === c.key ? next : x)) })
              }
              onRemove={
                draft.cards.length > RCS_LIMITS.carouselCards.min
                  ? () => onChange({ ...draft, cards: draft.cards.filter((x) => x.key !== c.key) })
                  : null
              }
            />
          ))}
          {draft.cards.length < RCS_LIMITS.carouselCards.max ? (
            <button
              type="button"
              onClick={() => onChange({ ...draft, cards: [...draft.cards, newDraftCard(webKey)] })}
              className="flex w-[120px] flex-none flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-border-strong text-xs font-medium text-accent-text"
              data-testid="rich-add-card"
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              {RICH_WORDS.addCard}
            </button>
          ) : null}
        </div>
      ) : (
        <ButtonsField
          buttons={draft.buttons}
          max={maxButtons}
          onChange={(buttons) => onChange({ ...draft, buttons })}
          callNumber={callNumber}
          label="Button"
          testId="rich-buttons-editor"
        />
      )}
      <div className="flex items-start gap-1.5 text-xs text-text-2" data-testid="rich-note">
        <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <div className="flex min-w-0 flex-col gap-1">
          <span>
            {rcs ? (
              RICH_WORDS.rcsOn
            ) : (
              <>
                {RICH_WORDS.rcsOff}{' '}
                <Link
                  href={`/app/w/${workspaceId}/settings/texting#rcs`}
                  className="font-medium text-accent-text hover:underline"
                >
                  {RICH_WORDS.setUpRcs}
                </Link>
              </>
            )}
          </span>
          {checked.ok ? (
            checked.plain ? (
              <span
                className="whitespace-pre-wrap rounded-[8px] bg-card px-2.5 py-1.5 text-text-2 [overflow-wrap:anywhere]"
                data-testid="rich-plain-face"
              >
                {checked.plain}
              </span>
            ) : (
              <span className="text-text-3">{RICH_WORDS.writeToSee}</span>
            )
          ) : (
            <span className="text-danger-text" data-testid="rich-problem">
              {checked.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
