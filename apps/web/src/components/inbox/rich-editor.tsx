'use client';
/**
 * Buttons, a card or a carousel to go with a text (RCS, 0101), as the composer builds them.
 *
 * **Nobody picks RCS or SMS.** What is built here goes as RCS to a phone that can show it, and as the same
 * words with the choices written out to one that can't — so the editor always shows that plain face too,
 * worked out by core exactly as the server will write it.
 */
import {
  RCS_LIMITS,
  RichInput,
  richSmsText,
  type RichButtonDraft,
  type RichInput as RichInputValue,
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

type ButtonType = RichButtonDraft['type'];

export interface DraftButton {
  readonly key: string;
  readonly type: ButtonType;
  readonly title: string;
  /** A link's address, or the number a call button rings. */
  readonly target: string;
}

export interface DraftCard {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly fileId: string | null;
  readonly preview: string | null;
  readonly buttons: readonly DraftButton[];
}

export interface RichDraft {
  readonly kind: RichInputValue['kind'];
  /** A card's title. */
  readonly title: string;
  /** Buttons under the words, or on the card. */
  readonly buttons: readonly DraftButton[];
  readonly cards: readonly DraftCard[];
}

const key = () => crypto.randomUUID();
const newButton = (type: ButtonType = 'reply'): DraftButton => ({
  key: key(),
  type,
  title: '',
  target: '',
});
const newCard = (): DraftCard => ({
  key: key(),
  title: '',
  body: '',
  fileId: null,
  preview: null,
  buttons: [newButton()],
});

export const emptyRichDraft = (): RichDraft => ({
  kind: 'buttons',
  title: '',
  buttons: [newButton()],
  cards: [newCard(), newCard()],
});

/** Buttons with anything typed in them, as message.send takes them. */
function buttonsOf(list: readonly DraftButton[]): unknown[] {
  return list
    .filter((b) => b.title.trim() || b.target.trim())
    .map((b) =>
      b.type === 'reply'
        ? { type: 'reply', title: b.title }
        : b.type === 'link'
          ? { type: 'link', title: b.title, url: b.target }
          : { type: 'call', title: b.title, phone: b.target },
    );
}

/** The draft as message.send takes it, or the first thing wrong with it in the words core uses. */
export function richInputOf(
  draft: RichDraft,
): { ok: true; value: RichInputValue } | { ok: false; error: string } {
  const raw =
    draft.kind === 'buttons'
      ? { kind: 'buttons', buttons: buttonsOf(draft.buttons) }
      : draft.kind === 'card'
        ? { kind: 'card', title: draft.title, buttons: buttonsOf(draft.buttons) }
        : {
            kind: 'carousel',
            cards: draft.cards.map((c) => ({
              ...(c.title.trim() ? { title: c.title } : {}),
              body: c.body,
              mediaFileId: c.fileId ?? '',
              buttons: buttonsOf(c.buttons),
            })),
          };
  const parsed = RichInput.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path[0] === 'cards' ? `Card ${Number(issue.path[1] ?? 0) + 1}: ` : '';
  return {
    ok: false,
    error:
      issue?.path.includes('mediaFileId') === true
        ? `${where}Add a picture.`
        : `${where}${issue?.message ?? 'Check the buttons.'}`,
  };
}

const NO_MEDIA = { bucket: '', objectPath: '', contentType: '', sizeBytes: 0, name: '' };

export type RichCheck =
  { ok: true; value: RichInputValue; plain: string | null } | { ok: false; error: string };

/**
 * The draft with the text it goes with: ready to send (and what a phone without RCS gets), or the first thing
 * wrong. The photo rules are message.send's own — a carousel's pictures ride on its cards, and buttons go with
 * one photo — checked here so the person hears about them before pressing Send.
 */
export function checkRich(draft: RichDraft, body: string, photos: number): RichCheck {
  const checked = richInputOf(draft);
  if (!checked.ok) return checked;
  const value = checked.value;
  if (value.kind === 'carousel' && photos > 0)
    return {
      ok: false,
      error: 'A carousel carries its pictures on its cards. Take the attached photo off.',
    };
  if (value.kind !== 'carousel' && photos > 1)
    return { ok: false, error: 'A message with buttons carries one photo.' };
  if (value.kind !== 'carousel' && photos === 1 && value.buttons.length > RCS_LIMITS.cardButtons)
    return {
      ok: false,
      error: `With a photo, a message holds ${RCS_LIMITS.cardButtons} buttons at most.`,
    };
  const plain = body.trim() ? plainFaceOf(body.trim(), value) : null;
  if (plain && plain.length > RCS_LIMITS.smsText)
    return {
      ok: false,
      error:
        'With the choices written out for phones without RCS, this is over 1,600 characters. Shorten the words or take a button off.',
    };
  return { ok: true, value, plain };
}

/** What a phone without RCS gets, before anything is sent: core's own words, as the server will write them. */
export function plainFaceOf(body: string, value: RichInputValue): string {
  const ids = (list: readonly RichButtonDraft[]) =>
    list.map((b, i) => ({ ...b, id: `preview.${i}` }));
  if (value.kind === 'carousel')
    return richSmsText(body, {
      kind: 'carousel',
      title: null,
      buttons: [],
      cards: value.cards.map((c) => ({
        title: c.title ?? null,
        body: c.body,
        media: NO_MEDIA,
        buttons: ids(c.buttons),
      })),
    });
  return richSmsText(body, {
    kind: value.kind,
    title: value.kind === 'card' ? value.title : null,
    buttons: ids(value.buttons),
    cards: [],
  });
}

const TYPE_LABEL: Record<ButtonType, string> = {
  reply: 'Reply',
  link: 'Link',
  call: 'Call',
};
const TARGET_PLACEHOLDER: Record<Exclude<ButtonType, 'reply'>, string> = {
  link: 'https://…',
  call: '(713) 555-0142',
};

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
              const type = e.target.value as ButtonType;
              set(b.key, {
                type,
                target: type === 'call' && !b.target ? (callNumber ?? '') : b.target,
              });
            }}
            className="w-[88px] flex-none"
            data-testid="rich-button-type"
          >
            {(Object.keys(TYPE_LABEL) as ButtonType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
          <Input
            inputSize="sm"
            aria-label={`${label} ${i + 1}: name`}
            placeholder={
              b.type === 'reply' ? 'Confirm' : b.type === 'link' ? 'Book online' : 'Call us'
            }
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
              placeholder={TARGET_PLACEHOLDER[b.type]}
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
          onClick={() => onChange([...buttons, newButton()])}
          data-testid="rich-add-button"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Add a button
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
            {uploading ? 'Adding…' : 'Add a picture'}
          </span>
        )}
      </button>
      <label htmlFor={titleId} className="sr-only">
        Card {index + 1}: title
      </label>
      <Input
        id={titleId}
        inputSize="sm"
        placeholder="Title (optional)"
        maxLength={RCS_LIMITS.carouselCardTitle}
        value={card.title}
        onChange={(e) => onChange({ ...card, title: e.target.value })}
      />
      <Input
        inputSize="sm"
        aria-label={`Card ${index + 1}: words`}
        placeholder="A few words"
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
          Remove card
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
  const maxButtons =
    draft.kind === 'card' || photos > 0 ? RCS_LIMITS.cardButtons : RCS_LIMITS.chips;
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
          ariaLabel="What goes with the text"
          options={[
            { value: 'buttons', label: 'Buttons', testId: 'rich-kind-buttons' },
            { value: 'card', label: 'Card', testId: 'rich-kind-card' },
            {
              value: 'carousel',
              label: 'Carousel',
              testId: 'rich-kind-carousel',
              disabled: !personId,
              title: personId ? undefined : 'Link this conversation to a customer to add pictures.',
            },
          ]}
        />
        <Button variant="ghost" size="icon" aria-label="Take the buttons off" onClick={onClose}>
          <X className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>
      {draft.kind === 'card' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={titleId} className="text-xs font-medium text-text-2">
            Card title
          </label>
          <Input
            id={titleId}
            inputSize="sm"
            placeholder="Spring tune-up: $89"
            maxLength={RCS_LIMITS.cardTitle}
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            data-testid="rich-card-title"
          />
          <span className="text-xs text-text-3">
            The text below becomes the card’s words; a photo you attach goes on top.
          </span>
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
              onClick={() => onChange({ ...draft, cards: [...draft.cards, newCard()] })}
              className="flex w-[120px] flex-none flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-border-strong text-xs font-medium text-accent-text"
              data-testid="rich-add-card"
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              Add a card
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
              'Goes as RCS where the customer’s phone can show it. Other phones get it as a text with the choices listed:'
            ) : (
              <>
                RCS isn’t on for this business, so this goes as a text with the choices listed.{' '}
                <Link
                  href={`/app/w/${workspaceId}/settings/texting#rcs`}
                  className="font-medium text-accent-text hover:underline"
                >
                  Set up RCS
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
              <span className="text-text-3">Write the message to see it.</span>
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
