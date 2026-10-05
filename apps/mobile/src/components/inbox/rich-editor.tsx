/**
 * Buttons, a card or a carousel to go with a text (RCS, 0103): the phone's editor, over the composer's box as on the
 * web. The draft, its checks, the plain face and the words are core's (`packages/core/src/inbox/rich-draft.ts`),
 * shared with the web's editor. A carousel's pictures are taken like a reply's photos and kept on the phone until the
 * text goes, so the whole of it can be written with no signal.
 */
import {
  emptyRichDraft,
  newDraftButton,
  newDraftCard,
  PHOTO_CHOICE_WORDS,
  RCS_LIMITS,
  RICH_WORDS,
  richButtonLimit,
  type DraftButton,
  type DraftCard,
  type RichButtonType,
  type RichCheck,
  type RichDraft,
} from '@hfos/core';
import * as Crypto from 'expo-crypto';
import * as React from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';

import { Camera, Image as ImageIcon, ImagePlus, Info, Plus, Trash, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

/** The keys the phone's editor tells its rows apart by. */
const phoneKey = () => Crypto.randomUUID();

/** A fresh draft for the composer: one empty button, and two empty cards should it become a carousel. */
export const newRichDraft = (): RichDraft => emptyRichDraft(phoneKey);

const BUTTON_KINDS: readonly RichButtonType[] = ['reply', 'link', 'call'];

function ButtonsField({
  buttons,
  max,
  onChange,
  callNumber,
  label,
  testID,
}: {
  buttons: readonly DraftButton[];
  max: number;
  onChange: (next: readonly DraftButton[]) => void;
  /** The business's own number, where a new call button starts. */
  callNumber: string | null;
  label: string;
  testID: string;
}) {
  const set = (key: string, patch: Partial<DraftButton>) =>
    onChange(buttons.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  return (
    <View className="gap-2" testID={testID}>
      {buttons.map((b, i) => (
        <View
          key={b.key}
          className="gap-2 rounded-[12px] border border-border bg-card p-2.5"
          testID="rich-button-editor"
        >
          <View className="flex-row items-center gap-2">
            <Segmented
              value={b.type}
              onChange={(type) =>
                set(b.key, {
                  type,
                  target: type === 'call' && !b.target ? (callNumber ?? '') : b.target,
                })
              }
              options={BUTTON_KINDS.map((t) => ({
                value: t,
                label: RICH_WORDS.buttonKind[t],
                testID: `rich-button-${t}`,
              }))}
              label={`${label} ${i + 1}: kind`}
              className="flex-1"
            />
            <Pressable
              role="button"
              accessibilityLabel={`Remove ${label.toLowerCase()} ${i + 1}`}
              onPress={() => onChange(buttons.filter((x) => x.key !== b.key))}
              hitSlop={8}
              className="size-9 items-center justify-center rounded-full active:bg-card-2"
              testID="rich-button-remove"
            >
              <Icon as={X} className="size-4 text-text-2" />
            </Pressable>
          </View>
          <Input
            value={b.title}
            onChangeText={(title) => set(b.key, { title })}
            placeholder={RICH_WORDS.buttonTitle[b.type]}
            maxLength={RCS_LIMITS.buttonTitle}
            accessibilityLabel={`${label} ${i + 1}: name`}
            testID="rich-button-title"
          />
          {b.type !== 'reply' ? (
            <Input
              value={b.target}
              onChangeText={(target) => set(b.key, { target })}
              placeholder={RICH_WORDS.buttonTarget[b.type]}
              keyboardType={b.type === 'call' ? 'phone-pad' : 'url'}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={`${label} ${i + 1}: ${b.type === 'link' ? 'web address' : 'number'}`}
              testID="rich-button-target"
            />
          ) : null}
        </View>
      ))}
      {buttons.length < max ? (
        <Pressable
          role="button"
          onPress={() => onChange([...buttons, newDraftButton(phoneKey)])}
          hitSlop={6}
          className="min-h-9 flex-row items-center gap-1 self-start"
          testID="rich-add-button"
        >
          <Icon as={Plus} className="size-4 text-accent-text" strokeWidth={2} />
          <Text className="text-[13px] font-medium text-accent-text">{RICH_WORDS.addButton}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One card of a carousel: its picture (taken like a reply's photo), a title, a few words and a button or two. */
function CardField({
  card,
  index,
  callNumber,
  photoUri,
  onChange,
  onPicture,
  onRemove,
}: {
  card: DraftCard;
  index: number;
  callNumber: string | null;
  /** Where a picture kept on the phone is, from its file name. */
  photoUri: (localName: string) => string | undefined;
  onChange: (next: DraftCard) => void;
  onPicture: () => void;
  onRemove: (() => void) | null;
}) {
  return (
    <View
      className="w-[252px] gap-2 rounded-[12px] border border-border bg-card p-2.5"
      testID="rich-card-editor"
    >
      <Pressable
        role="button"
        accessibilityLabel={`Card ${index + 1}: picture`}
        onPress={onPicture}
        className="h-[110px] items-center justify-center overflow-hidden rounded-[8px] border border-dashed border-border-strong bg-card-2"
        testID="rich-card-picture"
      >
        {card.preview ? (
          <Image
            source={{ uri: photoUri(card.preview) }}
            accessibilityIgnoresInvertColors
            className="size-full"
            resizeMode="cover"
            testID="rich-card-photo"
          />
        ) : (
          <View className="flex-row items-center gap-1">
            <Icon as={ImagePlus} className="size-4 text-text-3" strokeWidth={1.5} />
            <Text className="text-xs text-text-3">{RICH_WORDS.addPicture}</Text>
          </View>
        )}
      </Pressable>
      <Input
        value={card.title}
        onChangeText={(title) => onChange({ ...card, title })}
        placeholder={RICH_WORDS.cardTitleOptional}
        maxLength={RCS_LIMITS.carouselCardTitle}
        accessibilityLabel={`Card ${index + 1}: title`}
      />
      <Input
        value={card.body}
        onChangeText={(body) => onChange({ ...card, body })}
        placeholder={RICH_WORDS.cardWords}
        maxLength={RCS_LIMITS.carouselCardText}
        accessibilityLabel={`Card ${index + 1}: words`}
        testID="rich-card-body"
      />
      <ButtonsField
        buttons={card.buttons}
        max={RCS_LIMITS.carouselCardButtons.max}
        onChange={(buttons) => onChange({ ...card, buttons })}
        callNumber={callNumber}
        label={`Card ${index + 1} button`}
        testID="rich-card-buttons"
      />
      {onRemove ? (
        <Pressable
          role="button"
          onPress={onRemove}
          hitSlop={6}
          className="min-h-8 flex-row items-center gap-1 self-start"
          testID="rich-remove-card"
        >
          <Icon as={Trash} className="size-3.5 text-text-3" strokeWidth={1.75} />
          <Text className="text-xs text-text-3">{RICH_WORDS.removeCard}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The editor over the composer's box. The text being written is the card's words, or what sits above the buttons or
 * the carousel; `check` is core's `checkRich` of the draft with that text and the photos attached (a message with one
 * holds four buttons). Whether RCS is on for the business isn't on the phone, so the note says what's true either way.
 */
export function RichEditor({
  draft,
  onChange,
  onClose,
  check,
  photos,
  canCarousel,
  callNumber,
  photoUri,
  onCardPhoto,
}: {
  draft: RichDraft;
  onChange: (next: RichDraft) => void;
  onClose: () => void;
  check: RichCheck;
  photos: number;
  /** A carousel's pictures go to the customer's files, so it needs a customer. */
  canCarousel: boolean;
  callNumber: string | null;
  photoUri: (localName: string) => string | undefined;
  /** Takes a card's picture; the screen keeps it until the text goes and sets the card's file. */
  onCardPhoto: (cardKey: string, source: 'camera' | 'library') => void;
}) {
  const [pictureFor, setPictureFor] = React.useState<string | null>(null);
  const take = (source: 'camera' | 'library') => {
    const key = pictureFor;
    setPictureFor(null);
    // The picker opens once the sheet has gone: an iPhone won't show it over a closing sheet.
    if (key) setTimeout(() => onCardPhoto(key, source), 450);
  };
  return (
    <View className="rounded-[12px] border border-border bg-card-2 p-2.5" testID="rich-editor">
      <ScrollView
        className="max-h-[300px]"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        contentContainerClassName="gap-2.5"
      >
        <View className="flex-row items-center gap-2">
          <Segmented
            value={draft.kind}
            onChange={(kind) => onChange({ ...draft, kind })}
            label={RICH_WORDS.whatGoes}
            className="flex-1"
            options={[
              { value: 'buttons', label: RICH_WORDS.kind.buttons, testID: 'rich-kind-buttons' },
              { value: 'card', label: RICH_WORDS.kind.card, testID: 'rich-kind-card' },
              {
                value: 'carousel',
                label: RICH_WORDS.kind.carousel,
                testID: 'rich-kind-carousel',
                disabled: !canCarousel,
              },
            ]}
          />
          <Pressable
            role="button"
            accessibilityLabel={RICH_WORDS.takeOff}
            onPress={onClose}
            hitSlop={8}
            className="size-9 items-center justify-center rounded-full active:bg-card"
            testID="rich-close"
          >
            <Icon as={X} className="size-4 text-text-2" />
          </Pressable>
        </View>
        {!canCarousel ? (
          <Text className="text-xs text-text-3">{RICH_WORDS.carouselNeedsCustomer}</Text>
        ) : null}
        {draft.kind === 'card' ? (
          <View className="gap-1">
            <Text className="text-xs font-medium text-text-2">{RICH_WORDS.cardTitle}</Text>
            <Input
              value={draft.title}
              onChangeText={(title) => onChange({ ...draft, title })}
              placeholder={RICH_WORDS.cardTitlePlaceholder}
              maxLength={RCS_LIMITS.cardTitle}
              accessibilityLabel={RICH_WORDS.cardTitle}
              testID="rich-card-title"
            />
            <Text className="text-xs text-text-3">{RICH_WORDS.cardNote}</Text>
          </View>
        ) : null}
        {draft.kind === 'carousel' ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-2"
          >
            {draft.cards.map((c, i) => (
              <CardField
                key={c.key}
                card={c}
                index={i}
                callNumber={callNumber}
                photoUri={photoUri}
                onChange={(next) =>
                  onChange({
                    ...draft,
                    cards: draft.cards.map((x) => (x.key === c.key ? next : x)),
                  })
                }
                onPicture={() => setPictureFor(c.key)}
                onRemove={
                  draft.cards.length > RCS_LIMITS.carouselCards.min
                    ? () =>
                        onChange({ ...draft, cards: draft.cards.filter((x) => x.key !== c.key) })
                    : null
                }
              />
            ))}
            {draft.cards.length < RCS_LIMITS.carouselCards.max ? (
              <Pressable
                role="button"
                onPress={() =>
                  onChange({ ...draft, cards: [...draft.cards, newDraftCard(phoneKey)] })
                }
                className="w-[120px] items-center justify-center gap-1 rounded-[12px] border border-dashed border-border-strong"
                testID="rich-add-card"
              >
                <Icon as={Plus} className="size-4 text-accent-text" strokeWidth={2} />
                <Text className="text-[13px] font-medium text-accent-text">
                  {RICH_WORDS.addCard}
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        ) : (
          <ButtonsField
            buttons={draft.buttons}
            max={richButtonLimit(draft, photos)}
            onChange={(buttons) => onChange({ ...draft, buttons })}
            callNumber={callNumber}
            label="Button"
            testID="rich-buttons-editor"
          />
        )}
        <View className="flex-row items-start gap-1.5" testID="rich-note">
          <Icon as={Info} className="mt-0.5 size-3.5 text-text-2" strokeWidth={1.75} />
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-xs leading-[17px] text-text-2">{RICH_WORDS.rcsMaybe}</Text>
            {check.ok ? (
              check.plain ? (
                <View className="rounded-[8px] bg-card px-2.5 py-1.5">
                  <Text className="text-xs leading-[17px] text-text-2" testID="rich-plain-face">
                    {check.plain}
                  </Text>
                </View>
              ) : (
                <Text className="text-xs text-text-3">{RICH_WORDS.writeToSee}</Text>
              )
            ) : (
              <Text className="text-xs text-danger-text" testID="rich-problem">
                {check.error}
              </Text>
            )}
          </View>
        </View>
      </ScrollView>
      <Sheet
        open={pictureFor !== null}
        onClose={() => setPictureFor(null)}
        title={PHOTO_CHOICE_WORDS.title}
        testID="card-photo-choice"
      >
        <View className="mt-3 gap-2">
          <Button
            variant="secondary"
            icon={Camera}
            onPress={() => take('camera')}
            testID="card-photo-camera"
          >
            {PHOTO_CHOICE_WORDS.camera}
          </Button>
          <Button
            variant="secondary"
            icon={ImageIcon}
            onPress={() => take('library')}
            testID="card-photo-library"
          >
            {PHOTO_CHOICE_WORDS.library}
          </Button>
        </View>
      </Sheet>
    </View>
  );
}
